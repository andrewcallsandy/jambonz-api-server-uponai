const Webhook = require('../models/webhook');

/**
 * Fire availability_hook for a BLF state change. Best-effort; never throws to caller.
 */
async function fireBlfWebhook(logger, {
  availability_hook_sid,
  payload,
  webhook_secret,
}) {
  if (!availability_hook_sid) return;

  try {
    const rows = await Webhook.retrieve(availability_hook_sid);
    if (!rows.length) {
      logger.info({availability_hook_sid}, 'BLF webhook sid not found');
      return;
    }
    const hook = rows[0];
    if (!hook.url) return;

    const method = (hook.method || 'POST').toUpperCase();
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'jambonz-blf/1.0',
    };
    if (webhook_secret) {
      headers['X-Jambonz-Signature'] = webhook_secret;
    }
    if (hook.username && hook.password) {
      const token = Buffer.from(`${hook.username}:${hook.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }

    const init = {method, headers};
    if (method !== 'GET') {
      init.body = JSON.stringify(payload);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(hook.url, {...init, signal: controller.signal});
      if (!res.ok) {
        logger.info({status: res.status, url: hook.url}, 'BLF webhook non-2xx');
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.info({err: err.message}, 'BLF webhook delivery failed');
  }
}

module.exports = {fireBlfWebhook};
