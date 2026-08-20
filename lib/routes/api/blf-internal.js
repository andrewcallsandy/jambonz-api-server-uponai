const router = require('express').Router();
const crypto = require('crypto');
const {v4: uuidv4} = require('uuid');
const CIDRMatcher = require('cidr-matcher');
const sysError = require('../error');
const {promisePool} = require('../../db');
const BlfConfiguration = require('../../models/blf-configuration');
const BlfMonitor = require('../../models/blf-monitor');
const {parseNotifyBody, parseSubscriptionState} = require('../../utils/blf-parse');
const {fireBlfWebhook} = require('../../utils/blf-webhook');

const MAX_BODY = parseInt(process.env.JAMBONES_BLF_MAX_BODY_BYTES || '65536', 10);

/** MySQL DATETIME-safe timestamp (no ISO T/Z). */
const toMysqlDatetime = (value) => {
  if (value === null || value === undefined) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

const requireInternalToken = (req, res, next) => {
  const expected = process.env.JAMBONES_INTERNAL_TOKEN;
  if (!expected || expected.length < 16) {
    return res.status(503).json({message: 'internal BLF API not configured'});
  }
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.get('X-Internal-Token') || '');
  if (!token || token !== expected) {
    return res.status(401).json({message: 'unauthorized'});
  }
  next();
};

router.use(requireInternalToken);

const ipAllowedForCarrier = async(voip_carrier_sid, source_ip) => {
  if (!source_ip) return false;
  const [gateways] = await promisePool.query(
    `SELECT ipv4, netmask FROM sip_gateways
     WHERE voip_carrier_sid = ? AND inbound = 1 AND is_active = 1`,
    [voip_carrier_sid]
  );
  if (!gateways.length) {
    // reg trunks often rely on ephemeral gateways; allow if no static inbound gw
    // and source looks like an IP (sidecar may have already filtered)
    return true;
  }
  for (const gw of gateways) {
    const mask = gw.netmask === null || gw.netmask === undefined ? 32 : gw.netmask;
    try {
      const matcher = new CIDRMatcher([`${gw.ipv4}/${mask}`]);
      if (matcher.contains(source_ip)) return true;
    } catch {
      if (gw.ipv4 === source_ip) return true;
    }
  }
  return false;
};

