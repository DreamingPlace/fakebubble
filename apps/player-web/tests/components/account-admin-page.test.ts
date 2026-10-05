import assert from 'node:assert/strict';
import test from 'node:test';
import { startAccountAdminPage } from '../../src/features/admin/account-admin-page.ts';
import { AccountAdminApi, type AccountAdminSession, type AdminPermission } from '../../src/services/account-admin-api.ts';
import { CharacterAdminClient } from '../../src/services/character-admin-api.ts';
import { permissionEditor } from '../../src/features/admin/permission-editor.ts';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';

class ElementStub extends EventTarget {
  value = ''; textContent = ''; innerHTML = ''; hidden = false; disabled = false; checked = false; type = ''; className = '';
  dataset: Record<string,string> = {}; children: ElementStub[] = []; attributes = new Map<string,string>();
  focus() {} setAttribute(key: string, value: string) { this.attributes.set(key,value); } removeAttribute(key: string) { this.attributes.delete(key); }
  append(...children: ElementStub[]) { this.children.push(...children); }
  replaceChildren(...children: ElementStub[]) { this.children = children; this.innerHTML = ''; }
  fire(event = 'click') { this.dispatchEvent(new Event(event, { cancelable: true })); }
}
class RootStub extends ElementStub {
  nodes = new Map<string,ElementStub>();
  querySelector(selector: string): ElementStub {
    let node = this.nodes.get(selector);
    if (!node) {
      node = new ElementStub();
      const page = /data-page="([^"]+)"/.exec(selector), panel = /data-panel="([^"]+)"/.exec(selector);
      if (page) node.dataset.page = page[1]!; if (panel) node.dataset.panel = panel[1]!;
      this.nodes.set(selector,node);
    }
    return node;
  }
  querySelectorAll(selector: string) {
    if (selector === '[data-panel]') return ['login','token','reset','account','invites','characters','members'].map(p => this.querySelector(`[data-panel="${p}"]`));
    if (selector === '[data-page]' || selector === '.admin-nav [data-page]') return ['login','token','reset','account','invites','characters','members'].map(p => this.querySelector(`[data-page="${p}"]`));
    if (selector.startsWith('input[type=')) return ['password','token','bind-code','bind-password','reset-code','reset-password'].map(p => this.querySelector(`#admin-${p}`));
    return [...this.nodes].filter(([key]) => key.includes('button') || key.startsWith('#')).map(([,value]) => value);
  }
}
const descendants=(node:ElementStub):ElementStub[]=>[node,...node.children.flatMap(descendants)];
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const active = (permissions: AdminPermission[] = ['invites.issue'], email: string | null = null): AccountAdminSession => ({
  csrf: 'a'.repeat(64), expiresAt: 4_000_000_000_000, emailDeliveryAvailable: false,
  member: { id: 'admin-1', role: 'admin', label: '合成管理员', email, createdAt: 1, permissions },
});
function setup(t: test.TestContext, state: AccountAdminSession | null = null) {
  const root = new RootStub(), originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new ElementStub(), createTextNode: (value: string) => {
    const node = new ElementStub(); node.textContent = value; return node;
  } } });
  let logouts = 0, issues = 0;
  const port = {
    restore: async () => { if (!state) throw new InviteLocalApiError(401, 'ADMIN_UNAUTHORIZED'); return state; },
    login: async (_token: string) => state = active(),
    emailLogin: async (_email: string, _password: string) => state = active(['invites.issue'],'admin@example.com'),
    logout: async () => { logouts++; state = null; },
    bindStart: async () => ({ challengeId: 'bind', expiresAt: 1000 }), bindFinish: async () => active(['invites.issue'],'admin@example.com'),
    resetStart: async () => ({ challengeId: 'reset', expiresAt: 1000 }), resetFinish: async () => {},
    members: async () => ({ members: [active().member], grants: [] }),
    issueMember: async () => ({ memberId: 'new', grantId: 'new-grant', token: 'b'.repeat(43), duplicate: false }),
    setPermissions: async (_id: string, permissions: AdminPermission[], _expected?:AdminPermission[]) => active(permissions).member,
    revokeCredential: async () => {},
    issue: async () => { issues++; return { inviteId: 'invite', code: 'c'.repeat(43), duplicate: false }; },
    revokeInvite: async (_kind:'code'|'grant',_id:string) => {},
    inviteRecords: async ():ReturnType<AccountAdminApi['inviteRecords']> => ({records:[],next:null}),
    characters:new CharacterAdminClient(async()=>({characters:[{characterId:'jojo',displayName:'合成人物',publishedVersion:1,draftRevision:null}],deletions:[]})),
  };
  let dispose: (() => void) | undefined;
  t.after(() => {
    dispose?.();
    if (originalWindow) Object.defineProperty(globalThis,'window',originalWindow); else Reflect.deleteProperty(globalThis,'window');
    if (originalDocument) Object.defineProperty(globalThis,'document',originalDocument); else Reflect.deleteProperty(globalThis,'document');
  });
  return { root, port, mount: () => { dispose = startAccountAdminPage(root as unknown as HTMLElement,port); },
    dispose: () => dispose?.(), logouts: () => logouts, issues: () => issues };
}

