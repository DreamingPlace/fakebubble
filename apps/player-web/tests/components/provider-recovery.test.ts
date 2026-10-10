import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { errorText } from '../../src/features/prototype/provider-binding.ts';
import { providerStartFailure, renderProviderStartError } from '../../src/features/prototype/provider-start-error.ts';
import {
  openRecoveryEntry,
  openRecoveryManage,
  recoveryCopy,
  showRecoveryCode,
} from '../../src/features/prototype/recovery-code.ts';
import { webProviderHTTPError } from '../../../../apps/server/platform/web-provider-http-error.ts';
import { RetryAfterError } from '../../../../packages/domain/errors.ts';

type Listener = (event: { preventDefault(): void }) => void;
class Node {
  className = '';
  textContent = '';
  value = '';
  disabled = false;
  type = '';
  children: Node[] = [];
  open = false;
  removed = false;
  html = '';
  nodes = new Map<string, Node>();
  listeners = new Map<string, Listener[]>();
  attributes = new Map<string, string>();
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...children: Node[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Node[]) {
    this.children = children;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  remove() {
    this.removed = true;
  }
  addEventListener(name: string, listener: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  querySelector(selector: string) {
    let node = this.nodes.get(selector);
    if (!node) this.nodes.set(selector, (node = new Node()));
    return node;
  }
  fire(name: string) {
    let prevented = false;
    for (const listener of this.listeners.get(name) ?? [])
      listener({
        preventDefault() {
          prevented = true;
        },
      });
    return prevented;
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function dom(t: test.TestContext) {
  const created: Node[] = [];
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };
  const body = new Node();
  const writes: string[] = [];
  const copied: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body,
      cookie: '',
      createElement: () => {
        const node = new Node();
        created.push(node);
        return node;
      },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => void copied.push(text) } },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: (key: string) => writes.push(key), getItem: () => null },
  });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  });
  return { body, created, writes, copied };
}
const CODE = 'R'.repeat(43);
const NEXT = 'N'.repeat(43);

test('the recovery code is shown once with the agreed copy, can be copied, and is never stored', async (t) => {
  const d = dom(t);
  let saved = 0;
  const sheet = showRecoveryCode(CODE, () => saved++) as unknown as Node;
  assert.equal(recoveryCopy.notice, '这是你的恢复码。换浏览器、清除数据后，用它找回你的聊天。只显示这一次，请保存好。');
  assert.equal(recoveryCopy.saved, '我已保存');
  assert.match(sheet.html, /这是你的恢复码。换浏览器、清除数据后，用它找回你的聊天。只显示这一次，请保存好。/);
  assert.match(sheet.html, /我已保存/);
  assert.equal(sheet.querySelector('.recovery-code').textContent, CODE);
  assert.equal(sheet.open, true);
  assert.equal(sheet.fire('cancel'), true, 'Escape cannot dismiss the one-time sheet');
  sheet.querySelector('.recovery-copy').fire('click');
  await flush();
  assert.deepEqual(d.copied, [CODE]);
  assert.equal(sheet.querySelector('.recovery-state').textContent, recoveryCopy.copied);
  sheet.querySelector('form').fire('submit');
  assert.equal(saved, 1);
  assert.equal(sheet.removed, true);
  assert.equal(sheet.querySelector('.recovery-code').textContent, '', 'the code leaves the DOM on confirm');
  assert.deepEqual(d.writes, [], 'nothing was written to localStorage');
  assert.equal((globalThis.document as unknown as { cookie: string }).cookie, '');
});

