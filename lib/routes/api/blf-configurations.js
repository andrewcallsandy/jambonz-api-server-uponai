const router = require('express').Router({mergeParams: true});
const {v4: uuidv4} = require('uuid');
const sysError = require('../error');
const {DbErrorBadRequest, DbErrorForbidden} = require('../../utils/errors');
const {promisePool} = require('../../db');
const BlfConfiguration = require('../../models/blf-configuration');
const BlfMonitor = require('../../models/blf-monitor');
const Webhook = require('../../models/webhook');
const VoipCarrier = require('../../models/voip-carrier');
const {
  generateCapabilityToken,
  storeCapabilityToken,
  revealCapabilityToken,
  buildCapabilityUrl,
} = require('../../utils/blf-tokens');
const {buildAvailabilityResponse, parseExtensionQuery} = require('../../utils/blf-availability');

const assertAccountAccess = async(req, account_sid) => {
  if (req.user.hasScope('admin')) return;
  if (req.user.hasScope('account')) {
    if (account_sid !== req.user.account_sid) throw new DbErrorForbidden('insufficient permissions');
    return;
  }
  if (req.user.hasScope('service_provider')) {
    const [r] = await promisePool.execute(
      'SELECT service_provider_sid FROM accounts WHERE account_sid = ?',
      [account_sid]
    );
    if (r.length === 1 && r[0].service_provider_sid === req.user.service_provider_sid) return;
    throw new DbErrorForbidden('insufficient permissions');
  }
  throw new DbErrorForbidden('insufficient permissions');
};

const loadConfigForAccount = async(account_sid, blf_configuration_sid) => {
  const rows = await BlfConfiguration.retrieve(blf_configuration_sid);
  if (!rows.length || rows[0].account_sid !== account_sid) return null;
  return rows[0];
};

const serializeConfig = async(cfg, {includeToken = false} = {}) => {
  const counts = await BlfMonitor.countByState(cfg.blf_configuration_sid);
  let availability_hook = null;
  if (cfg.availability_hook_sid) {
    const hooks = await Webhook.retrieve(cfg.availability_hook_sid);
    if (hooks.length) {
      availability_hook = {
        webhook_sid: hooks[0].webhook_sid,
        url: hooks[0].url,
        method: hooks[0].method,
      };
    }
  }

  const out = {
    blf_configuration_sid: cfg.blf_configuration_sid,
    account_sid: cfg.account_sid,
    voip_carrier_sid: cfg.voip_carrier_sid,
    is_enabled: !!cfg.is_enabled,
    event_package: cfg.event_package,
    subscribe_expires: cfg.subscribe_expires,
    stale_seconds: cfg.stale_seconds,
    owner_node: cfg.owner_node,
    last_reconcile_at: cfg.last_reconcile_at,
    last_error: cfg.last_error,
    availability_hook,
    monitors: {
      total: Number(counts.total || 0),
      active_subscriptions: Number(counts.active_subscriptions || 0),
      idle: Number(counts.idle || 0),
      busy: Number(counts.busy || 0),
      unknown: Number(counts.unknown_count || 0),
    },
    created_at: cfg.created_at,
    updated_at: cfg.updated_at,
  };

  if (includeToken) {
    const token = revealCapabilityToken(cfg.capability_token_encrypted);
    out.capability_url = token ? buildCapabilityUrl(token) : null;
  }

  return out;
};

const upsertHook = async(availability_hook) => {
  if (!availability_hook) return null;
  if (typeof availability_hook === 'string') return availability_hook; // existing sid
  if (!availability_hook.url) throw new DbErrorBadRequest('availability_hook.url is required');
  const sid = await Webhook.make({
    url: availability_hook.url,
    method: availability_hook.method || 'POST',
    username: availability_hook.username || null,
    password: availability_hook.password || null,
  });
  return sid;
};

const validateCarrier = async(account_sid, voip_carrier_sid) => {
  const carriers = await VoipCarrier.retrieve(voip_carrier_sid);
  if (!carriers.length) throw new DbErrorBadRequest('voip_carrier_sid not found');
  const c = carriers[0];
  if (c.account_sid && c.account_sid !== account_sid) {
    throw new DbErrorForbidden('carrier does not belong to this account');
  }
  // Need an outbound REGISTER identity; trunk_type may be reg or auth+requires_register
  if (!c.requires_register) {
    throw new DbErrorBadRequest('BLF requires a carrier with requires_register enabled');
  }
  if (!['reg', 'auth'].includes(c.trunk_type)) {
    throw new DbErrorBadRequest('BLF Phase 1 requires a registration-capable trunk (reg or auth)');
  }
  return c;
};

