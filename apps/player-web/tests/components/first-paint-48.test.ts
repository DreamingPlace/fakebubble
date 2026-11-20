// Part 48: the first paint without a session. Pure logic only (the real page is driven by scripts/check-web-first-screen-48-browser.ts):
// the public catalog's cards equal the session's cards, the gate runs the session in the background, an action that needs a session
// waits for it and then continues by itself, a closed sheet drops it, and nothing is sent before a session exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeferredLive, publicPeople } from '../../src/features/prototype/deferred-live.ts';
import { providerPeople } from '../../src/features/prototype/provider-catalog-view.ts';
import { SessionGate, isRetryable } from '../../src/features/prototype/session-gate.ts';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { parseWebPublicCatalog, type WebPublicCatalog } from '../../../../packages/contracts/web-public-catalog.ts';
import { syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import type { LiveBinding } from '../../src/features/prototype/provider-binding.ts';

const catalog = (): WebPublicCatalog => ({
  characters: [
    {
      characterId: 'wei-guagua',
      displayName: '魏瓜瓜',
      portraitUrl: null,
      mainColor: '#D7C8B9',
      palette: null,
      birthDate: '2001-05-17',
      available: true,
      welcomeClip: true,
    },
    {
      characterId: 'jojo',
      displayName: 'JoJo',
      portraitUrl: null,
      mainColor: null,
      palette: [{ hex: '#336699', role: 'main' }],
      birthDate: null,
      available: true,
      welcomeClip: false,
    },
    {
      characterId: 'later',
      displayName: 'Later',
      portraitUrl: null,
      mainColor: null,
      palette: null,
      birthDate: null,
      available: false,
      welcomeClip: false,
    },
  ],
  slots: [
    { kind: 'character', characterId: 'wei-guagua' },
    { kind: 'character', characterId: 'jojo' },
    { kind: 'character', characterId: 'later' },
    ...Array.from({ length: 12 }, (_, i) => ({
      kind: 'preview' as const,
      slotId: `preview-${i + 1}`,
      label: '敬请期待',
    })),
  ],
});

test('the public catalog reader is strict: extra or missing fields, bad colours and wrong slot counts are refused', () => {
  const good = catalog();
  assert.deepEqual(parseWebPublicCatalog(JSON.parse(JSON.stringify(good))), good);
  const bad = (change: (value: any) => void) => {
    const value: any = JSON.parse(JSON.stringify(good));
    change(value);
    assert.throws(() => parseWebPublicCatalog(value), /WEB_PUBLIC_CATALOG_INVALID/);
  };
  bad((v) => (v.characters[0].csrf = 'x'));
  bad((v) => (v.characters[0].welcome = { text: 'secret' }));
  bad((v) => delete v.characters[0].available);
  bad((v) => (v.characters[0].mainColor = 'red'));
  bad((v) => (v.slots = v.slots.slice(1)));
  bad((v) => (v.extra = 1));
  bad((v) => (v.characters[1].characterId = 'wei-guagua'));
  bad((v) => (v.slots[0].characterId = 'unknown'));
});

test('the first paint draws the same cards as the session will: ids, order, numbers, colours, chat or placeholder', () => {
  const first = publicPeople(catalog());
  const boot = syntheticProviderBootstrap();
  // The same adapter the session goes through gives the same cards for the same facts.
  const real = providerPeople({
    characters: catalog().characters.map((c) => ({
      characterId: c.characterId,
      displayName: c.displayName,
      publicDescription: 'd',
      portraitUrl: c.portraitUrl,
      theme: null,
      mainColor: c.mainColor,
      palette: c.palette,
      birthDate: c.birthDate,
      availability: c.available
        ? ({ state: 'available', personaVersion: 1 } as const)
        : ({ state: 'unavailable', reason: 'voice_unverified' } as const),
      welcome: c.available
        ? { text: '你好', version: 'w1', audio: { state: 'unavailable', reason: 'audio_missing' } as const }
        : { text: null, version: null, audio: { state: 'unavailable', reason: 'voice_unverified' } as const },
    })),
    slots: catalog().slots,
  });
  assert.ok(boot);
  assert.equal(first.length, 15);
  assert.deepEqual(
    first.map((p) => [p.id, p.characterId, p.name, p.card.no, p.card.latin, p.color, p.ink, p.mark]),
    real.map((p) => [p.id, p.characterId, p.name, p.card.no, p.card.latin, p.color, p.ink, p.mark]),
  );
  assert.deepEqual(
    first.map((p) => p.transcript !== undefined),
    real.map((p) => p.transcript !== undefined),
  );
  // A chat card carries a non-empty placeholder line (the shell reads "configured" from it); the real line replaces it with the session.
  assert.ok(first.filter((p) => p.transcript !== undefined).every((p) => p.transcript));
  // The pill has no length yet (nothing is shown in it until the session brings it).
  assert.ok(first.every((p) => !p.welcomeMs));
  // 17 May: No.0517 (the orbit padding puts the placeholders first, so the character is looked up, not indexed).
  assert.equal(first.find((p) => p.characterId === 'wei-guagua')!.card.no, '0517');
});

const connected = () => ({}) as LiveBinding;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the gate: starts once, ready resolves every waiting action, a failure waits for 重试 and never retries by itself', async () => {
  let attempts = 0;
  let outcome: 'fail' | 'ok' = 'fail';
  const gate = new SessionGate(new ProviderApi(), async () => {
    attempts++;
    if (outcome === 'fail') throw new ProviderApiError(0, 'TURNSTILE_FAILED');
    return connected();
  });
  const states: string[] = [];
  gate.onChange(() => states.push(gate.state));
  assert.equal(gate.state, 'idle');
  gate.start();
  gate.start();
  await tick();
  assert.equal(attempts, 1);
  assert.deepEqual(states, ['connecting', 'failed']);
  // another tap while failed does not start another attempt (only 重试 does)
  let resolved = false;
  void gate.require().then(() => (resolved = true));
  await tick();
  assert.equal(attempts, 1);
  assert.equal(gate.pending, 1);
  outcome = 'ok';
  gate.retry();
  await tick();
  assert.equal(attempts, 2);
  assert.equal(gate.state, 'ready');
  assert.equal(resolved, true, 'the waiting action continues by itself');
  assert.equal(gate.pending, 0);
  // once ready, nothing starts again
  gate.start();
  gate.retry();
  assert.equal(attempts, 2);
  assert.equal(await gate.require(), gate.live);
});

