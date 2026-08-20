const {isAvailable, isStale} = require('./blf-parse');

const toExtensionResult = (monitor, now = Date.now()) => {
  const available = isAvailable(monitor, now);
  const stale = isStale(monitor, now);
  return {
    extension: monitor.extension,
    display_name: monitor.display_name,
    presentity_uri: monitor.presentity_uri,
    state: monitor.state,
    available,
    stale,
    last_notify_at: monitor.last_notify_at,
    stale_at: monitor.stale_at,
    subscription_status: monitor.sub_status,
  };
};

const buildAvailabilityResponse = (config, monitors, filterExtensions = null) => {
  const now = Date.now();
  let list = monitors;
  if (filterExtensions && filterExtensions.length) {
    const wanted = new Set(filterExtensions.map((e) => String(e)));
    list = monitors.filter((m) => wanted.has(String(m.extension)));
  }

  const extensions = list.map((m) => toExtensionResult(m, now));
  const available = extensions.filter((e) => e.available).map((e) => e.extension);
  const unavailable = extensions.filter((e) => !e.available).map((e) => e.extension);
  const unknown = extensions.filter((e) => e.state === 'unknown' || e.stale).length;

  return {
    blf_configuration_sid: config.blf_configuration_sid,
    observed_at: new Date(now).toISOString(),
    extensions,
    available,
    unavailable,
    counts: {
      total: extensions.length,
      available: available.length,
      unavailable: unavailable.length,
      unknown,
      stale: extensions.filter((e) => e.stale).length,
    },
    any_available: available.length > 0,
    all_available: extensions.length > 0 && available.length === extensions.length,
  };
};

const parseExtensionQuery = (req) => {
  const out = [];
  if (req.query?.extension) out.push(String(req.query.extension));
  if (req.query?.extensions) {
    String(req.query.extensions).split(',').map((s) => s.trim()).filter(Boolean).forEach((e) => out.push(e));
  }
  const body = req.body || {};
  if (body.extension) out.push(String(body.extension));
  if (Array.isArray(body.extensions)) {
    body.extensions.forEach((e) => out.push(String(e)));
  }
  if (body.args?.extension) out.push(String(body.args.extension));
  if (Array.isArray(body.args?.extensions)) {
    body.args.extensions.forEach((e) => out.push(String(e)));
  }
  return [...new Set(out)].slice(0, 50);
};

module.exports = {
  toExtensionResult,
  buildAvailabilityResponse,
  parseExtensionQuery,
};