test('administrator opens on email login; one-time option remains separate, no public registration or social login', async t => {
  const f = setup(t); f.mount(); await flush();
  assert.equal(f.root.querySelector('[data-panel="login"]').hidden, false);
  assert.equal(f.root.querySelector('[data-panel="token"]').hidden, true);
  assert.match(f.root.innerHTML, /autocomplete="username"/);
  assert.ok(!/Google|Apple|注册/.test(f.root.innerHTML));
  f.root.querySelector('[data-page="token"]').fire();
  assert.equal(f.root.querySelector('[data-panel="token"]').hidden, false);
});

test('category editor preserves existing narrow grants and sends a compare-and-swap precondition', async t => {
  const owner = active(); owner.member.role = 'owner'; const f = setup(t, owner);
  const member = active(['invites.issue', 'characters.read:jojo', 'characters.edit:jojo']).member;
  f.port.members = async () => ({ members: [member], grants: [] });
  let saved: AdminPermission[] = [],expected:AdminPermission[]|undefined;
  f.port.setPermissions = async (_id, permissions, before) => { saved = permissions;expected=before;return member; };
  f.mount(); await flush(); f.root.querySelector('[data-page="members"]').fire(); await flush();
  const item = f.root.querySelector('#admin-members-list').children[0]!;
  const save = item.children.find(child => child.textContent.startsWith('保存 '))!;
  save.fire(); await flush();
  assert.deepEqual(saved, ['characters.edit:jojo', 'characters.read:jojo', 'invites.issue']);
  assert.deepEqual(expected,member.permissions);
});

test('one-time login immediately allows management; unavailable email delivery cannot force registration', async t => {
  const f = setup(t); f.mount(); await flush();
  f.root.querySelector('[data-page="token"]').fire(); f.root.querySelector('#admin-token').value = 'b'.repeat(43);
  f.root.querySelector('#admin-token-login').fire('submit'); await flush();
  assert.equal(f.root.querySelector('#admin-token').value, '');
  assert.equal(f.root.querySelector('[data-panel="account"]').hidden, false);
  assert.equal(f.root.querySelector('#admin-bind-start button').disabled, true);
  f.root.querySelector('[data-page="invites"]').fire();
  assert.equal(f.root.querySelector('#admin-invite-issue').hidden, false);
  f.root.querySelector('#admin-batch').value = 'offline'; f.root.querySelector('#admin-deadline').value = '2099-01-01T12:00';
  f.root.querySelector('#admin-invite-issue').fire('submit'); f.root.querySelector('#admin-invite-issue').fire('submit'); await flush();
  assert.equal(f.issues(), 1); assert.equal(f.logouts(), 0);
  f.dispose(); assert.equal(f.root.querySelector('#admin-secret-value').textContent, '');
});

