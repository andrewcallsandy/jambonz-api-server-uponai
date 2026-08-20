const Model = require('./model');
const {promisePool} = require('../db');

class BlfConfiguration extends Model {
  constructor() {
    super();
  }

  static async retrieveByAccountSid(account_sid) {
    const [rows] = await promisePool.query(
      'SELECT * FROM blf_configurations WHERE account_sid = ? ORDER BY created_at DESC',
      [account_sid]
    );
    return rows;
  }

  static async retrieveByCarrierSid(voip_carrier_sid) {
    const [rows] = await promisePool.query(
      'SELECT * FROM blf_configurations WHERE voip_carrier_sid = ?',
      [voip_carrier_sid]
    );
    return rows;
  }

  static async retrieveByTokenHash(token_hash) {
    const [rows] = await promisePool.query(
      'SELECT * FROM blf_configurations WHERE capability_token_hash = ?',
      [token_hash]
    );
    return rows;
  }

  static async retrieveEnabledForReconcile() {
    const [rows] = await promisePool.query(`
      SELECT bc.*,
        vc.register_username, vc.register_password, vc.register_sip_realm,
        vc.register_from_user, vc.register_from_domain, vc.register_public_ip_in_contact,
        vc.outbound_sip_proxy, vc.register_status, vc.trunk_type, vc.is_active,
        vc.requires_register, vc.name AS carrier_name, vc.account_sid AS carrier_account_sid
      FROM blf_configurations bc
      INNER JOIN voip_carriers vc ON vc.voip_carrier_sid = bc.voip_carrier_sid
      WHERE bc.is_enabled = 1
        AND vc.is_active = 1
        AND vc.requires_register = 1
        AND vc.trunk_type IN ('reg', 'auth')
    `);
    return rows;
  }
}

BlfConfiguration.table = 'blf_configurations';
BlfConfiguration.fields = [
  {name: 'blf_configuration_sid', type: 'string', primaryKey: true},
  {name: 'account_sid', type: 'string', required: true},
  {name: 'voip_carrier_sid', type: 'string', required: true},
  {name: 'is_enabled', type: 'number'},
  {name: 'event_package', type: 'string'},
  {name: 'subscribe_expires', type: 'number'},
  {name: 'stale_seconds', type: 'number'},
  {name: 'availability_hook_sid', type: 'string'},
  {name: 'capability_token_hash', type: 'string'},
  {name: 'capability_token_encrypted', type: 'string'},
  {name: 'owner_node', type: 'string'},
  {name: 'last_reconcile_at', type: 'string'},
  {name: 'last_error', type: 'string'},
];

module.exports = BlfConfiguration;