test('entering a recovery code restores the player, shows the NEW code once, and reuses the request id on retry', async (t) => {
  const d = dom(t);
  const calls: { secret: string; requestId: string }[] = [];
  let outcome: 'network' | 'ok' | 'rejected' = 'network';
  const api = {
    regenerateRecoveryCode: async () => NEXT,
    recoverWithRecoveryCode: async (input: { secret: string; requestId: string }) => {
      calls.push(input);
      if (outcome === 'network') throw new ProviderApiError(0, 'NETWORK');
      if (outcome === 'rejected') throw new ProviderApiError(409, 'WEB_INVITE_RECOVERY_UNAVAILABLE');
      return NEXT;
    },
  };
  let restored = 0,
    ids = 0;
  const entry = openRecoveryEntry(
    api,
    () => restored++,
    () => `req-${++ids}`,
  ) as unknown as Node;
  const input = entry.querySelector('input'),
    status = entry.querySelector('.recovery-state');
  input.value = 'too short';
  entry.querySelector('form').fire('submit');
  assert.equal(calls.length, 0);
  assert.equal(status.textContent, recoveryCopy.entryInvalid);
  input.value = ` ${CODE} `;
  entry.querySelector('form').fire('submit');
  await flush();
  assert.equal(status.textContent, recoveryCopy.entryNetwork);
  entry.querySelector('form').fire('submit');
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0]!.requestId,
    calls[1]!.requestId,
    'an answered-but-lost attempt replays instead of burning the code',
  );
  outcome = 'rejected';
  input.value = 'W'.repeat(43);
  entry.querySelector('form').fire('submit');
  await flush();
  assert.equal(status.textContent, recoveryCopy.entryInvalid, 'one neutral message for wrong or used codes');
  assert.equal(restored, 0);
  outcome = 'ok';
  input.value = CODE;
  entry.querySelector('form').fire('submit');
  await flush();
  assert.equal(entry.removed, true);
  const sheet = d.body.children.at(-1)!;
  assert.equal(sheet.querySelector('.recovery-code').textContent, NEXT);
  assert.equal(restored, 0, 'the page only reloads after "我已保存"');
  sheet.querySelector('form').fire('submit');
  assert.equal(restored, 1);
  assert.deepEqual(d.writes, []);
});

test('regenerating shows the replacement once and reports a failure without exposing any code', async (t) => {
  const d = dom(t);
  let fail = true;
  const said: string[] = [];
  const api = {
    recoverWithRecoveryCode: async () => CODE,
    regenerateRecoveryCode: async () => {
      if (fail) throw new ProviderApiError(500, 'INTERNAL_ERROR');
      return NEXT;
    },
  };
  const manage = openRecoveryManage(api, (message) => said.push(message)) as unknown as Node;
  assert.match(manage.html, /重新生成恢复码/);
  assert.match(manage.html, /旧恢复码立即失效/);
  manage.querySelector('form').fire('submit');
  await flush();
  assert.deepEqual(said, [recoveryCopy.regenerateFailed]);
  assert.equal(manage.removed, false);
  fail = false;
  manage.querySelector('form').fire('submit');
  await flush();
  assert.equal(manage.removed, true);
  assert.equal(d.body.children.at(-1)!.querySelector('.recovery-code').textContent, NEXT);
});

// Part 11f replaced the "访问会话需要恢复" dead-end page: the 我有恢复码 link now lives on the signed-out first page
// (covered in account-sheet.test.ts), and no error page carries it any more.
test('no error page carries the recovery entry any more; a dead session is the signed-out first page', (t) => {
  dom(t);
  const api = { recoverWithRecoveryCode: async () => CODE, regenerateRecoveryCode: async () => NEXT };
  assert.equal(providerStartFailure(new ProviderApiError(401, 'SESSION_EXPIRED')).title, '你还没有登录');
  const network = new Node();
  renderProviderStartError(network as unknown as HTMLElement, new Error('offline'), () => {}, api);
  assert.equal(network.children[0]!.children.length, 3);
  const guest = new Node();
  renderProviderStartError(
    guest as unknown as HTMLElement,
    new ProviderApiError(401, 'GUEST_SESSION_EXPIRED'),
    () => {},
    api,
  );
  assert.equal(guest.children[0]!.children.length, 3);
});

test('the daily limit is a friendly in-app line, not an error page, and the API carries retryAfterMs', async () => {
  assert.equal(errorText.WEB_DAILY_LIMIT_REACHED, '今天聊得够多啦，明天再来找我吧～');
  const api = new ProviderApi(async () =>
    Response.json(
      { error: { code: 'WEB_DAILY_LIMIT_REACHED', requestId: null, retryAfterMs: 3_600_000 } },
      { status: 429 },
    ),
  );
  await assert.rejects(
    () => api.submit({ requestId: 'r', characterId: 'wei-guagua', text: '你好', delivery: 'voice' }),
    (error: unknown) =>
      error instanceof ProviderApiError &&
      error.status === 429 &&
      error.code === 'WEB_DAILY_LIMIT_REACHED' &&
      error.retryAfterMs === 3_600_000,
  );
});

test('the server maps the daily limit to a known 429 code with retryAfterMs, other WEB_ codes stay redacted', () => {
  const limit = webProviderHTTPError(new RetryAfterError('WEB_DAILY_LIMIT_REACHED', 123_000));
  assert.equal(limit.status, 429);
  assert.deepEqual(limit.body, { error: { code: 'WEB_DAILY_LIMIT_REACHED', requestId: null, retryAfterMs: 123_000 } });
  assert.equal(webProviderHTTPError(new Error('x')).body.error.retryAfterMs, null);
});
