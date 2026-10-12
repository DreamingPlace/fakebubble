import assert from 'node:assert/strict';
import test from 'node:test';
import { isReadOnlyAdminPost } from '../../../apps/server/cloudflare/web-admin-read.ts';
import { WEB_HTTP_LIMITS } from '../../../config/web-v1.ts';

test('read-only admin POSTs are an explicit allowlist', () => {
  for (const path of [
    '/admin/characters/list',
    '/admin/eval-sets/list',
    '/admin/invites/list',
    '/admin/members/list',
    '/admin/metrics/stage-latency',
    '/admin/cocreation/counts',
    '/admin/cocreation/list',
    '/admin/cocreation/detail',
    ...[
      'detail',
      'review-status',
      'run-list',
      'run-detail',
      'preview-detail',
      'previews-status',
      'material-list',
      'delete-status',
    ].map((action) => `/admin/characters/jojo/${action}`),
  ])
    assert.equal(isReadOnlyAdminPost(path), true, path);
});

test('every write, secret-bearing or unknown admin path keeps the write limit', () => {
  for (const path of [
    '/admin/login',
    '/admin/email/login',
    '/admin/invites/issue',
    '/admin/members/issue',
    '/admin/eval-sets/save',
    '/admin/eval-sets/delete',
    '/admin/cocreation/set-status',
    '/admin/characters/jojo/save',
    '/admin/characters/jojo/review-start',
    '/admin/characters/jojo/run-start',
    '/admin/characters/jojo/delete-start',
    '/admin/characters/jojo/delete-preview',
    '/admin/characters/jojo/material-audio',
    '/admin/characters/jojo/detail/extra',
    '/admin/characters/a%2Fb/detail',
    '/admin/characters/list/extra',
    '/admin/unknown/list',
    '/characters/jojo/operations',
    '/account/list',
    '/invites/list',
    '',
  ])
    assert.equal(isReadOnlyAdminPost(path), false, path);
});

test('the read budget is higher than the write budget', () => {
  assert.equal(WEB_HTTP_LIMITS.adminReadsPerIpPerMinute, 300);
  assert.ok(WEB_HTTP_LIMITS.adminReadsPerIpPerMinute > WEB_HTTP_LIMITS.writesPerIpPerMinute);
  assert.ok(WEB_HTTP_LIMITS.adminReadsPerIpPerMinute < WEB_HTTP_LIMITS.requestsPerIpPerMinute);
});