test('all permissions removed keeps account/session UI and does not call logout', async t => {
  const f = setup(t, active([], 'admin@example.com')); f.mount(); await flush();
  assert.equal(f.root.querySelector('.admin-nav').hidden, false);
  assert.equal(f.root.querySelector('#admin-invite-issue').hidden, true);
  assert.equal(f.root.querySelector('#admin-invite-revoke').hidden, true);
  assert.equal(f.root.querySelector('#admin-no-permissions').hidden, false);
  f.root.querySelector('[data-page="account"]').fire();
  assert.equal(f.root.querySelector('[data-panel="account"]').hidden, false); assert.equal(f.logouts(), 0);
});

test('permission rejection refreshes capabilities without logging out; ambiguous issuance cannot silently repeat', async t => {
  const f = setup(t, active(['invites.issue'], 'admin@example.com'));
  let calls = 0;
  f.port.issue = async () => { calls++; throw new InviteLocalApiError(403,'ADMIN_PERMISSION_REQUIRED'); };
  f.port.restore = async () => calls ? active([], 'admin@example.com') : active(['invites.issue'],'admin@example.com');
  f.mount(); await flush();
  f.root.querySelector('#admin-deadline').value = '2099-01-01T12:00'; f.root.querySelector('#admin-batch').value = 'offline';
  f.root.querySelector('#admin-invite-issue').fire('submit'); await flush();
  assert.equal(f.root.querySelector('#admin-no-permissions').hidden, false); assert.equal(f.logouts(),0);
  assert.match(f.root.querySelector('.invite-admin-status').textContent, /账号仍可登录/);
  f.root.querySelector('#admin-invite-issue').fire('submit'); await flush(); assert.equal(calls,1);
});

test('late login after unmount never reconstructs the page or keeps typed password', async t => {
  const f = setup(t); let done!: (value: AccountAdminSession) => void;
  f.port.emailLogin = () => new Promise(resolve => { done = resolve; }); f.mount(); await flush();
  f.root.querySelector('#admin-email').value = 'admin@example.com'; f.root.querySelector('#admin-password').value = 'Offline password 123';
  f.root.querySelector('#admin-email-login').fire('submit'); f.dispose(); done(active()); await flush();
  assert.equal(f.root.innerHTML,''); assert.equal(f.root.querySelector('#admin-password').value,'');
});

test('account transport uses admin namespace, rotates CSRF after binding and never stores secrets', async () => {
  const requests: Array<{ path: string; body: unknown; csrf: string | null }> = [];
  const api = new AccountAdminApi(async (path, options) => {
    const headers = new Headers(options?.headers);
    requests.push({ path: String(path), body: options?.body ? JSON.parse(String(options.body)) : null, csrf: headers.get('x-csrf-token') });
    assert.equal(options?.credentials,'same-origin'); assert.equal(options?.cache,'no-store');
    if (String(path).endsWith('/members/permissions')) return Response.json({member:active([]).member});
    return Response.json({ ...active(), csrf: String(path).endsWith('/bind/finish') ? 'b'.repeat(64) : 'a'.repeat(64) });
  });
  await api.emailLogin('admin@example.com','Offline password 123');
  await api.bindFinish('challenge','012345','Replacement 123');
  await api.setPermissions('member',[]);
  assert.ok(requests.every(r => r.path.startsWith('/api/web/provider/admin/')));
  assert.equal(requests[0]!.csrf,null); assert.equal(requests[1]!.csrf,'a'.repeat(64)); assert.equal(requests[2]!.csrf,'b'.repeat(64));
});


test('permission editor contains exactly four categories; new grants are category codes and untouched legacy scopes never expand', t => {
  setup(t);const mount=new ElementStub(),original=['invites.revoke','characters.edit:deleted-role','characters.publish:jojo'] as AdminPermission[];
  const editor=permissionEditor(mount as unknown as HTMLElement,original);
  assert.equal(descendants(mount).filter(n=>n.type==='checkbox').length,4);
  assert.deepEqual(editor.value(),[...original].sort());
  const checkbox=(key:string)=>descendants(mount).find(n=>n.attributes.get('data-permission-category')===key)!;
  checkbox('category.characters').checked=false;checkbox('category.characters').fire('change');
  assert.deepEqual(editor.value(),['characters.publish:jojo','invites.revoke']);
  checkbox('category.characters').checked=true;checkbox('category.characters').fire('change');
  assert.deepEqual(editor.value(),['category.characters','characters.publish:jojo','invites.revoke']);
  editor.setDisabled(true);assert.ok(descendants(mount).filter(n=>n.type==='checkbox').every(n=>n.disabled));
  const fresh=new ElementStub(),newEditor=permissionEditor(fresh as unknown as HTMLElement,[]);
  for(const node of descendants(fresh).filter(n=>n.type==='checkbox')){node.checked=true;node.fire('change');}
  assert.deepEqual(newEditor.value(),['category.characters','category.invites','category.materials','category.publication']);
  assert.ok(!descendants(mount).some(n=>/最多 128|全部人物|角色操作与范围/.test(n.textContent)));
});