/* list configs + monitors for sidecar reconcile */
router.get('/reconcile', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const configs = await BlfConfiguration.retrieveEnabledForReconcile();
    const out = [];
    for (const cfg of configs) {
      let register_status = {};
      try {
        register_status = JSON.parse(cfg.register_status || '{}');
      } catch {
        register_status = {};
      }
      const monitors = await BlfMonitor.retrieveByConfigurationSid(cfg.blf_configuration_sid);
      out.push({
        blf_configuration_sid: cfg.blf_configuration_sid,
        account_sid: cfg.account_sid,
        voip_carrier_sid: cfg.voip_carrier_sid,
        event_package: cfg.event_package,
        subscribe_expires: cfg.subscribe_expires,
        stale_seconds: cfg.stale_seconds,
        carrier: {
          name: cfg.carrier_name,
          register_username: cfg.register_username,
          register_password: cfg.register_password,
          register_sip_realm: cfg.register_sip_realm,
          register_from_user: cfg.register_from_user,
          register_from_domain: cfg.register_from_domain,
          register_public_ip_in_contact: cfg.register_public_ip_in_contact,
          outbound_sip_proxy: cfg.outbound_sip_proxy,
          register_status,
          trunk_type: cfg.trunk_type,
          is_active: cfg.is_active,
          requires_register: cfg.requires_register,
        },
        monitors,
      });
    }
    res.status(200).json({configs: out});
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* upsert subscription dialog fields after SUBSCRIBE */
router.post('/subscription', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const {
      blf_monitor_sid,
      owner_node,
      sub_call_id,
      sub_local_tag,
      sub_remote_tag,
      sub_remote_target,
      sub_route_set,
      sub_cseq,
      sub_expires_at,
      sub_status,
      last_error,
    } = req.body || {};

    if (!blf_monitor_sid) return res.status(400).json({message: 'blf_monitor_sid required'});
    const rows = await BlfMonitor.retrieve(blf_monitor_sid);
    if (!rows.length) return res.sendStatus(404);

    const update = {};
    if (owner_node !== undefined) update.owner_node = owner_node;
    if (sub_call_id !== undefined) update.sub_call_id = sub_call_id;
    if (sub_local_tag !== undefined) update.sub_local_tag = sub_local_tag;
    if (sub_remote_tag !== undefined) update.sub_remote_tag = sub_remote_tag;
    if (sub_remote_target !== undefined) update.sub_remote_target = sub_remote_target;
    if (sub_route_set !== undefined) update.sub_route_set = sub_route_set;
    if (sub_cseq !== undefined) update.sub_cseq = sub_cseq;
    if (sub_expires_at !== undefined) update.sub_expires_at = toMysqlDatetime(sub_expires_at);
    if (sub_status !== undefined) update.sub_status = sub_status;
    if (last_error !== undefined) update.last_error = last_error;

    if (Object.keys(update).length) {
      await BlfMonitor.update(blf_monitor_sid, update);
    }

    // touch config owner / reconcile time
    const monitor = rows[0];
    await promisePool.query(
      `UPDATE blf_configurations
       SET owner_node = COALESCE(?, owner_node), last_reconcile_at = NOW(), last_error = NULL
       WHERE blf_configuration_sid = ?`,
      [owner_node || null, monitor.blf_configuration_sid]
    );

    res.status(200).json({ok: true});
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* mark config-level error */
router.post('/config-error', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const {blf_configuration_sid, last_error, owner_node} = req.body || {};
    if (!blf_configuration_sid) return res.status(400).json({message: 'blf_configuration_sid required'});
    await promisePool.query(
      `UPDATE blf_configurations
       SET last_error = ?, owner_node = COALESCE(?, owner_node), last_reconcile_at = NOW()
       WHERE blf_configuration_sid = ?`,
      [last_error || null, owner_node || null, blf_configuration_sid]
    );
    res.status(200).json({ok: true});
  } catch (err) {
    sysError(logger, res, err);
  }
});

