const router = require('express').Router();
const {promisePool} = require('../../db');
console.log('SIP-REALM ROUTE LOADED');
const {DbErrorBadRequest} = require('../../utils/errors');
const {createDnsRecords, deleteDnsRecords} = require('../../utils/dns-utils');
const {parseAccountSid} = require('./utils');
const { v4: uuid } = require('uuid');
const sysError = require('../error');
const insertDnsRecords = `INSERT INTO dns_records 
(dns_record_sid, account_sid, record_type, record_id) 
VALUES  `;

router.post('/:sip_realm', async(req, res) => {
  console.log('SIP REALM POST ROUTE HIT with sip_realm:', req.params.sip_realm);
  const logger = req.app.locals.logger;
  // For admin users, use the account_sid from the URL, otherwise use the user's account_sid
  let account_sid;
  try {
    console.log('req.user.hasScope("admin"):', req.user.hasScope('admin'));
    console.log('req.originalUrl:', req.originalUrl);
    // Always try to parse from URL first, then fall back to user account_sid
    account_sid = parseAccountSid(req) || req.user.account_sid;
    console.log('Parsed account_sid:', account_sid);
    if (!account_sid) {
      console.log('Account SID is null or empty');
      return res.status(400).json({msg: 'Account ID is required'});
    }
  } catch (error) {
    console.log('Error parsing account_sid:', error.message);
    return res.status(400).json({msg: 'Invalid account ID'});
  }
  const sip_realm = req.params.sip_realm;
  const skipDns = req.query.skip_dns === 'true';
  logger.info({account_sid, sip_realm, skipDns, hasAdminScope: req.user.hasScope('admin')},
    'Processing SIP realm request');
  try {
    const arr = /(.*)\.(.*\..*)$/.exec(sip_realm);
    if (!arr) throw new DbErrorBadRequest(`invalid sip_realm: ${sip_realm}`);
    const subdomain = arr[1];
    const domain = arr[2];

    logger.info({account_sid}, 'About to check if account exists');
    /* check if account exists and update the sip_realm */
    const [existing] = await promisePool.execute(
      'SELECT account_sid FROM accounts WHERE account_sid = ?', [account_sid]);
    logger.info({existing, existingLength: existing.length, account_sid}, 'Account lookup result');
    if (existing.length === 0) throw new Error('account not found');

    const [r] = await promisePool.execute('UPDATE accounts set sip_realm = ? WHERE account_sid = ?',
      [sip_realm, account_sid]);
    if (r.affectedRows !== 1) throw new Error('failure updating accounts table with sip_realm value');

    if (skipDns) {
      logger.info({account_sid, sip_realm}, 'Skipping DNS operations as skip_dns=true');
      return res.sendStatus(204);
    }

    if (process.env.NODE_ENV !== 'test' || process.env.DME_API_KEY) {
      /* update DNS provider */

      /* retrieve sbc addresses */
      const [sbcs] = await promisePool.query('SELECT ipv4 from sbc_addresses');
      if (sbcs.length === 0) throw new Error('no SBC addresses provisioned in the database!');
      const ips = sbcs.map((s) => s.ipv4);
      const uniqueIps = [...new Set(ips)];

      /* retrieve existing dns records */
      const [old_recs] = await promisePool.query('SELECT record_id from dns_records WHERE account_sid = ?',
        account_sid);

      if (old_recs.length > 0) {
        /* remove existing records from the database and dns provider */
        await promisePool.query('DELETE from dns_records WHERE account_sid = ?', account_sid);

        const deleted = await deleteDnsRecords(logger, domain, old_recs.map((r) => r.record_id));
        if (!deleted) {
          logger.error({old_recs, sip_realm, account_sid},
            'Failed to remove old dns records when changing sip_realm for account');
        }
      }

      /* add the dns records */
      const records = await createDnsRecords(logger, domain, subdomain, uniqueIps);
      if (!records) throw new Error(`failure updating dns records for ${sip_realm}`);
      const values = records.map((r) => {
        return `('${uuid()}', '${account_sid}', '${r.type}', ${r.id})`;
      }).join(',');
      const sql = `${insertDnsRecords}${values};`;
      const [result] = await promisePool.execute(sql);
      if (result.affectedRows != records.length) throw new Error('failed inserting dns records');
    }
    res.sendStatus(204);
  } catch (err) {
    sysError(logger, res, err);
  }
});


module.exports = router;