test('owner explicitly confirms all-permission removal without logout and does not reissue after ambiguous response or refresh', async t => {
  const owner=active();owner.member.role='owner';const f=setup(t,owner);let calls=0,saved:AdminPermission[]|undefined;
  f.port.setPermissions=async(_id,p)=>{saved=p;return active(p).member;};
  f.port.issueMember=async()=>{calls++;throw new Error('lost receipt');};
  f.mount();await flush();f.root.querySelector('[data-page="members"]').fire();await flush();
  let nodes=descendants(f.root.querySelector('#admin-members-list'));
  nodes.find(n=>n.textContent==='确认收回全部功能权限')!.fire();await flush();
  assert.deepEqual(saved,[]);assert.equal(f.logouts(),0);
  nodes=descendants(f.root.querySelector('#admin-members-list'));nodes.find(n=>n.textContent==='为此管理员签发新登录凭据')!.fire();await flush();
  f.root.querySelector('#admin-members-refresh').fire();await flush();
  const frozen=descendants(f.root.querySelector('#admin-members-list')).find(n=>n.textContent.startsWith('上次签发结果未确认'))!;
  assert.equal(frozen.dataset.locked,'true');frozen.fire();await flush();assert.equal(calls,1);
});

test('invitation records show independent actions; revocation requires explicit confirmation and leaves login untouched', async t => {
  const f=setup(t,active(['invites.read','invites.revoke-code'],'admin@example.com'));const revoked:string[]=[];
  f.port.inviteRecords=async()=>({next:null,records:[{inviteId:'record',batch:'测试批次',note:'合成备注',createdAt:1,redeemBy:4_000_000_000_000,
    status:'active',redeemed:0,grantId:null,redeemedAt:null,accessRevokedAt:null,accessExpiresAt:null}]});
  f.port.revokeInvite=async(kind,id)=>{revoked.push(kind+':'+id);};
  f.mount();await flush();const nodes=descendants(f.root.querySelector('#admin-invite-records'));
  assert.ok(nodes.some(n=>n.textContent==='测试批次'));assert.ok(!nodes.some(n=>n.textContent.includes('撤销此体验授权')));
  nodes.find(n=>n.textContent==='撤销此邀请码')!.fire();await flush();assert.deepEqual(revoked,[]);
  nodes.find(n=>n.textContent==='确认撤销此邀请码')!.fire();await flush();assert.deepEqual(revoked,['code:record']);assert.equal(f.logouts(),0);
  window.dispatchEvent(new Event('focus'));await flush();
  assert.ok(descendants(f.root.querySelector('#admin-invite-records')).some(n=>n.textContent==='测试批次'));
});

test('permission conflict is actionable and never silently reloads and overwrites', async t => {
  const owner=active();owner.member.role='owner';const f=setup(t,owner);let calls=0;
  f.port.setPermissions=async()=>{calls++;throw new InviteLocalApiError(409,'ADMIN_PERMISSIONS_CONFLICT');};
  f.mount();await flush();f.root.querySelector('[data-page="members"]').fire();await flush();
  descendants(f.root.querySelector('#admin-members-list')).find(n=>n.textContent.startsWith('保存 '))!.fire();await flush();
  assert.match(f.root.querySelector('.invite-admin-status').textContent,/未覆盖新权限/);assert.equal(calls,1);assert.equal(f.logouts(),0);
});

