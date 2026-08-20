const crypto = require('crypto');
const {encrypt, decrypt} = require('./encrypt-decrypt');

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const generateCapabilityToken = () =>
  crypto.randomBytes(32).toString('base64url');

const storeCapabilityToken = (token) => ({
  capability_token_hash: hashToken(token),
  capability_token_encrypted: encrypt(token),
});

const revealCapabilityToken = (encrypted) => {
  if (!encrypted) return null;
  try {
    const token = decrypt(encrypted);
    if (!token || token === '{}') return null;
    return token;
  } catch {
    return null;
  }
};

const buildCapabilityUrl = (token) => {
  const base = (process.env.PUBLIC_API_BASE_URL || process.env.JAMBONES_API_BASE_URL || '')
    .replace(/\/$/, '');
  if (!base) return `/v1/public/BlfAvailability/${token}`;
  // JAMBONES_API_BASE_URL often includes /v1
  if (base.endsWith('/v1')) return `${base}/public/BlfAvailability/${token}`;
  return `${base}/v1/public/BlfAvailability/${token}`;
};

module.exports = {
  hashToken,
  generateCapabilityToken,
  storeCapabilityToken,
  revealCapabilityToken,
  buildCapabilityUrl,
};
