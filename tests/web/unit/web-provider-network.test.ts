import assert from 'node:assert/strict';
import test from 'node:test';
import { privateIPv4 } from '../../../apps/server/web-provider-server.ts';

test('LAN test listener accepts only RFC1918 IPv4 clients', () => {
  for (const ok of ['10.0.0.8', '172.16.0.1', '172.31.255.254', '192.168.31.22', '::ffff:192.168.1.5'])
    assert.ok(privateIPv4(ok), ok);
  for (const bad of ['127.0.0.1', '8.8.8.8', '172.32.0.1', '172.15.9.9', '192.169.0.1', '::1',
    'fe80::1', '192.168.1', '192.168.1.256', '', undefined])
    assert.equal(privateIPv4(bad), null, String(bad));
});