test('the gate: a closed sheet drops the waiting actions; a click-wanting widget is a state of its own', async () => {
  let finish: (() => void) | undefined;
  const gate = new SessionGate(
    new ProviderApi(),
    () => new Promise<LiveBinding>((resolve) => (finish = () => resolve(connected()))),
  );
  gate.start();
  const waiting = gate.require().then(
    () => 'ran',
    (error: Error) => error.message,
  );
  gate.phase('interactive');
  assert.equal(gate.state, 'interactive');
  gate.phase('solving');
  assert.equal(gate.state, 'connecting');
  gate.cancel();
  assert.equal(await waiting, 'SESSION_WAIT_CANCELLED');
  finish?.();
  await tick();
  assert.equal(gate.state, 'ready', 'the session still arrives for the page; only the dropped action is gone');
});

test('the gate: signed-out and expired-guest failures are not retry cases (the page shows its own page); Turnstile and network ones are', async () => {
  for (const [error, retry] of [
    [new ProviderApiError(0, 'TURNSTILE_FAILED'), true],
    [new ProviderApiError(403, 'TURNSTILE_REQUIRED'), true],
    [new ProviderApiError(503, 'SERVICE_UNAVAILABLE'), true],
    [new ProviderApiError(0, 'PROTOCOL_INVALID'), true],
    [new TypeError('Failed to fetch'), true],
    [new ProviderApiError(401, 'SESSION_EXPIRED'), false],
    [new ProviderApiError(401, 'GUEST_SESSION_EXPIRED'), false],
    [new ProviderApiError(403, 'REGION_UNAVAILABLE'), false],
  ] as const)
    assert.equal(isRetryable(error), retry, String((error as { code?: string }).code ?? error));
  let hard: unknown = null;
  const gate = new SessionGate(new ProviderApi(), async () => {
    throw new ProviderApiError(401, 'SESSION_EXPIRED');
  });
  gate.onHardFailure((error) => (hard = error));
  gate.start();
  await tick();
  assert.equal((hard as ProviderApiError).code, 'SESSION_EXPIRED');
});

test('before a session: nothing that needs one reaches the server; after it, the tapped action runs once, by itself', async () => {
  const calls: string[] = [];
  const real = {
    freeTierEnabled: true,
    signedUpPlayer: false,
    legalEnabled: true,
    attach: () => calls.push('attach'),
    stopVoice: () => calls.push('stopVoice'),
    open: () => calls.push('open'),
    updateComposer: () => calls.push('updateComposer'),
    playWelcome: () => calls.push('playWelcome'),
    send: async () => void calls.push('send'),
  } as unknown as LiveBinding;
  let release: (() => void) | undefined;
  const session = new Promise<LiveBinding>((resolve) => (release = () => resolve(real)));
  let requests = 0;
  const live = new DeferredLive({ request: () => (requests++, session) });
  live.attach({} as never);
  assert.equal(live.ready, false);
  assert.deepEqual([live.freeTierEnabled, live.signedUpPlayer, live.legalEnabled], [false, false, false]);
  live.stopVoice();
  live.updateComposer('wei-guagua');
  assert.equal(live.open('wei-guagua', {} as never), undefined);
  live.playWelcome('wei-guagua');
  const sent = live.send('wei-guagua', '你好', {} as never);
  await tick();
  assert.deepEqual(calls, [], 'no call of the session before it exists');
  assert.equal(requests, 2, 'the two actions asked for the session (the sheet shows)');
  release?.();
  await sent;
  await tick();
  assert.deepEqual(calls.sort(), ['playWelcome', 'send']);
  live.bind(real);
  assert.deepEqual(calls.sort(), ['attach', 'playWelcome', 'send']);
  assert.equal(live.ready, true);
  assert.equal(live.freeTierEnabled, true);
  await live.send('wei-guagua', '再来', {} as never);
  assert.equal(requests, 2, 'ready: no waiting any more');
  assert.equal(calls.filter((c) => c === 'send').length, 2);
});

test('a closed sheet means the tapped send never happens (the draft stays)', async () => {
  const calls: string[] = [];
  const live = new DeferredLive({ request: () => Promise.reject(new Error('SESSION_WAIT_CANCELLED')) });
  await live.send('wei-guagua', '你好', {} as never, () => calls.push('accepted'));
  live.playWelcome('wei-guagua');
  await tick();
  assert.deepEqual(calls, []);
});

test('the page makes no write call to get its cards: only the public catalog GET', async () => {
  const seen: string[] = [];
  const api = new ProviderApi(async (input, init) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return Response.json(catalog());
  });
  assert.deepEqual(await api.publicCatalog(), catalog());
  assert.deepEqual(seen, ['GET /api/web/provider/catalog']);
});
