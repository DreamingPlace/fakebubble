import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountAdminApi } from '../../src/services/account-admin-api.ts';
import { adminConnection, isInterrupted } from '../../src/services/admin-connection.ts';
import { clearAllKeptEdits, editKeeper, overlayEdits } from '../../src/features/admin/ui/edit-keeper.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CSRF = 'c'.repeat(64);
const session = {
  csrf: CSRF,
  expiresAt: 1,
  emailDeliveryAvailable: false,
  member: { id: 'm', label: 'o', role: 'owner', email: null, createdAt: 1, permissions: [] },
};
/** A console that was signed in, then met `fault` on every call after the sign-in. */
async function signedIn(fault: () => Response | Promise<Response> | 'network' | null) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const path = String(input).replace('/api/web/provider/admin', '');
    calls.push(path);
    const faulted = fault();
    if (faulted === 'network') throw new TypeError('Failed to fetch');
    if (faulted) return faulted;
    return path === '/session' ? json(200, session) : json(200, { saved: true });
  }) as typeof fetch;
  const api = new AccountAdminApi(fetcher);
  adminConnection.reset();
  const was = fault;
  void was;
  return { api, calls };
}
let faultOn: Response | 'network' | null = null;
const challenge = () =>
  new Response('<!doctype html><title>Just a moment...</title>', {
    status: 403,
    headers: { 'content-type': 'text/html' },
  });

test('59: an HTML challenge, a 401 and a network error are interruptions (not failed saves); the edits are never touched', async () => {
  for (const [name, make] of [
    ['an HTML challenge page', () => challenge()],
    ['a 401 from an expired session', () => json(401, { error: { code: 'ADMIN_UNAUTHORIZED' } })],
    ['a network error', () => 'network' as const],
  ] as const) {
    faultOn = null;
    const { api } = await signedIn(() =>
      faultOn === null ? null : faultOn === 'network' ? 'network' : faultOn.clone(),
    );
    await api.restore();
    adminConnection.reset();
    const states: string[] = [];
    adminConnection.on((state) => states.push(state));
    faultOn = make();
    await assert.rejects(
      () => api.characters.save('jojo', 1, { template: {}, presentation: {} } as never),
      (error: unknown) => isInterrupted(error),
      name,
    );
    assert.deepEqual(states, ['interrupted'], `${name}: the connection line goes up once`);
    assert.equal(adminConnection.state, 'interrupted');
    assert.equal(
      adminConnection.writePending,
      true,
      `${name}: a SAVE was interrupted, so the line says the edits are kept`,
    );
    // the editor registered a retry: it runs once, when the API answers again
    let sent = 0;
    adminConnection.retryAfterReauth('workbench-save:jojo', () => void (sent += 1));
    adminConnection.retryAfterReauth('workbench-save:jojo', () => void (sent += 1));
    assert.equal(sent, 0);
    faultOn = null;
    await api.restore();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(sent, 1, `${name}: after re-authentication the save is sent again, once`);
    assert.deepEqual(states, ['interrupted', 'ok']);
    assert.equal(adminConnection.state, 'ok');
  }
});

test('59: a refusal by the API itself (a missing permission) is an ordinary error; before any sign-in nothing is "interrupted"', async () => {
  faultOn = null;
  const { api } = await signedIn(() => (faultOn === null ? null : faultOn === 'network' ? 'network' : faultOn.clone()));
  adminConnection.reset();
  // never signed in: a challenge page raises no connection line (the Access notice handles that case)
  faultOn = challenge();
  await assert.rejects(
    () => api.restore(),
    (error: unknown) => isInterrupted(error),
  );
  assert.equal(adminConnection.state, 'ok', 'no session yet: the page shows its Access notice instead');
  faultOn = null;
  await api.restore();
  faultOn = json(403, { error: { code: 'ADMIN_PERMISSION_REQUIRED' } });
  await assert.rejects(
    () => api.characters.save('jojo', 1, {} as never),
    (error: { status?: number; code?: string }) =>
      !isInterrupted(error) && error.status === 403 && error.code === 'ADMIN_PERMISSION_REQUIRED',
  );
  assert.equal(adminConnection.state, 'ok');
});

// ---- the kept edits -------------------------------------------------------------------------------------------------------------
function storage() {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
  return map;
}

test('59: kept edits are keyed by page, character, section and revision; the newest survives a moved revision; a save clears them', () => {
  const map = storage();
  const at = (revision: number | null, character = 'jojo') =>
    editKeeper<{ n: number }>({ page: 'characters', character, revision });
  at(3).put({ n: 1 }, 4);
  assert.ok([...map.keys()].every((key) => key.startsWith('fb-admin-edits:v1:characters:jojo::')));
  assert.equal(at(3).find()?.changes, 4);
  // another draft revision of the same character: the newest buffer is offered (the restore lays it over the current draft)
  assert.deepEqual(at(5).find()?.value, { n: 1 });
  assert.equal(at(5, 'chen-jimi').find(), null, 'another character never sees it');
  for (const start = Date.now(); Date.now() === start; );
  at(5).put({ n: 2 });
  assert.deepEqual(at(9).find()?.value, { n: 2 });
  assert.ok(map.size > 0);
  at(9).clear();
  assert.equal(at(3).find(), null, 'a successful save removes every buffer of the character');
  assert.equal(map.size, 0);
  // a buffer older than 30 days is not offered
  map.set(
    'fb-admin-edits:v1:characters:old::1',
    JSON.stringify({ value: 1, at: Date.now() - 31 * 24 * 3600_000, revision: 1, changes: 1 }),
  );
  assert.equal(editKeeper({ page: 'characters', character: 'old', revision: 1 }).find(), null);
});

test('59: sign-out removes every kept edit; a browser that refuses storage keeps nothing and breaks nothing', () => {
  const map = storage();
  editKeeper({ page: 'cast', character: 'doc', revision: 1 }).put({ a: 1 });
  editKeeper({ page: 'memes', character: 'library', revision: null }).put({ b: 2 });
  assert.equal(map.size, 2);
  clearAllKeptEdits();
  assert.equal(map.size, 0);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
    key: () => null,
    length: 0,
  };
  const keeper = editKeeper({ page: 'cast', character: 'doc', revision: 1 });
  assert.equal(keeper.put({ a: 1 }), false);
  assert.equal(keeper.find(), null);
  keeper.clear();
});

test('59: restoring onto a draft that moved on lays over only what the owner changed', () => {
  const base = {
    template: { persona: 'A', authorCanon: { settings: { speechStyle: 's', interests: ['x'] } } },
    presentation: { name: 'n' },
  };
  const edited = structuredClone(base);
  edited.template.authorCanon.settings.speechStyle = 's+';
  const current = structuredClone(base);
  current.template.persona = 'A (someone else changed it)';
  current.template.authorCanon.settings.interests = ['x', 'y'];
  const result = overlayEdits(current, base, edited);
  assert.equal(result.template.authorCanon.settings.speechStyle, 's+', "the owner's change is back");
  assert.equal(result.template.persona, 'A (someone else changed it)', 'the newer change of the draft is kept');
  assert.deepEqual(result.template.authorCanon.settings.interests, ['x', 'y']);
  // nothing changed by the owner: the draft as it is now
  assert.deepEqual(overlayEdits(current, base, structuredClone(base)), current);
});
