const {URL} = require('url');
const {promisePool} = require('../db');
const {hashToken} = require('./blf-tokens');
const BlfConfiguration = require('../models/blf-configuration');

const CHANNEL = 'jambonz:blf:events';

/**
 * Cluster-safe BLF websocket hub.
 * Publish via Redis; each API worker fans out to local sockets.
 */
class BlfWsHub {
  constructor(logger, redisClient) {
    this.logger = logger;
    this.redisClient = redisClient;
    this.sockets = new Set();
    this.publisher = redisClient;
    this.subscriber = null;
    this.ready = false;
  }

  async start() {
    if (this.ready) return;
    if (!this.redisClient || typeof this.redisClient.duplicate !== 'function') {
      this.logger.info('BLF WS hub running without redis pub/sub (local fanout only)');
      this.ready = true;
      return;
    }
    this.subscriber = this.redisClient.duplicate();
    this.subscriber.on('message', (channel, message) => {
      if (channel !== CHANNEL) return;
      try {
        const payload = JSON.parse(message);
        this._fanoutLocal(payload);
      } catch (err) {
        this.logger.info({err: err.message}, 'BLF WS bad redis message');
      }
    });
    await this.subscriber.subscribe(CHANNEL);
    this.ready = true;
    this.logger.info('BLF websocket hub subscribed to redis channel');
  }

  async publish(payload) {
    if (!this.publisher || typeof this.publisher.publish !== 'function') {
      this._fanoutLocal(payload);
      return;
    }
    try {
      await this.publisher.publish(CHANNEL, JSON.stringify(payload));
    } catch (err) {
      this.logger.info({err: err.message}, 'BLF WS publish failed; local fanout only');
      this._fanoutLocal(payload);
    }
  }

  _fanoutLocal(payload) {
    const data = JSON.stringify(payload);
    for (const entry of this.sockets) {
      if (entry.ws.readyState !== 1) continue;
      if (entry.account_sid && entry.account_sid !== payload.account_sid) continue;
      if (entry.blf_configuration_sid &&
          entry.blf_configuration_sid !== payload.blf_configuration_sid) continue;
      try {
        entry.ws.send(data);
      } catch (err) {
        this.logger.info({err: err.message}, 'BLF WS send failed');
      }
    }
  }

  addSocket(ws, meta) {
    const entry = {ws, ...meta};
    this.sockets.add(entry);
    ws.on('close', () => this.sockets.delete(entry));
    ws.on('error', () => this.sockets.delete(entry));
    try {
      ws.send(JSON.stringify({
        type: 'blf:connected',
        account_sid: meta.account_sid,
        blf_configuration_sid: meta.blf_configuration_sid || null,
        observed_at: new Date().toISOString(),
      }));
    } catch {
      // ignore
    }
  }
}

let hub;

const getHub = (logger, redisClient) => {
  if (!hub) hub = new BlfWsHub(logger, redisClient);
  return hub;
};

const extractBearer = (req) => {
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get('token') || u.searchParams.get('access_token');
  } catch {
    return null;
  }
};

const lookupApiKey = async(token) => {
  const [rows] = await promisePool.query(
    'SELECT account_sid, service_provider_sid FROM api_keys WHERE token = ? LIMIT 1',
    [token]
  );
  return rows[0] || null;
};

/**
 * Authenticate and attach a BLF websocket.
 * Paths:
 *   /v1/Accounts/:account_sid/BlfStream[?token=&blf_configuration_sid=]
 *   /v1/public/BlfAvailability/:capability_token/ws
 * @returns {Promise<boolean>} true if handled, false if not a BLF path
 */
async function handleBlfUpgrade(logger, request, socket, head, wss, redisClient) {
  let pathname;
  let searchParams;
  try {
    const u = new URL(request.url, 'http://localhost');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch {
    return false;
  }

  const publicMatch = pathname.match(/^\/v1\/public\/BlfAvailability\/([^/]+)\/ws\/?$/);
  const accountMatch = pathname.match(/^\/v1\/Accounts\/([^/]+)\/BlfStream\/?$/);
  if (!publicMatch && !accountMatch) return false;

  const hubInst = getHub(logger, redisClient);
  await hubInst.start();

  let meta = null;

  if (publicMatch) {
    const capabilityToken = decodeURIComponent(publicMatch[1]);
    const rows = await BlfConfiguration.retrieveByTokenHash(hashToken(capabilityToken));
    if (!rows.length || !rows[0].is_enabled) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }
    meta = {
      account_sid: rows[0].account_sid,
      blf_configuration_sid: rows[0].blf_configuration_sid,
      capability: true,
    };
  } else {
    const account_sid = accountMatch[1];
    const token = extractBearer(request);
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }
    const key = await lookupApiKey(token);
    if (!key) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }
    const isAdmin = key.account_sid === null && key.service_provider_sid === null;
    if (!isAdmin && key.account_sid !== account_sid) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    meta = {
      account_sid,
      blf_configuration_sid: searchParams.get('blf_configuration_sid') || null,
      capability: false,
    };
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info({meta, url: request.url}, 'BLF websocket upgraded');
    hubInst.addSocket(ws, meta);
  });
  return true;
}

module.exports = {
  getHub,
  handleBlfUpgrade,
  CHANNEL,
};
