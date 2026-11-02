// Unit tests for src/client-key.ts: rate limits count by visitor, not by proxy.
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientKey, ipv6Key } = require('../dist/client-key');

const req = (cf, ip = '172.18.0.5') => ({ headers: cf === undefined ? {} : { 'cf-connecting-ip': cf }, ip });

test('a valid CF-Connecting-IP is the key', () => {
  assert.equal(clientKey(req('203.0.113.7')), '203.0.113.7');
  assert.equal(clientKey(req(' 203.0.113.7 ')), '203.0.113.7');
});

test('a missing, junk or list-valued header falls back to the peer address', () => {
  for (const cf of [undefined, '', 'not-an-ip', '203.0.113.7, 198.51.100.1', '999.1.1.1', '<script>', '203.0.113.7/24']) {
    assert.equal(clientKey(req(cf)), '172.18.0.5', JSON.stringify(cf));
  }
  assert.equal(clientKey({ headers: { 'cf-connecting-ip': ['203.0.113.7'] }, ip: '172.18.0.5' }), '172.18.0.5');
});

test('IPv6 addresses count per /64', () => {
  assert.equal(clientKey(req('2001:db8:1:2::a')), '2001:db8:1:2::/64');
  assert.equal(clientKey(req('2001:db8:1:2:ffff:ffff:ffff:ffff')), '2001:db8:1:2::/64');
  assert.equal(clientKey(req('2001:0DB8:0001:0002:0000:0000:0000:000a')), '2001:db8:1:2::/64');
  assert.notEqual(clientKey(req('2001:db8:1:3::a')), clientKey(req('2001:db8:1:2::a')));
  assert.equal(ipv6Key('::1'), '0:0:0:0::/64');
  assert.equal(ipv6Key('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(ipv6Key('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipv6Key('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
});

test('IPv4-mapped IPv6 counts as the IPv4 address', () => {
  assert.equal(clientKey(req('::ffff:203.0.113.7')), '203.0.113.7');
  assert.equal(clientKey(req(undefined, '::ffff:172.18.0.5')), '172.18.0.5');
});