test('focus identity/session changes clear prior management data and secrets, but do not call logout',async t=>{
  const owner=active();owner.member.role='owner';const f=setup(t,owner);f.mount();await flush();
  f.root.querySelector('[data-page="members"]').fire();await flush();assert.ok(f.root.querySelector('#admin-members-list').children.length>0);
  f.root.querySelector('#admin-secret-value').textContent='local secret fixture';
  const next=active(['category.characters']);next.member.id='another-admin';next.csrf='b'.repeat(64);f.port.restore=async()=>next;
  window.dispatchEvent(new Event('focus'));await flush();assert.equal(f.root.querySelector('#admin-members-list').children.length,0);
  assert.equal(f.root.querySelector('#admin-secret-value').textContent,'');assert.equal(f.root.querySelector('[data-panel="account"]').hidden,false);assert.equal(f.logouts(),0);
});


test('bound account never offers to bind later, including immediately after binding and restore', async t => {
  const f=setup(t,{...active(),emailDeliveryAvailable:true});f.mount();await flush();
  assert.equal(f.root.querySelector('#admin-account-continue').textContent,'稍后绑定，进入管理');
  f.root.querySelector('#admin-bind-email').value='admin@example.com';f.root.querySelector('#admin-bind-start').fire('submit');await flush();
  f.root.querySelector('#admin-bind-code').value='012345';f.root.querySelector('#admin-bind-password').value='Newpwd12';
  f.root.querySelector('#admin-bind-finish').fire('submit');await flush();
  f.root.querySelector('[data-page="account"]').fire();
  assert.equal(f.root.querySelector('#admin-account-continue').textContent,'进入管理');
  assert.equal(f.root.querySelector('#admin-account-info').textContent,'已绑定：admin@example.com');
  assert.equal(f.root.querySelector('#admin-bind-start').hidden,true);
});

test('all password reveal controls toggle without submitting, and navigation/disposal clears even visible passwords',async t=>{
  const f=setup(t);f.mount();await flush();let logins=0;
  f.port.emailLogin=async()=>{logins++;return active();};
  for(const id of ['admin-password','admin-bind-password','admin-reset-password']){
    const field=f.root.querySelector('#'+id),toggle=f.root.querySelector('#'+id+'-toggle');field.value='Synthetic123';
    toggle.fire();assert.equal(field.type,'text');assert.equal(toggle.textContent,'隐藏密码');assert.equal(toggle.attributes.get('aria-pressed'),'true');
    toggle.fire();assert.equal(field.type,'password');toggle.fire();
  }
  assert.equal(logins,0);f.root.querySelector('[data-page="reset"]').fire();
  for(const id of ['admin-password','admin-bind-password','admin-reset-password']){
    const field=f.root.querySelector('#'+id);assert.equal(field.value,'');assert.equal(field.type,'password');
    assert.equal(f.root.querySelector('#'+id+'-toggle').attributes.get('aria-pressed'),'false');
  }
  const field=f.root.querySelector('#admin-reset-password');field.value='Synthetic123';f.root.querySelector('#admin-reset-password-toggle').fire();f.dispose();assert.equal(field.value,'');assert.equal(field.type,'password');
});

test('six-digit numeric code fields and Unicode-aware new-password limits are present; logout clears revealed values',async t=>{
  const f=setup(t,active([], 'admin@example.com'));f.mount();await flush();
  assert.equal(f.root.querySelector('#admin-account-continue').textContent,'进入管理');
  assert.equal((f.root.innerHTML.match(/pattern="\[0-9\]\{6\}"/g)??[]).length,2);
  assert.equal((f.root.innerHTML.match(/pattern=".\{8,18\}"/g)??[]).length,2);
  assert.ok(!f.root.innerHTML.includes('15–128'));
  f.root.querySelector('#admin-bind-password').value='Synthetic123';f.root.querySelector('#admin-bind-password-toggle').fire();
  f.root.querySelector('#admin-logout').fire();await flush();
  assert.equal(f.root.querySelector('#admin-bind-password').value,'');assert.equal(f.root.querySelector('#admin-bind-password').type,'password');assert.equal(f.logouts(),1);
});