/* NOTIFY ingest */
router.post('/notify', async(req, res) => {
  const logger = req.app.locals.logger;
  try {
    const {
      contact_user,
      source_ip,
      call_id,
      cseq,
      event,
      subscription_state,
      content_type,
      body,
      owner_node,
    } = req.body || {};

    if (!contact_user) return res.status(400).json({message: 'contact_user required'});

    const monitors = await BlfMonitor.retrieveByContactUser(contact_user);
    if (!monitors.length) return res.status(404).json({message: 'unknown contact_user'});
    const monitor = monitors[0];

    const configs = await BlfConfiguration.retrieve(monitor.blf_configuration_sid);
    if (!configs.length) return res.status(404).json({message: 'config missing'});
    const cfg = configs[0];

    const allowed = await ipAllowedForCarrier(cfg.voip_carrier_sid, source_ip);
    if (!allowed) {
      logger.info({contact_user, source_ip}, 'BLF NOTIFY rejected: source IP not allowlisted');
      return res.status(403).json({message: 'source not allowed', accepted: false});
    }

    if (monitor.sub_call_id && call_id && monitor.sub_call_id !== call_id) {
      logger.info({contact_user, call_id}, 'BLF NOTIFY rejected: Call-ID mismatch');
      return res.status(403).json({message: 'call-id mismatch', accepted: false});
    }

    if (cfg.event_package && event) {
      const ev = String(event).split(';')[0].trim().toLowerCase();
      if (ev && ev !== cfg.event_package) {
        return res.status(403).json({message: 'event package mismatch', accepted: false});
      }
    }

    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    if (Buffer.byteLength(bodyStr, 'utf8') > MAX_BODY) {
      return res.status(413).json({message: 'body too large'});
    }

    const digest = crypto.createHash('sha256')
      .update(`${call_id || ''}|${cseq || ''}|${bodyStr}`)
      .digest('hex');

    const staleSeconds = cfg.stale_seconds || 120;
    const staleAt = new Date(Date.now() + staleSeconds * 1000);
    let isDuplicate = false;

    try {
      await promisePool.query(
        `INSERT INTO blf_notify_events
         (blf_notify_event_sid, blf_monitor_sid, event_digest, source_ip, event_package,
          subscription_state, parsed_state, body_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          monitor.blf_monitor_sid,
          digest,
          source_ip || null,
          event || null,
          subscription_state || null,
          null,
          Buffer.byteLength(bodyStr, 'utf8'),
        ]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        // Retransmit / same digest — still refresh freshness so UI does not go stale
        isDuplicate = true;
      } else {
        throw err;
      }
    }

    const subState = parseSubscriptionState(subscription_state);
    let parsed = {state: monitor.state, state_raw: monitor.state_raw};
    if (isDuplicate) {
      // Keep prior parsed state; only heartbeat timestamps below
      parsed = {state: monitor.state, state_raw: monitor.state_raw};
    } else if (bodyStr) {
      parsed = parseNotifyBody(content_type, bodyStr);
    } else if (subState === 'terminated') {
      // Subscription ended with empty body — keep last known lamp state
      parsed = {state: monitor.state || 'unknown', state_raw: 'subscription-terminated'};
    }

    const previous_state = monitor.state;
    let nextSubStatus = monitor.sub_status;
    if (subState === 'terminated') {
      nextSubStatus = 'terminated';
    } else if (subState === 'active' || monitor.sub_status === 'trying' || monitor.sub_status === 'pending') {
      nextSubStatus = 'active';
    }

    await BlfMonitor.update(monitor.blf_monitor_sid, {
      state: parsed.state,
      state_raw: parsed.state_raw,
      subscription_state: subState,
      last_notify_at: toMysqlDatetime(new Date()),
      stale_at: toMysqlDatetime(staleAt),
      sub_status: nextSubStatus,
      owner_node: owner_node || monitor.owner_node,
      last_error: null,
    });

    if (isDuplicate) {
      return res.status(200).json({
        accepted: true,
        duplicate: true,
        state: parsed.state,
        stale_at: staleAt.toISOString(),
      });
    }

    await promisePool.query(
      'UPDATE blf_notify_events SET parsed_state = ? WHERE blf_monitor_sid = ? AND event_digest = ?',
      [parsed.state, monitor.blf_monitor_sid, digest]
    );

    if (previous_state !== parsed.state) {
      const eventPayload = {
        type: 'blf:status',
        account_sid: cfg.account_sid,
        voip_carrier_sid: cfg.voip_carrier_sid,
        blf_configuration_sid: cfg.blf_configuration_sid,
        blf_monitor_sid: monitor.blf_monitor_sid,
        extension: monitor.extension,
        presentity_uri: monitor.presentity_uri,
        state: parsed.state,
        previous_state,
        available: parsed.state === 'idle' && subState !== 'terminated',
        subscription_state: subState,
        observed_at: new Date().toISOString(),
        stale_at: staleAt.toISOString(),
      };

      const [accounts] = await promisePool.query(
        'SELECT webhook_secret FROM accounts WHERE account_sid = ?',
        [cfg.account_sid]
      );
      await fireBlfWebhook(logger, {
        availability_hook_sid: cfg.availability_hook_sid,
        webhook_secret: accounts[0]?.webhook_secret,
        payload: eventPayload,
      });

      // Websocket fan-out (cluster-safe via redis)
      try {
        const {getHub} = require('../../utils/blf-ws-hub');
        const hub = getHub(logger, req.app.locals.client);
        await hub.start();
        await hub.publish(eventPayload);
      } catch (err) {
        logger.info({err: err.message}, 'BLF WS publish skipped');
      }
    }

    logger.info({
      contact_user,
      source_ip,
      event,
      subscription_state: subState,
      state: parsed.state,
    }, 'BLF NOTIFY persisted');

    res.status(200).json({accepted: true, duplicate: false, state: parsed.state});
  } catch (err) {
    sysError(logger, res, err);
  }
});

module.exports = router;
