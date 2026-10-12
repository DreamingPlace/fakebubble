import assert from 'node:assert/strict';
import test from 'node:test';
import { ipKeyInput, peerIpHash } from '../../../apps/server/admission/ip-key-input.ts';

const KEY = Buffer.alloc(32, 1).toString('base64url');

test('IPv4 keeps its exact input, so existing IPv4 hashes still match (one pinned value)', () => {
  assert.equal(ipKeyInput('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKeyInput('127.0.0.1'), '127.0.0.1');
  // Computed with the formula before Part 17c: HMAC-SHA256(ipKey, 'web-cloud-ip-v1\0' + peer).
  assert.equal(
    peerIpHash(KEY, 'web-cloud-ip-v1', '203.0.113.9'),
    '56a85af312985205fdadae5e16a5f9dbb7d4a65f8f25e2f103ffcfb50a8a8292',
  );
});

test('IPv4-mapped IPv6 is that IPv4 address', () => {
  assert.equal(ipKeyInput('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKeyInput('::FFFF:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKeyInput('::ffff:cb00:7109'), '203.0.113.9');
  assert.equal(ipKeyInput('0:0:0:0:0:ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(
    peerIpHash(KEY, 'web-cloud-ip-v1', '::ffff:203.0.113.9'),
    peerIpHash(KEY, 'web-cloud-ip-v1', '203.0.113.9'),
  );
});

test('any other IPv6 address is keyed by its /64 in one canonical form', () => {
  const prefix = '2001:db8:1:2::/64';
  for (const address of [
    '2001:db8:1:2::1',
    '2001:db8:1:2:ffff:ffff:ffff:ffff',
    '2001:0DB8:0001:0002:0:0:0:5',
    '2001:db8:1:2::',
    '2001:db8:1:2:0:0:203.0.113.9',
  ])
    assert.equal(ipKeyInput(address), prefix, address);
  assert.equal(ipKeyInput('2001:db8:1:3::1'), '2001:db8:1:3::/64');
  assert.equal(ipKeyInput('::1'), '0:0:0:0::/64');
  assert.equal(ipKeyInput('::'), '0:0:0:0::/64');
  assert.equal(ipKeyInput('fe80::1'), 'fe80:0:0:0::/64');
  assert.equal(ipKeyInput('2001:db8::1:2:3:4:5'), '2001:db8:0:1::/64');
  assert.equal(
    peerIpHash(KEY, 'web-cloud-ip-v1', '2001:db8:1:2::1'),
    peerIpHash(KEY, 'web-cloud-ip-v1', '2001:db8:1:2::9'),
  );
  assert.notEqual(
    peerIpHash(KEY, 'web-cloud-ip-v1', '2001:db8:1:2::1'),
    peerIpHash(KEY, 'web-cloud-ip-v1', '2001:db8:1:3::1'),
  );
});

test('an unparsable IPv6 address has no key (the caller refuses it)', () => {
  for (const bad of [
    ':',
    ':::',
    '1::2::3',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    'g::1',
    '12345::1',
    '1:2:3:4:5:6:7::8',
    '::1.2.3',
    '::1.2.3.999',
    ':1:2:3:4:5:6:7',
  ])
    assert.equal(ipKeyInput(bad), null, bad);
  assert.equal(peerIpHash(KEY, 'web-cloud-ip-v1', '1::2::3'), null);
});
