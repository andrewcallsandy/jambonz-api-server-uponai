/**
 * Normalize dialog-info / PIDF NOTIFY bodies into BLF states.
 * States: unknown | idle | ringing | busy | held | unavailable
 */

const parseSubscriptionState = (header) => {
  if (!header || typeof header !== 'string') return null;
  const primary = header.split(';')[0].trim().toLowerCase();
  return primary || null;
};

const normalizeDialogState = (dialogState, localElement) => {
  const state = (dialogState || '').toLowerCase();
  if (!state || state === 'terminated') return 'idle';
  if (state === 'early') return 'ringing';
  if (state === 'confirmed') {
    // Some PBXs nest <local><identity> with held rendering; look for held hints
    if (localElement && /held|on-hold/i.test(localElement)) return 'held';
    return 'busy';
  }
  if (state === 'trying') return 'ringing';
  return 'unknown';
};

const parseDialogInfo = (body) => {
  if (!body || typeof body !== 'string') {
    return {state: 'unknown', state_raw: null};
  }

  // No dialog elements => idle (empty dialog-info)
  const dialogRegex = /<dialog\b[^>]*>([\s\S]*?)<\/dialog>/gi;
  const dialogs = [];
  let match;
  while ((match = dialogRegex.exec(body)) !== null) {
    dialogs.push(match[0]);
  }

  if (dialogs.length === 0) {
    // state= attribute on dialog-info entity with no children often means idle
    return {state: 'idle', state_raw: 'no-dialog'};
  }

  let best = 'idle';
  let raw = null;
  const rank = {idle: 0, unavailable: 1, ringing: 2, held: 3, busy: 4, unknown: 5};

  for (const dialogXml of dialogs) {
    const stateMatch = /<state[^>]*>([^<]+)<\/state>/i.exec(dialogXml);
    const dialogState = stateMatch ? stateMatch[1].trim() : null;
    const localMatch = /<local[\s\S]*?<\/local>/i.exec(dialogXml);
    const normalized = normalizeDialogState(dialogState, localMatch ? localMatch[0] : '');
    raw = dialogState || raw;
    if ((rank[normalized] ?? 0) >= (rank[best] ?? 0)) {
      best = normalized;
    }
  }

  return {state: best, state_raw: raw};
};

const parsePidf = (body) => {
  if (!body || typeof body !== 'string') {
    return {state: 'unknown', state_raw: null};
  }

  const basicMatch = /<basic[^>]*>([^<]+)<\/basic>/i.exec(body);
  const basic = basicMatch ? basicMatch[1].trim().toLowerCase() : null;
  const activities = [];
  const actRegex = /<(on-the-phone|busy|away|holiday|appointment|meal|meeting|steering|travel|vacation|appointment)[\s/>]/gi;
  let m;
  while ((m = actRegex.exec(body)) !== null) {
    activities.push(m[1].toLowerCase());
  }

  if (activities.includes('on-the-phone') || activities.includes('busy')) {
    return {state: 'busy', state_raw: activities.join(',') || basic};
  }
  if (basic === 'closed' || activities.includes('away')) {
    return {state: 'unavailable', state_raw: activities.join(',') || basic};
  }
  if (basic === 'open') {
    return {state: 'idle', state_raw: basic};
  }
  return {state: 'unknown', state_raw: basic};
};

const parseNotifyBody = (contentType, body) => {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('dialog-info') || /<dialog-info[\s>]/i.test(body || '')) {
    return parseDialogInfo(body);
  }
  if (ct.includes('pidf') || /<presence[\s>]/i.test(body || '')) {
    return parsePidf(body);
  }
  // Try dialog-info first, then pidf
  if (/<dialog-info[\s>]/i.test(body || '')) return parseDialogInfo(body);
  if (/<presence[\s>]/i.test(body || '')) return parsePidf(body);
  return {state: 'unknown', state_raw: null};
};

/** Parse MySQL DATETIME / ISO strings as UTC when timezone suffix is absent. */
const toEpochMs = (value) => {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return NaN;
  const s = String(value).trim();
  if (!s) return NaN;
  // mysql2 often returns "YYYY-MM-DD HH:mm:ss" (UTC wall on this host)
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    return Date.parse(s.replace(' ', 'T') + 'Z');
  }
  return Date.parse(s);
};

const isAvailable = (monitor, now = Date.now()) => {
  if (!monitor || !monitor.is_enabled) return false;
  if (monitor.sub_status !== 'active') return false;
  if (monitor.state !== 'idle') return false;
  if (!monitor.stale_at) return false;
  const staleAt = toEpochMs(monitor.stale_at);
  if (Number.isNaN(staleAt) || now >= staleAt) return false;
  return true;
};

const isStale = (monitor, now = Date.now()) => {
  if (!monitor) return true;
  if (monitor.state === 'unknown') return true;
  if (!monitor.stale_at) return true;
  const staleAt = toEpochMs(monitor.stale_at);
  return Number.isNaN(staleAt) || now >= staleAt;
};

module.exports = {
  parseSubscriptionState,
  parseDialogInfo,
  parsePidf,
  parseNotifyBody,
  isAvailable,
  isStale,
};
