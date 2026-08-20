const assert = require('assert');
const {
  parseDialogInfo,
  parsePidf,
  parseNotifyBody,
  isAvailable,
} = require('../lib/utils/blf-parse');

describe('blf-parse', () => {
  it('parses empty dialog-info as idle', () => {
    const body = `<?xml version="1.0"?><dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" version="1" state="full" entity="sip:101@pbx"><\/dialog-info>`;
    const r = parseDialogInfo(body);
    assert.strictEqual(r.state, 'idle');
  });

  it('parses confirmed dialog as busy', () => {
    const body = `<dialog-info><dialog id="1"><state>confirmed</state></dialog></dialog-info>`;
    assert.strictEqual(parseDialogInfo(body).state, 'busy');
  });

  it('parses early dialog as ringing', () => {
    const body = `<dialog-info><dialog id="1"><state>early</state></dialog></dialog-info>`;
    assert.strictEqual(parseDialogInfo(body).state, 'ringing');
  });

  it('parses pidf open as idle', () => {
    const body = `<presence><tuple><status><basic>open</basic></status></tuple></presence>`;
    assert.strictEqual(parsePidf(body).state, 'idle');
  });

  it('parses pidf on-the-phone as busy', () => {
    const body = `<presence><tuple><status><basic>open</basic></status></tuple><activities><on-the-phone/></activities></presence>`;
    assert.strictEqual(parsePidf(body).state, 'busy');
  });

  it('detects content-type for notify body', () => {
    const body = `<dialog-info><dialog id="1"><state>terminated</state></dialog></dialog-info>`;
    assert.strictEqual(parseNotifyBody('application/dialog-info+xml', body).state, 'idle');
  });

  it('isAvailable requires idle active non-stale', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    assert.strictEqual(isAvailable({
      is_enabled: 1,
      sub_status: 'active',
      state: 'idle',
      stale_at: future,
    }), true);
    assert.strictEqual(isAvailable({
      is_enabled: 1,
      sub_status: 'active',
      state: 'busy',
      stale_at: future,
    }), false);
  });
});
