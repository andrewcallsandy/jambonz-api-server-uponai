if (!process.env.JAMBONES_HOSTING) return;

const crypto = require('crypto');
const assert = require('assert');
const { v4: uuid } = require('uuid');
const {promisePool} = require('../db');
const domains = new Map();
const debug = require('debug')('jambonz:api-server');

const checkAsserts = () => {
  assert.ok(process.env.DME_API_KEY, 'missing env DME_API_KEY for dns operations');
  assert.ok(process.env.DME_API_SECRET, 'missing env DME_API_SECRET for dns operations');
  assert.ok(process.env.DME_BASE_URL, 'missing env DME_BASE_URL for dns operations');
};

const createAuthHeaders = () => {
  const now = (new Date()).toUTCString();
  const hash = crypto.createHmac('SHA1', process.env.DME_API_SECRET);
  hash.update(now);
  return {
    'x-dnsme-apiKey': process.env.DME_API_KEY,
    'x-dnsme-requestDate': now,
    'x-dnsme-hmac': hash.digest('hex')
  };
};

const getDnsDomainId = async(logger, name) => {
  checkAsserts();
  const headers = createAuthHeaders();
  const response = await fetch(`${process.env.DME_BASE_URL}/dns/managed`, {
    method: 'GET',
    headers
  });
  if (!response.ok) {
    logger.error({response}, 'Error retrieving domains');
    return;
  }
  const result = await response.json();
  debug(result, 'getDnsDomainId: all domains');
  if (Array.isArray(result.data)) {
    const domain = result.data.find((o) => o.name === name);
    if (domain) return domain.id;
    debug(`getDnsDomainId: failed to find domain ${name}`);
  }
};

/**
 * Add the DNS records for a given subdomain
 * We will add an A record and an SRV record for each SBC public IP address
 * Note: this assumes we have manually added DNS A records:
 *    sbc01.root.domain, sbc0.root.domain, etc to dnsmadeeasy
 */
const createDnsRecords = async(logger, domain, name, value, ttl = 3600) => {
  checkAsserts();
  try {
    if (!domains.has(domain)) {
      const domainId = await getDnsDomainId(logger, domain);
      if (!domainId) return false;
      domains.set(domain, domainId);
    }
    const domainId = domains.get(domain);

    value = Array.isArray(value) ? value : [value];
    const a_records = value.map((v) => {
      return {
        type: 'A',
        gtdLocation: 'DEFAULT',
        name,
        value: v,
        ttl
      };
    });
    const srv_records = [
      {
        type: 'SRV',
        gtdLocation: 'DEFAULT',
        name: `_sip._udp.${name}`,
        value: `${name}`,
        port: 5060,
        priority: 10,
        weight: 100,
        ttl
      }
    ];
    const headers = createAuthHeaders();
    const records = [...a_records, ...srv_records];
    const response = await fetch(`${process.env.DME_BASE_URL}/dns/managed/${domainId}/records/createMulti`, {
      method: 'POST',
      headers,
      body: JSON.stringify(records)
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      logger.error({status: response.status, body: errBody}, 'Error creating records');
      return;
    }
    const result = await response.json();
    logger.debug({result}, 'createDnsRecords: created records');
    if (201 === response.status) {
      return result;
    }
  } catch (err) {
    logger.error({err}, 'Error retrieving domains');
  }
};

const deleteDnsRecords = async(logger, domain, recIds) => {
  checkAsserts();
  const headers = createAuthHeaders();
  try {
    if (!domains.has(domain)) {
      const domainId = await getDnsDomainId(logger, domain);
      if (!domainId) return false;
      domains.set(domain, domainId);
    }
    const domainId = domains.get(domain);
    const url = `/dns/managed/${domainId}/records?${recIds.map((r) => `ids=${r}`).join('&')}`;
    await fetch(`${process.env.DME_BASE_URL}${url}`, {
      method: 'DELETE',
      headers
    });
    return true;
  } catch (err) {
    console.error(err);
    logger.error({err}, 'Error deleting records');
  }
};


const insertDnsRecords = `INSERT INTO dns_records 
(dns_record_sid, account_sid, record_type, record_id) 
VALUES  `;

/**
 * Provision (or re-provision) DNS records for an account's SIP realm.
 * Deletes any existing DNS records for the account then creates fresh ones.
 * Safe to call from any route that updates sip_realm.
 */
const provisionSipRealmDns = async(logger, account_sid, sip_realm) => {
  if (!process.env.DME_API_KEY) {
    logger.info({account_sid, sip_realm}, 'provisionSipRealmDns: DME_API_KEY not set, skipping');
    return;
  }
  const arr = /(.*)\.(.*\..*)$/.exec(sip_realm);
  if (!arr) throw new Error(`invalid sip_realm for DNS provisioning: ${sip_realm}`);
  const subdomain = arr[1];
  const domain = arr[2];

  const [sbcs] = await promisePool.query('SELECT ipv4 from sbc_addresses');
  if (sbcs.length === 0) throw new Error('no SBC addresses provisioned in the database');
  const uniqueIps = [...new Set(sbcs.map((s) => s.ipv4))];

  const [old_recs] = await promisePool.query(
    'SELECT record_id from dns_records WHERE account_sid = ?', account_sid
  );
  if (old_recs.length > 0) {
    await promisePool.query('DELETE from dns_records WHERE account_sid = ?', account_sid);
    const deleted = await deleteDnsRecords(logger, domain, old_recs.map((r) => r.record_id));
    if (!deleted) {
      logger.error({old_recs, sip_realm, account_sid},
        'provisionSipRealmDns: failed to remove old dns records');
    }
  }

  const records = await createDnsRecords(logger, domain, subdomain, uniqueIps);
  if (!records) throw new Error(`provisionSipRealmDns: failed to create DNS records for ${sip_realm}`);

  const values = records.map((r) =>
    `('${uuid()}', '${account_sid}', '${r.type}', ${r.id})`
  ).join(',');
  const [result] = await promisePool.execute(`${insertDnsRecords}${values};`);
  if (result.affectedRows !== records.length) throw new Error('provisionSipRealmDns: failed inserting dns records');

  logger.info({account_sid, sip_realm, record_count: records.length},
    'provisionSipRealmDns: DNS records provisioned successfully');
};

module.exports = {
  getDnsDomainId,
  createDnsRecords,
  deleteDnsRecords,
  provisionSipRealmDns,
};
