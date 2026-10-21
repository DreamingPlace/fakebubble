import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { errorText } from '../../src/features/prototype/provider-binding.ts';
import { providerStartFailure, renderProviderStartError } from '../../src/features/prototype/provider-start-error.ts';
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
// A dead session is the signed-out first page, never an error page; a network failure keeps the three-part error page.
test('a dead session is the signed-out first page, not an error page', (t) => {
  dom(t);
  const api = {};
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
