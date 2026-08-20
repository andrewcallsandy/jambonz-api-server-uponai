const Model = require('./model');
const {promisePool} = require('../db');

class BlfMonitor extends Model {
  constructor() {
    super();
  }

  static async retrieveByConfigurationSid(blf_configuration_sid) {
    const [rows] = await promisePool.query(
      `SELECT * FROM blf_monitors
       WHERE blf_configuration_sid = ?
       ORDER BY extension ASC`,
      [blf_configuration_sid]
    );
    return rows;
  }

  static async retrieveByContactUser(contact_user) {
    const [rows] = await promisePool.query(
      'SELECT * FROM blf_monitors WHERE contact_user = ?',
      [contact_user]
    );
    return rows;
  }

  static async retrieveEnabledForConfig(blf_configuration_sid) {
    const [rows] = await promisePool.query(
      `SELECT * FROM blf_monitors
       WHERE blf_configuration_sid = ? AND is_enabled = 1
       ORDER BY extension ASC`,
      [blf_configuration_sid]
    );
    return rows;
  }

  static async countByState(blf_configuration_sid) {
    const [rows] = await promisePool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(sub_status = 'active') AS active_subscriptions,
         SUM(state = 'idle') AS idle,
         SUM(state = 'busy') AS busy,
         SUM(state = 'unknown') AS unknown_count
       FROM blf_monitors
       WHERE blf_configuration_sid = ?`,
      [blf_configuration_sid]
    );
    return rows[0] || {};
  }
}

BlfMonitor.table = 'blf_monitors';
BlfMonitor.fields = [
  {name: 'blf_monitor_sid', type: 'string', primaryKey: true},
  {name: 'blf_configuration_sid', type: 'string', required: true},
  {name: 'extension', type: 'string', required: true},
  {name: 'display_name', type: 'string'},
  {name: 'presentity_uri', type: 'string', required: true},
  {name: 'is_enabled', type: 'number'},
  {name: 'contact_user', type: 'string', required: true},
  {name: 'sub_call_id', type: 'string'},
  {name: 'sub_local_tag', type: 'string'},
  {name: 'sub_remote_tag', type: 'string'},
  {name: 'sub_remote_target', type: 'string'},
  {name: 'sub_route_set', type: 'string'},
  {name: 'sub_cseq', type: 'number'},
  {name: 'sub_expires_at', type: 'string'},
  {name: 'sub_status', type: 'string'},
  {name: 'owner_node', type: 'string'},
  {name: 'state', type: 'string'},
  {name: 'subscription_state', type: 'string'},
  {name: 'state_raw', type: 'string'},
  {name: 'last_notify_at', type: 'string'},
  {name: 'stale_at', type: 'string'},
  {name: 'last_error', type: 'string'},
];

module.exports = BlfMonitor;
