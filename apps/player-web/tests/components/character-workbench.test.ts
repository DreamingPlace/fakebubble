// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { characterForm, editedCharacter, emptyCharacter } from '../../src/features/admin/character-form.ts';
import { dateTimeText } from '../../src/features/admin/system-format.ts';
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
    welcomes: [{ id: 'welcome-v1', text: '欢迎', weight: 100 }],
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

// Part 24b-6 (required): 说话方式 / 经历 / 其余设定 are structured editors over the existing authorCanon.settings keys. Opening a role and
// saving without an edit must hand back a template deep-equal to the input: same keys in the same order, nothing dropped, no type changed.
test('24b-6 structured editors: open → save without edits produces a template deep-equal to the input (order, keys and types kept)', (t) => {
  dom(t);
  const base = profile();
  base.template.authorCanon = {
    kind: 'author_canon',
    settings: {
      selfIdentity: { names: ['测试人物', '保留别名'], truthScope: 'fictional_world', representsRealPerson: false },
      speechStyle: ['温柔', '爱用“嗯”'],
      basicInfo: { birthDate: '2000-01-01' },
      dialogueStyle: '短句，不爱解释',
      background: [{ title: '小时候', text: '住在海边' }, '后来搬了家'],
      dialogueExamples: [
        { situation: '日常聊天', player: '你好', reply: ['嗯？', '你好呀'] },
        { player: '吃了吗', reply: [] },
      ],
      speechExamples: ['保留样例'],
      hobbies: { 爱好: ['画画'], 宠物: null },
    },
  } as never;
  const before = structuredClone(base);
  const form = characterForm(
    new Element() as unknown as HTMLElement,
    base,
    false,
    () => {},
    (e) => {
      throw e;
    },
  );
  const saved = form.read();
  assert.deepEqual(saved.template, before.template);
  assert.equal(
    JSON.stringify(saved.template.authorCanon),
    JSON.stringify(before.template.authorCanon),
    "byte for byte, so the key order is the input's too",
  );
  assert.deepEqual(base, before, 'the source is not mutated');
  assert.deepEqual(
    form.panes.map((pane) => pane.label),
    ['身份与展示', '欢迎内容', '性格', '说话方式', '经历', '其余设定', '声音'],
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
      welcomes: [{ id: 'welcome-v1', text: '欢迎', weight: 100 }],
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
  // Part 24m (named): only a field that really differs is an unsaved change, so the edit changes the value.
  const persona = f.input('基础人设');
  persona.value = `${persona.value}改`;
  persona.fire('input');
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

// Part 35 (named exception): the single-preview panel was deleted. This test keeps its first half, the invariant that is not about the
// panel (the static comparison sends no generation request); the paid-preview freeze half went with the panel.
test('static comparison performs no generation', async (t) => {
  const f = fixture(t);
  await f.open();
  await f.click('比较已存草稿与正式资料');
  assert.ok(!f.requests.some((r) => r.path.endsWith('/review-start')));
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
  // Part 35 (named exception): the reply text of the proof was shown by the deleted single-preview panel; 发布 lists the proof by time
  // and result, which is what the rest of this test uses.
  assert.equal(f.button('确认发布此版本').disabled, true);
  const ack = f.input('我已查看资料差异和该预演结果，确认将本版本发布给玩家');
  ack.checked = true;
  ack.fire('change');
  // Part 30b (named exception): 发布 now reads the slots first and shows a failed read instead of swallowing it, so only the
  // publish answer is lost here; take-list answers a character with no slots. The invariant under test (the lost answer is
  // re-sent as the exact same request) is unchanged.
  f.respond(async (path) => {
    if (path.endsWith('/take-list')) return takeView({ slots: [], ready: true });
    throw Error('lost publication response');
  });
  await f.click('确认发布此版本');
  await f.click('按原请求核对发布回执');
  const calls = f.requests.filter((r) => r.path.endsWith('/publish'));
  assert.deepEqual(calls[0]!.body, calls[1]!.body);
  assert.equal(calls[0]!.body.previewId, 'proof');
});

/** Part 30: the answer of take-list for a character with one empty welcome slot. */
const takeView = (over: Record<string, unknown> = {}) => ({
  voice: { referenceId: 'ref-1', model: 'drama-3', url: 'https://fish.audio/m/ref-1', speed: 1 },
  footerRequired: false,
  speechAvailable: false,
  directionAvailable: false,
  ready: false,
  slots: [
    {
      slotKey: 'line:a',
      kind: 'welcome',
      lineId: 'a',
      text: '你好呀',
      takes: [],
      selectedTakeId: null,
      approved: false,
      issue: null,
    },
  ],
  ...over,
});

test('file selection never uploads automatically; explicit rights and button are required, late completion after disposal leaves no UI', async (t) => {
  // Part 30 (named exception): the 素材版本 list is gone, so the slot comes from take-list and the upload goes to take-upload; the
  // invariant under test is unchanged (choosing a file sends nothing; the rights tick and the 上传 button do).
  const f = fixture(t);
  await f.open();
  f.respond(async () => takeView());
  await f.click('读取成品');
  const file = f.input('选择欢迎 1 WAV');
  file.files = [new File(['offline synthetic not real audio'], 'fixture.wav')];
  file.fire('change');
  await flush();
  assert.ok(!f.requests.some((r) => r.path.endsWith('/take-upload')));
  assert.equal(f.button('上传').disabled, true);
  const rights = f.input('这是我有权使用的成品，不是待克隆的原始声音样本');
  rights.checked = true;
  rights.fire('change');
  let done!: (v: unknown) => void;
  f.respond(() => new Promise((r) => (done = r)));
  await f.click('上传');
  assert.equal(f.requests.at(-1)!.path, 'jojo/take-upload');
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

test('the 声音 tab has no 素材版本 and no pin: a new take follows the site voice model', async (t) => {
  // Part 30 (named exception, replaces the Part 29 "new material / pin" test): a 素材版本 is no longer on the screen, every take is
  // generated with the binding that follows the site voice model, so there is nothing to prepare and nothing to pin. The page says
  // which model will speak (from take-list) and offers 生成 per slot.
  const f = fixture(t);
  f.detail.speech = {
    available: true,
    hasVoice: true,
    voice: { referenceId: 'ref-1', profileId: 'jojo', version: 1, speed: 1, derived: true },
    siteModel: 'drama-3',
  };
  await f.open();
  f.respond(async (path) =>
    path.endsWith('/take-estimate') ? { ok: false, reason: 'PRICE_MISSING' } : takeView({ speechAvailable: true }),
  );
  await f.click('读取成品');
  assert.match(f.root.textContent, /将用 drama-3 朗读/);
  assert.doesNotMatch(f.root.textContent, /素材版本|准备新素材版本|固定使用/);
  assert.equal(f.requests.filter((r) => r.path.endsWith('/material-prepare')).length, 0);
});
