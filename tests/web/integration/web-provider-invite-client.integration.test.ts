import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { ProviderApi } from '../../../apps/player-web/src/services/provider-api.ts';
import { ProviderInviteController } from '../../../apps/player-web/src/session/provider-invite-controller.ts';

for (const loss of ['cookie-and-body', 'body-only', 'no-request'] as const) {
  test(`provider client recovers ${loss} with persistent HTTP/SQLite/R2, one entitlement`, async (t) => {
    const runtime = localRuntime(
      t,
      'tests/web/fixtures/cloudflare-http-worker.ts',
      { STATE: 'WebHTTPFixture' },
      ['MEDIA'],
      [],
      ['enable_request_signal'],
    );
    const origin = 'https://fixture.invalid',
      base = '/api/web/provider';
    const grant = await runtime.call<{ token: string }>('/fixture/grant');
    const login = await runtime.request(origin + base + '/admin/login', {
      method: 'POST',
      headers: { 'x-fixture-host': 'fixture.invalid', origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: grant.token }),
    });
    assert.equal(login.status, 200);
    const adminCookie = login.headers.get('set-cookie')!.split(';')[0]!,
      admin = (await login.json()) as { csrf: string };
    const issued = await runtime.request(origin + base + '/admin/invites/batch-create', {
      method: 'POST',
      headers: {
        'x-fixture-host': 'fixture.invalid',
        origin,
        cookie: adminCookie,
        'x-csrf-token': admin.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: randomUUID(),
        name: 'offline-receipt',
        count: 1,
        tier: { kind: 'unlimited' },
        durationDays: null,
        redeemBy: null,
      }),
    });
    assert.equal(issued.status, 201);
    const code = ((await issued.json()) as { codes: string[] }).codes[0]!;
    let cookie = '',
      lose = true;
    const calls: { path: string; requestId?: string }[] = [];
    const api = new ProviderApi(async (input, init = {}) => {
      const path = String(input),
        headers = new Headers(init.headers);
      headers.set('x-fixture-host', 'fixture.invalid');
      if (cookie) headers.set('cookie', cookie);
      if (init.method === 'POST') headers.set('origin', origin);
      const body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, ...(body.requestId ? { requestId: body.requestId } : {}) });
      const dropped = path.endsWith('/invites/redeem') && lose;
      if (dropped) lose = false;
      if (dropped && loss === 'no-request') throw Error('offline before acceptance');
      const response = await runtime.request(origin + path, {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers),
        ...(init.body ? { body: String(init.body) } : {}),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie && !(dropped && loss === 'cookie-and-body'))
        cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
      const bytes = await response.arrayBuffer();
      if (dropped) {
        assert.equal(response.status, 201);
        throw Error('lost successful response');
      }
      return new Response(bytes, { status: response.status, headers: Object.fromEntries(response.headers) });
    });
    let view = await api.bootstrap();
    // A player redeems a code only when signed up: give this principal its email login directly.
    await runtime.call('/fixture/login', { principalId: view.access.principalId });
    const original = structuredClone(view),
      stats = await runtime.call<any>('/fixture/stats');
    let installed = 0;
    const controller = new ProviderInviteController(
      api,
      () => view,
      (next) => {
        view = next;
        installed++;
      },
      () => {},
    );
    const first = controller.redeem(code);
    assert.equal(await controller.redeem(code), false);
    await first;
    assert.equal(controller.state.phase, 'uncertain');
    await runtime.restart();
    const recovery = controller.recover();
    assert.equal(await controller.recover(), false);
    // Named exception (Part 22x): every loss is settled by the same request (the old no-request case had nothing to recover).
    assert.equal(await recovery, true, JSON.stringify({ state: controller.state, calls }));
    assert.equal(await controller.redeem(code), false);
    assert.equal(installed, 1);
    assert.equal(view.access.principalId, original.access.principalId);
    assert.equal(view.access.worldId, original.access.worldId);
    {
      // Named exception (Part 22x): redeeming adds an entitlement; the principal stays what it was (a guest) and its session is
      // the same one, so there is no receipt and no recovery route: the lost answer is settled by asking again, same requestId.
      assert.equal(view.access.kind, 'guest');
      assert.equal(view.access.canSend, true);
      await runtime.restart();
      assert.deepEqual((await api.bootstrap()).access, view.access);
    }
    const redemption = calls.filter((c) => c.path.endsWith('/invites/redeem'));
    assert.equal(redemption.length, 2, 'the lost attempt and its recovery');
    assert.equal(redemption[0]!.requestId, redemption[1]!.requestId, 'the recovery repeats the same request');
    assert.equal(calls.filter((c) => c.path.includes('receipt')).length, 0, 'no receipt route is used');
    for (const call of calls.filter((c) => c.requestId)) assert.equal(call.requestId, redemption[0]!.requestId);
    const info = (await (
      await runtime.request(origin + base + '/account', { headers: { 'x-fixture-host': 'fixture.invalid', cookie } })
    ).json()) as { tier: { kind: string } };
    assert.equal(info.tier.kind, 'unlimited', 'redeemed exactly once, whatever the loss');
    const after = await runtime.call<any>('/fixture/stats');
    assert.deepEqual(
      after,
      stats,
      'identity upgrade must not generate messages, spend budget or create a replacement principal',
    );
  });
}
