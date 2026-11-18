import assert from 'node:assert/strict';
import test from 'node:test';
import { isReadOnlyAdminPost } from '../../../apps/server/cloudflare/web-admin-read.ts';
import { WEB_HTTP_LIMITS } from '../../../config/web-v1.ts';

// Named exception (Part 22x): /admin/invites/list was removed with the legacy invite system, so it leaves the allowlist.
test('read-only admin POSTs are an explicit allowlist', () => {
  for (const path of [
    '/admin/characters/list',
    '/admin/eval-sets/list',
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

// Part 22b: the read-only allowlist for the new routes. points/preview is NOT read-only: with an email target it writes a points-lookup
// audit row (the same reason 22a2 took invites/batch-detail off the list), so it keeps the write limit.
test('22b: 概览, 系统状态 and the reset preview are read-only; points/preview, grant, reset, renew and top-up are writes; batch-detail stays a write', () => {
  for (const path of ['/admin/overview/read', '/admin/system/status', '/admin/points/reset-preview'])
    assert.equal(isReadOnlyAdminPost(path), true, path);
  for (const path of [
    '/admin/points/preview',
    '/admin/points/grant',
    '/admin/points/reset',
    '/admin/system/renew-prices',
    '/admin/system/budget-topup',
    '/admin/invites/batch-detail',
    '/admin/system/status/extra',
    '/admin/points/preview/x',
  ])
    assert.equal(isReadOnlyAdminPost(path), false, path);
});

// Part 41: the clip-takes price reads (one per pause in typing, one per slot on open) and the audio of a take are reads. A new test: the
// older ones above are unchanged (material-audio stays a write there on purpose).
test('41: take estimates, take list and take audio are read-only; take writes keep the write limit', () => {
  for (const action of ['take-list', 'take-estimate', 'take-estimate-direction', 'take-audio'])
    assert.equal(isReadOnlyAdminPost(`/admin/characters/jojo/${action}`), true, action);
  for (const action of [
    'take-generate',
    'take-generate-all',
    'take-rewrite',
    'take-select',
    'take-rename',
    'take-delete',
    'take-approve',
    'take-upload',
    'take-bundle',
  ])
    assert.equal(isReadOnlyAdminPost(`/admin/characters/jojo/${action}`), false, action);
  for (const path of [
    '/admin/owner/arc-read',
    '/admin/owner/closed-read',
    '/admin/stats/chart',
    '/admin/characters/home-order',
  ])
    assert.equal(isReadOnlyAdminPost(path), true, path);
  for (const path of ['/admin/owner/arc-save', '/admin/owner/closed-delete', '/admin/characters/order'])
    assert.equal(isReadOnlyAdminPost(path), false, path);
});
