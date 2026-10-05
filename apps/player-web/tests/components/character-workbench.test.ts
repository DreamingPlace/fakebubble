import assert from 'node:assert/strict';
import test from 'node:test';
import { characterForm, editedCharacter, emptyCharacter } from '../../src/features/admin/character-form.ts';
import { characterAdminError, characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import {
  CharacterAdminClient,
  type CharacterDetail,
  type CharacterProfile,
} from '../../src/services/character-admin-api.ts';
import type { AdminMember } from '../../src/services/account-admin-api.ts';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';

// Minimal native-form model; real layout, validation and keyboard behavior are checked in the browser.
class Element extends EventTarget {
  tagName: string;
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  disabled = false;
  checked = false;
  readOnly = false;
  required = false;
  type = '';
  className = '';
  files: File[] | null = null;
  private text = '';
  private val: string | undefined;
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  get value(): string {
    return this.val ?? (this.tagName === 'select' ? (this.children[0]?.value ?? '') : '');
  }
  set value(v: string) {
    this.val = v;
  }
  get childElementCount() {
    return this.children.length;
  }
  append(...nodes: Element[]) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
    this.parent = null;
  }
  replaceChildren(...nodes: Element[]) {
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  contains(node: Element): boolean {
    return this === node || this.children.some((c) => c.contains(node));
  }
  querySelectorAll(selector: string) {
    const tags = selector.split(',');
    return all(this)
      .slice(1)
      .filter((n) => tags.includes(n.tagName));
  }
  reportValidity() {
    assert.ok(!this.querySelectorAll('input,textarea').every((n) => n.disabled), 'validate before disabling form');
    return !this.querySelectorAll('input,textarea').some((n) => !n.disabled && n.required && !n.value);
  }
  fire(kind = 'click') {
    const event = new Event(kind, { cancelable: true });
    this.dispatchEvent(event);
    if (kind === 'input' || kind === 'change') this.parent?.fire(kind);
  }
}
class Input extends Element {
  constructor() {
    super('input');
  }
}
class TextArea extends Element {
  constructor() {
    super('textarea');
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
function dom(t: test.TestContext, beforeRestore: () => void = () => {}) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    HTMLInputElement: Input,
    HTMLTextAreaElement: TextArea,
    document: {
      createElement: (tag: string) =>
        tag === 'input' ? new Input() : tag === 'textarea' ? new TextArea() : new Element(tag),
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => {
    beforeRestore();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
}
function profile(): CharacterProfile {
  const p = emptyCharacter();
  Object.assign(p.template, {
    id: 'jojo',
    name: '测试人物',
    persona: '离线合成人设',
    birthDate: '2000-01-01',
    voice: { profileId: 'synthetic-voice', version: 1, speed: 1.03, messageProbability: 0.17 },
    authorCanon: {
      kind: 'author_canon',
      settings: {
        selfIdentity: { names: ['测试人物', '保留别名'], truthScope: 'fictional_world', representsRealPerson: false },
        basicInfo: { birthDate: '2000-01-01' },
        speechExamples: ['保留样例'],
      },
    },
  });
  p.template.schedule.days[0][0]!.probability = 1 / 3;
  p.presentation = {
    displayName: '合成人物',
    publicDescription: '仅供离线测试',
    welcome: { text: '欢迎', version: 'welcome-v1' },
  };
  return p;
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
function fixture(t: test.TestContext) {
  let cleanup = () => {};
  dom(t, () => cleanup());
  const root = new Element();
  let disposed = false,
    status = '';
  const original = profile(),
    draft = structuredClone(original);
  draft.template.version = 2;
  const detail: CharacterDetail = {
    characterId: 'jojo',
    published: { version: 1, profile: original },
    draft: {
      characterId: 'jojo',
      revision: 3,
      baseVersion: 1,
      profile: draft,
      contentHash: 'a'.repeat(64),
      savedAt: 1,
    },
    previews: [],
    previewAvailable: true,
  };
  let member: AdminMember = {
    id: 'owner',
    role: 'owner',
    label: '合成主管理员',
    email: null,
    createdAt: 1,
    permissions: [],
  };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let respond: ((path: string, body: Record<string, unknown>) => Promise<unknown>) | null = null;
  const client = new CharacterAdminClient(async (path, body) => {
    requests.push({ path, body: structuredClone(body) });
    if (respond) return respond(path, body);
    if (path === 'list')
      return {
        characters: [
          {
            characterId: 'jojo',
            displayName: '合成人物',
            publishedVersion: detail.published?.version ?? null,
            draftRevision: detail.draft?.revision ?? null,
          },
        ],
        deletions: [],
      };
    if (path.endsWith('/detail')) return structuredClone(detail);
    if (path.endsWith('/save')) {
      detail.draft = {
        characterId: 'jojo',
        revision: (detail.draft?.revision ?? 0) + 1,
        baseVersion: detail.published?.version ?? null,
        profile: body.profile as CharacterProfile,
        contentHash: 'b'.repeat(64),
        savedAt: 2,
      };
      return detail.draft;
    }
    if (path.endsWith('/preview'))
      return {
        kind: 'profile-preview',
        externalCalls: false,
        draft: detail.draft,
        published: detail.published?.profile ?? null,
      };
    if (path.endsWith('/material-list')) return [];
    throw Error('unexpected fixture route ' + path);
  });
  const errors: unknown[] = [];
  const wb = characterWorkbench(root as unknown as HTMLElement, {
    api: client,
    member: () => member,
    disposed: () => disposed,
    status: (s) => (status = s),
    run: async (work) => {
      wb.update(true);
      try {
        await work();
      } catch (e) {
        errors.push(e);
        status = characterAdminError(e) ?? String(e);
      } finally {
        wb.update(false);
      }
    },
  });
  const button = (text: string) => {
    const n = all(root).find((n) => n.tagName === 'button' && n.textContent === text);
    assert.ok(n, 'button ' + text);
    return n;
  };
  const input = (label: string) => {
    const row = all(root).find(
      (n) => n.tagName === 'label' && n.children.some((c) => c.tagName === 'span' && c.textContent === label),
    );
    assert.ok(row, 'label ' + label);
    return row.children.find((c) => ['input', 'textarea', 'select'].includes(c.tagName))!;
  };
  const click = async (text: string) => {
    const b = button(text);
    assert.equal(b.disabled, false, 'enabled ' + text);
    b.fire();
    await flush();
  };
  cleanup = () => wb.dispose();
  return {
    root,
    wb,
    detail,
    requests,
    errors,
    button,
    input,
    click,
    status: () => status,
    respond: (fn: typeof respond) => (respond = fn),
    setMember: (next: AdminMember) => {
      member = next;
      wb.update(false);
    },
    member: () => member,
    open: async () => {
      await wb.load();
      await click('打开资料');
    },
    dispose: () => {
      disposed = true;
      wb.dispose();
    },
  };
}

test('complete profile form round-trips approved canon, precise probabilities and optional voice fields without mutating source', (t) => {
  dom(t);
  const root = new Element(),
    base = profile(),
    before = structuredClone(base),
    form = characterForm(
      root as unknown as HTMLElement,
      base,
      false,
      () => {},
      (e) => {
        throw e;
      },
    );
  assert.deepEqual(form.read(), before);
  assert.deepEqual(base, before);
  assert.equal(all(root).find((n) => n.tagName === 'input' && n.value === 'jojo')!.readOnly, true);
  assert.ok(
    !/一周作息|星期日|拆分最后时段|概率 %|时区/.test(root.textContent),
    'web editor never exposes old schedule settings',
  );
  assert.deepEqual(
    form.read().template.schedule,
    base.template.schedule,
    'keep the accepted template compatible without exposing/editing its schedule',
  );
});

test('name/birthday synchronization is narrow; invalid canon never overwrites the original', () => {
  const base = profile(),
    values = {
      id: 'jojo',
      name: '新名称',
      birthDate: '2001-02-03',
      persona: base.template.persona,
      displayName: base.presentation.displayName,
      publicDescription: '',
      welcomeText: '欢迎',
      welcomeVersion: 'welcome-v1',
      canon: JSON.stringify(base.template.authorCanon!.settings),
      schedule: base.template.schedule,
      voice: base.template.voice!,
    };
  const next = editedCharacter(base, values),
    settings = next.template.authorCanon!.settings;
  assert.deepEqual((settings.selfIdentity as { names: string[] }).names, ['测试人物', '保留别名', '新名称']);
  assert.equal((settings.basicInfo as { birthDate: string }).birthDate, '2001-02-03');
  assert.deepEqual(settings.speechExamples, ['保留样例']);
  assert.equal(base.template.name, '测试人物');
  assert.throws(() => editedCharacter(base, { ...values, canon: '[]' }), /JSON/);
});

test('dirty draft blocks navigation; save validates before busy, carries exact CAS and does not publish', async (t) => {
  const f = fixture(t);
  await f.open();
  assert.equal(f.button('放弃本页未保存修改').disabled, true);
  const persona = f.input('基础人设');
  persona.value += ' 本页修改';
  persona.fire('input');
  assert.equal(f.wb.canLeave(), false);
  assert.equal(f.button('返回人物目录').disabled, true);
  await assert.rejects(f.wb.load(), /先保存/);
  assert.equal(f.button('比较已存草稿与正式资料').disabled, true);
  all(f.root)
    .find((n) => n.tagName === 'form')!
    .fire('submit');
  await flush();
  const save = f.requests.find((r) => r.path === 'jojo/save')!;
  assert.equal(save.body.expectedRevision, 3);
  assert.equal((save.body.profile as CharacterProfile).template.version, 2);
  assert.match((save.body.profile as CharacterProfile).template.persona, /本页修改/);
  assert.equal(f.wb.canLeave(), true);
  assert.equal(f.errors.length, 0);
  assert.ok(!f.requests.some((r) => /publish|review-start/.test(r.path)));
});

test('editing a published role without a draft uses next version and null CAS; empty required fields remain local', async (t) => {
  const f = fixture(t);
  f.detail.draft = null;
  await f.open();
  f.input('人设名称').value = '';
  all(f.root)
    .find((n) => n.tagName === 'form')!
    .fire('submit');
  await flush();
  assert.equal(f.requests.filter((r) => r.path.endsWith('/save')).length, 0);
  f.input('人设名称').value = '测试人物';
  all(f.root)
    .find((n) => n.tagName === 'form')!
    .fire('submit');
  await flush();
  const save = f.requests.find((r) => r.path.endsWith('/save'))!;
  assert.equal(save.body.expectedRevision, null);
  assert.equal((save.body.profile as CharacterProfile).template.version, 2);
});

test('scope revocation disables edits, permits abandoning local edits and clears removed read data without changing identity', async (t) => {
  const f = fixture(t);
  await f.open();
  f.input('基础人设').fire('input');
  const member = { ...f.member(), role: 'admin' as const, permissions: ['characters.read:jojo' as const] };
  f.setMember(member);
  assert.equal(f.input('基础人设').disabled, true);
  assert.equal(f.button('保存草稿').disabled, true);
  assert.equal(f.button('放弃本页未保存修改').disabled, false);
  await f.click('放弃本页未保存修改');
  assert.equal(f.wb.canLeave(), true);
  f.setMember({ ...member, permissions: [] });
  assert.equal(f.root.childElementCount, 0);
  assert.equal(f.member().id, 'owner');
  assert.match(f.status(), /账号和会话仍保留/);
});

test('static comparison performs no generation; an ambiguous paid preview freezes and reuses the exact request across navigation', async (t) => {
  const f = fixture(t);
  await f.open();
  await f.click('比较已存草稿与正式资料');
  assert.ok(!f.requests.some((r) => r.path.endsWith('/review-start')));
  f.input('预演输入（不是玩家消息）').value = '离线合成问题';
  f.input('预演输入（不是玩家消息）').fire('input');
  const ack = f.input('我确认发起真实付费文字预演，并已核对当前草稿与输入');
  ack.checked = true;
  ack.fire('input');
  f.respond(async (path) => {
    assert.equal(path, 'jojo/review-start');
    throw Error('lost receipt');
  });
  await f.click('发起付费文字预演');
  assert.equal(f.input('预演输入（不是玩家消息）').disabled, true);
  f.respond(null);
  await f.click('返回人物目录');
  await f.click('打开资料');
  f.respond(async (path) => {
    assert.equal(path, 'jojo/review-start');
    throw new InviteLocalApiError(403, 'ADMIN_PERMISSION_REQUIRED');
  });
  await f.click('按原请求核对预演回执');
  assert.equal(
    f.input('预演输入（不是玩家消息）').disabled,
    true,
    'later denial cannot disprove the earlier unknown receipt',
  );
  assert.equal(f.button('按原请求核对预演回执').disabled, false);
  const calls = f.requests.filter((r) => r.path.endsWith('/review-start'));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[0]!.body.message, '离线合成问题');
});

test('known preview refusal restores inputs, while a discovered queued/UNKNOWN task cannot start another paid request', async (t) => {
  const f = fixture(t);
  await f.open();
  f.input('预演输入（不是玩家消息）').value = '合成';
  f.input('我确认发起真实付费文字预演，并已核对当前草稿与输入').checked = true;
  f.input('预演输入（不是玩家消息）').fire('input');
  f.respond(async () => {
    throw new InviteLocalApiError(409, 'DRAFT_CONFLICT');
  });
  await f.click('发起付费文字预演');
  assert.equal(f.input('预演输入（不是玩家消息）').disabled, false);
  assert.match(f.status(), /其他页面修改/);
  f.respond(null);
  f.detail.previews = [
    {
      previewId: 'old',
      characterId: 'jojo',
      draftRevision: 3,
      profileHash: f.detail.draft!.contentHash,
      status: 'queued',
      errorCode: 'PROVIDER_UNKNOWN',
      result: null,
    },
  ];
  await f.click('刷新预演状态');
  f.input('预演输入（不是玩家消息）').value = '不能重发';
  f.input('我确认发起真实付费文字预演，并已核对当前草稿与输入').checked = true;
  f.input('预演输入（不是玩家消息）').fire('input');
  assert.equal(f.button('发起付费文字预演').disabled, true);
});

test('publication requires a successful current proof plus explicit review, then preserves unknown exact intent', async (t) => {
  const f = fixture(t);
  await f.open();
  assert.equal(f.button('确认发布此版本').disabled, true);
  f.detail.previews = [
    {
      previewId: 'proof',
      characterId: 'jojo',
      draftRevision: 3,
      profileHash: f.detail.draft!.contentHash,
      status: 'succeeded',
      errorCode: null,
      result: { reply: { bubbles: [{ text: '合成结果 <script>不会执行</script>' }] } },
    },
  ];
  await f.click('重新读取资料');
  assert.ok(f.root.textContent.includes('合成结果 <script>不会执行</script>'));
  assert.equal(f.button('确认发布此版本').disabled, true);
  const ack = f.input('我已查看资料差异和该预演结果，确认将本版本发布给玩家');
  ack.checked = true;
  ack.fire('change');
  f.respond(async () => {
    throw Error('lost publication response');
  });
  await f.click('确认发布此版本');
  await f.click('按原请求核对发布回执');
  const calls = f.requests.filter((r) => r.path.endsWith('/publish'));
  assert.deepEqual(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[0]!.body.previewId, 'proof');
});

test('file selection never uploads automatically; explicit rights and button are required, late completion after disposal leaves no UI', async (t) => {
  const f = fixture(t);
  await f.open();
  const material = {
    materialId: 'mat',
    draftRevision: 3,
    profileHash: f.detail.draft!.contentHash,
    approved: false,
    createdAt: 1,
    voice: { profileId: 'synthetic', version: 1, referenceId: 'synthetic', model: 's2.1-pro' },
    assets: [],
  };
  f.respond(async () => [material]);
  await f.click('读取已有成品版本');
  const file = f.input('选择欢迎成品 WAV');
  file.files = [new File(['offline synthetic not real audio'], 'fixture.wav')];
  file.fire('change');
  await flush();
  assert.ok(!f.requests.some((r) => r.path.endsWith('/material-upload')));
  assert.equal(f.button('上传所选欢迎成品').disabled, true);
  const rights = f.input('这是我有权使用的成品，不是待克隆的原始声音样本');
  rights.checked = true;
  rights.fire('change');
  let done!: (v: unknown) => void;
  f.respond(() => new Promise((r) => (done = r)));
  await f.click('上传所选欢迎成品');
  assert.equal(f.requests.at(-1)!.path, 'jojo/material-upload');
  f.dispose();
  done({});
  await flush();
  assert.equal(f.root.childElementCount, 0);
});

test('irreversible deletion requires current impact, exact typed ID and checkbox; ambiguous retry never changes intent', async (t) => {
  const f = fixture(t);
  await f.open();
  f.respond(async () => ({
    characterId: 'jojo',
    version: 1,
    previewHash: 'impact',
    conversations: 7,
    messages: 9,
    pendingOperations: 1,
  }));
  await f.click('获取删除影响');
  assert.match(f.root.textContent, /7 个私人会话 · 9 条消息 · 1 个未终结任务/);
  assert.equal(f.button('确认永久删除此人物及全部旧聊天').disabled, true);
  const typed = f.input('输入人物 ID jojo 确认删除'),
    ack = f.input('我确认删除此人物和其全部旧聊天，不能恢复');
  typed.value = 'other';
  ack.checked = true;
  typed.fire('input');
  assert.equal(f.button('确认永久删除此人物及全部旧聊天').disabled, true);
  typed.value = 'jojo';
  typed.fire('input');
  f.respond(async () => {
    throw Error('lost deletion receipt');
  });
  await f.click('确认永久删除此人物及全部旧聊天');
  await f.click('按原请求核对删除回执');
  const calls = f.requests.filter((r) => r.path.endsWith('/delete-start'));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[0]!.body.previewHash, 'impact');
});

test('a late role read after disposal never reconstructs private profile UI', async (t) => {
  const f = fixture(t);
  await f.wb.load();
  let done!: (v: unknown) => void;
  f.respond(() => new Promise((r) => (done = r)));
  await f.click('打开资料');
  f.dispose();
  done(f.detail);
  await flush();
  assert.equal(f.root.childElementCount, 0);
});

test('directory metadata disappears when read authority is removed, without destroying the account', async (t) => {
  const f = fixture(t);
  await f.wb.load();
  assert.match(f.root.textContent, /合成人物/);
  f.setMember({ ...f.member(), role: 'admin', permissions: [] });
  assert.ok(!f.root.textContent.includes('合成人物'));
  assert.equal(f.member().id, 'owner');
});