const normalizePresentity = (uri) => {
  if (!uri || typeof uri !== 'string') throw new DbErrorBadRequest('presentity_uri is required');
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('sip:') && !trimmed.toLowerCase().startsWith('sips:')) {
    throw new DbErrorBadRequest('presentity_uri must be a sip: or sips: URI');
  }
  return trimmed;
};

/* list */
router.get('/', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const rows = await BlfConfiguration.retrieveByAccountSid(account_sid);
    const out = [];
    for (const cfg of rows) out.push(await serializeConfig(cfg, {includeToken: true}));
    res.status(200).json(out);
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* create or upsert-by-carrier (idempotent for UponAI / Retell installers) */
router.post('/', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const {
      voip_carrier_sid, is_enabled, event_package,
      subscribe_expires, stale_seconds, availability_hook,
    } = req.body || {};
    if (!voip_carrier_sid) throw new DbErrorBadRequest('voip_carrier_sid is required');
    await validateCarrier(account_sid, voip_carrier_sid);

    if (event_package && !['dialog', 'presence'].includes(event_package)) {
      throw new DbErrorBadRequest('event_package must be dialog or presence');
    }

    const existing = await BlfConfiguration.retrieveByCarrierSid(voip_carrier_sid);
    if (existing.length) {
      const cfg = existing[0];
      if (cfg.account_sid !== account_sid) {
        throw new DbErrorForbidden('BLF configuration for this carrier belongs to another account');
      }

      const update = {};
      if (is_enabled !== undefined) update.is_enabled = is_enabled ? 1 : 0;
      if (event_package !== undefined) update.event_package = event_package;
      if (subscribe_expires !== undefined) update.subscribe_expires = subscribe_expires;
      if (stale_seconds !== undefined) update.stale_seconds = stale_seconds;
      if (availability_hook !== undefined) {
        update.availability_hook_sid = await upsertHook(availability_hook);
      }
      if (Object.keys(update).length) {
        await BlfConfiguration.update(cfg.blf_configuration_sid, update);
      }

      const fresh = (await BlfConfiguration.retrieve(cfg.blf_configuration_sid))[0];
      const serialized = await serializeConfig(fresh, {includeToken: true});
      serialized.created = false;
      serialized.upserted = true;
      // do not mint a new capability_token on upsert — would break existing Retell URLs
      return res.status(200).json(serialized);
    }

    const token = generateCapabilityToken();
    const tokenFields = storeCapabilityToken(token);
    const hookSid = await upsertHook(availability_hook);

    const blf_configuration_sid = await BlfConfiguration.make({
      account_sid,
      voip_carrier_sid,
      is_enabled: is_enabled === undefined ? 1 : (is_enabled ? 1 : 0),
      event_package: event_package || 'dialog',
      subscribe_expires: subscribe_expires || 3600,
      stale_seconds: stale_seconds || 120,
      availability_hook_sid: hookSid,
      ...tokenFields,
    });

    const cfg = (await BlfConfiguration.retrieve(blf_configuration_sid))[0];
    const serialized = await serializeConfig(cfg, {includeToken: true});
    serialized.capability_token = token; // returned once on create
    serialized.created = true;
    serialized.upserted = false;
    res.status(201).json(serialized);
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* retrieve */
router.get('/:blf_configuration_sid', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);
    res.status(200).json(await serializeConfig(cfg, {includeToken: true}));
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* update */
router.put('/:blf_configuration_sid', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);

    const body = req.body || {};
    const update = {};
    if (body.is_enabled !== undefined) update.is_enabled = body.is_enabled ? 1 : 0;
    if (body.event_package !== undefined) {
      if (!['dialog', 'presence'].includes(body.event_package)) {
        throw new DbErrorBadRequest('event_package must be dialog or presence');
      }
      update.event_package = body.event_package;
    }
    if (body.subscribe_expires !== undefined) update.subscribe_expires = body.subscribe_expires;
    if (body.stale_seconds !== undefined) update.stale_seconds = body.stale_seconds;
    if (body.availability_hook !== undefined) {
      update.availability_hook_sid = await upsertHook(body.availability_hook);
    }

    if (Object.keys(update).length) {
      await BlfConfiguration.update(cfg.blf_configuration_sid, update);
    }
    const fresh = (await BlfConfiguration.retrieve(cfg.blf_configuration_sid))[0];
    res.status(200).json(await serializeConfig(fresh, {includeToken: true}));
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* delete */
router.delete('/:blf_configuration_sid', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);
    await BlfConfiguration.remove(cfg.blf_configuration_sid);
    res.sendStatus(204);
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* rotate token */
router.post('/:blf_configuration_sid/rotateToken', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);

    const token = generateCapabilityToken();
    await BlfConfiguration.update(cfg.blf_configuration_sid, storeCapabilityToken(token));
    res.status(200).json({
      capability_token: token,
      capability_url: buildCapabilityUrl(token),
    });
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* monitors list */
router.get('/:blf_configuration_sid/Monitors', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);
    const monitors = await BlfMonitor.retrieveByConfigurationSid(cfg.blf_configuration_sid);
    res.status(200).json(monitors);
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* monitor create */
router.post('/:blf_configuration_sid/Monitors', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);

    const {extension, display_name, presentity_uri, is_enabled} = req.body || {};
    if (!extension) throw new DbErrorBadRequest('extension is required');
    const uri = normalizePresentity(presentity_uri);
    const contact_user = `blf-${uuidv4().replace(/-/g, '')}`;

    const blf_monitor_sid = await BlfMonitor.make({
      blf_configuration_sid: cfg.blf_configuration_sid,
      extension: String(extension),
      display_name: display_name || null,
      presentity_uri: uri,
      is_enabled: is_enabled === undefined ? 1 : (is_enabled ? 1 : 0),
      contact_user,
      sub_status: 'none',
      state: 'unknown',
    });

    const row = (await BlfMonitor.retrieve(blf_monitor_sid))[0];
    res.status(201).json(row);
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* monitor update */
router.put('/:blf_configuration_sid/Monitors/:blf_monitor_sid', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);

    const rows = await BlfMonitor.retrieve(req.params.blf_monitor_sid);
    if (!rows.length || rows[0].blf_configuration_sid !== cfg.blf_configuration_sid) {
      return res.sendStatus(404);
    }

    const body = req.body || {};
    const update = {};
    if (body.extension !== undefined) update.extension = String(body.extension);
    if (body.display_name !== undefined) update.display_name = body.display_name;
    if (body.presentity_uri !== undefined) update.presentity_uri = normalizePresentity(body.presentity_uri);
    if (body.is_enabled !== undefined) update.is_enabled = body.is_enabled ? 1 : 0;

    if (Object.keys(update).length) {
      await BlfMonitor.update(req.params.blf_monitor_sid, update);
    }
    res.status(200).json((await BlfMonitor.retrieve(req.params.blf_monitor_sid))[0]);
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* monitor delete */
router.delete('/:blf_configuration_sid/Monitors/:blf_monitor_sid', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);
    const rows = await BlfMonitor.retrieve(req.params.blf_monitor_sid);
    if (!rows.length || rows[0].blf_configuration_sid !== cfg.blf_configuration_sid) {
      return res.sendStatus(404);
    }
    await BlfMonitor.remove(req.params.blf_monitor_sid);
    res.sendStatus(204);
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* CSV-ish import: JSON array upsert by presentity_uri */
router.post('/:blf_configuration_sid/Monitors/import', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);

    const rows = Array.isArray(req.body) ? req.body : req.body?.monitors;
    if (!Array.isArray(rows) || !rows.length) {
      throw new DbErrorBadRequest('body must be an array of monitors');
    }

    const existing = await BlfMonitor.retrieveByConfigurationSid(cfg.blf_configuration_sid);
    const byUri = new Map(existing.map((m) => [m.presentity_uri, m]));
    let created = 0;
    let updated = 0;

    for (const row of rows) {
      const uri = normalizePresentity(row.presentity_uri);
      const extension = String(row.extension || '');
      if (!extension) throw new DbErrorBadRequest('each row requires extension');
      const found = byUri.get(uri);
      if (found) {
        await BlfMonitor.update(found.blf_monitor_sid, {
          extension,
          display_name: row.display_name || null,
          is_enabled: row.is_enabled === undefined ? 1 : (row.is_enabled ? 1 : 0),
        });
        updated++;
      } else {
        await BlfMonitor.make({
          blf_configuration_sid: cfg.blf_configuration_sid,
          extension,
          display_name: row.display_name || null,
          presentity_uri: uri,
          is_enabled: row.is_enabled === undefined ? 1 : (row.is_enabled ? 1 : 0),
          contact_user: `blf-${uuidv4().replace(/-/g, '')}`,
          sub_status: 'none',
          state: 'unknown',
        });
        created++;
      }
    }

    const monitors = await BlfMonitor.retrieveByConfigurationSid(cfg.blf_configuration_sid);
    res.status(200).json({created, updated, monitors});
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* authenticated availability poll */
router.get('/:blf_configuration_sid/Availability', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const account_sid = req.params.sid;
    await assertAccountAccess(req, account_sid);
    const cfg = await loadConfigForAccount(account_sid, req.params.blf_configuration_sid);
    if (!cfg) return res.sendStatus(404);
    const monitors = await BlfMonitor.retrieveByConfigurationSid(cfg.blf_configuration_sid);
    const filter = parseExtensionQuery(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json(buildAvailabilityResponse(cfg, monitors, filter.length ? filter : null));
  } catch (err) {
    sysError(logger, res, err);
  }
});

module.exports = router;
