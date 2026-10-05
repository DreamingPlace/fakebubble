import type { LocalAccess, LocalView } from '../../../../../packages/contracts/web-local-client.ts';
import type { WebInviteView } from '../../../../../packages/contracts/web-local-invite.ts';
import type { WebLocalMessage, WebLocalOperation, WebLocalSyncEvent } from '../../../../../packages/contracts/web-local.ts';
import { LocalApi, LocalApiError } from '../../services/local-api.ts';
import type { IndexedDbLocalCache } from '../../data/local-cache.ts';
import type { IndexedDbPendingStore } from '../../data/pending-operations.ts';
import type { LocalSendController, SendResult } from '../../data/send-controller.ts';
import type { LocalSyncController, SyncSink } from '../../data/sync-controller.ts';
import type { LocalAudioController } from '../../media/audio-controller.ts';
import { LocalSession, type LocalScope } from '../../session/local-session.ts';
import { operationLabel, playable, sameScope } from './local-state.ts';
import { startInviteForm, type InviteFormPort } from '../invite/invite-form.ts';

type SyncPort = Pick<LocalSyncController, 'start' | 'stop' | 'visible'>;
class UnsupportedLocalModeError extends Error {}
export type LocalPageDeps = {
  api: Pick<LocalApi, 'bootstrap' | 'history' | 'operation'> & Pick<Partial<LocalApi>, 'bootstrapAny'>;
  mode?: 'local-2' | 'local-3';
  invitePort?: InviteFormPort;
  session: LocalSession;
  sender: Pick<LocalSendController, 'send' | 'lookup' | 'recoverPending'>;
  pending: Pick<IndexedDbPendingStore, 'get'>;
  access: { refresh(scope: LocalScope): Promise<boolean> };
  audio: Pick<LocalAudioController, 'selectCharacter' | 'play' | 'stop'>;
  cache: Pick<IndexedDbLocalCache, 'draft' | 'putDraft' | 'putMessages'>;
  createSync(sink: SyncSink): SyncPort;
};

function errorText(error: unknown): string {
  if (error instanceof UnsupportedLocalModeError) return '本机服务不是 local-2 合成模式；此入口不会回退到旧协议。';
  if (error instanceof LocalApiError) {
    const known: Record<string, string> = {
      TRIAL_EXPIRED: '试聊已到期，旧内容不可继续查看。',
      TRIAL_EXHAUSTED: '当前没有可接纳的试聊次数。',
      TRIAL_CHARACTER_LOCKED: '试聊已固定在另一人物。',
      QUEUE_FULL: '当前处理繁忙，请稍后手动再试。',
      AUTH_REQUIRED: '会话已失效，请重新连接。',
      SESSION_EXPIRED: '会话已失效，请重新连接。',
    };
    return known[error.code] ?? `请求未完成（${error.code}）。`;
  }
  return '连接或处理失败，请确认本地合成服务状态后重试。';
}

/** Separate, opt-in local-2 UI. It never imports preview identities or invents welcome audio. */
export function startLocalPage(root: HTMLElement, deps: LocalPageDeps) {
  root.innerHTML = `<div class="local-page">
    <header class="local-top"><span class="local-brand">FAKE 泡泡</span><span class="local-mode-label">合成业务测试 · 非真实人物或声音</span></header>
    <main class="local-main">
      <section class="local-card" aria-label="合成私聊">
        <div class="local-chat-head"><strong class="local-name">正在连接</strong><span class="local-version"></span></div>
        <div class="local-access" aria-live="polite"></div>
        <div class="local-messages" role="log" aria-label="聊天消息"></div>
        <div class="local-operation" role="status" aria-live="polite"></div>
        <form class="local-composer"><label class="sr-only" for="local-reply">回复</label>
          <textarea id="local-reply" rows="1" placeholder="回复…" disabled></textarea>
          <button class="local-send" type="submit" disabled>发送</button></form>
      </section>
      <p class="local-help">这里只连接受限的本机合成服务。试听、登录、邀请码和只读存档尚未开放；不会播放真实人物声音。</p>
      <div class="local-invite-mount" hidden></div>
      <button class="local-reconnect" type="button">重新连接</button>
      <button class="local-lookup" type="button" hidden>核对原请求</button>
      <p class="local-error" role="alert" hidden></p>
    </main></div>`;

  const name = root.querySelector<HTMLElement>('.local-name')!;
  const version = root.querySelector<HTMLElement>('.local-version')!;
  const accessLine = root.querySelector<HTMLElement>('.local-access')!;
  const messagesNode = root.querySelector<HTMLElement>('.local-messages')!;
  const operationNode = root.querySelector<HTMLElement>('.local-operation')!;
  const form = root.querySelector<HTMLFormElement>('.local-composer')!;
  const reply = root.querySelector<HTMLTextAreaElement>('#local-reply')!;
  const sendButton = root.querySelector<HTMLButtonElement>('.local-send')!;
  const lookupButton = root.querySelector<HTMLButtonElement>('.local-lookup')!;
  const reconnectButton = root.querySelector<HTMLButtonElement>('.local-reconnect')!;
  const errorNode = root.querySelector<HTMLElement>('.local-error')!;
  const inviteMount = root.querySelector<HTMLElement>('.local-invite-mount')!;
  const help = root.querySelector<HTMLElement>('.local-help')!;
  const card = root.querySelector<HTMLElement>('.local-card')!;
  const inviteMode = deps.mode === 'local-3';
  if (inviteMode) help.textContent = '邀请码仅用于本机合成体验；没有真实人物或已批准的语音。';

  let characterId: string | null = null;
  let conversationId: string | null = null;
  let operation: WebLocalOperation | null = null;
  let messages: WebLocalMessage[] = [];
  let uncertainRequestIds: string[] = [];
  let sending = false;
  let accessUnconfirmed = false;
  let recoveringPending = false;
  let lookingUp = false;
  let sync: SyncPort | null = null;
  let bootTicket = 0;
  let disposed = false;
  let disposeInvite: (() => void) | null = null;

  const current = (scope: LocalScope) => !disposed && sameScope(deps.session.scope, scope) &&
    deps.session.contentAvailable(scope);
  const firstUncertain = () => uncertainRequestIds[0] ?? null;
  const holdUncertain = (requestId: string) => {
    if (!uncertainRequestIds.includes(requestId)) uncertainRequestIds.push(requestId);
    renderOperation(); renderAccess();
  };
  const privateClear = () => {
    sync?.stop(); sync = null; deps.audio.stop();
    conversationId = null; operation = null; messages = []; uncertainRequestIds = [];
    reply.value = ''; sending = false; accessUnconfirmed = false; recoveringPending = false; lookingUp = false;
    messagesNode.replaceChildren(); operationNode.textContent = '';
    lookupButton.hidden = true; lookupButton.disabled = false;
    renderAccess();
  };
  const showError = (error: unknown) => {
    if (error instanceof LocalApiError && (error.code === 'TRIAL_EXPIRED' || error.status === 410)) deps.session.denyContent();
    if (error instanceof LocalApiError && (error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_EXPIRED'))
      deps.session.invalidate();
    errorNode.textContent = error instanceof UnsupportedLocalModeError && inviteMode ?
      '本机服务不是 local-3 邀请测试模式；此入口不会回退到旧协议。' : errorText(error);
    errorNode.hidden = false;
    renderAccess();
  };
  const clearError = () => { errorNode.textContent = ''; errorNode.hidden = true; };
  const renderAccess = () => {
    const access: LocalAccess | WebInviteView['bootstrap']['access'] | undefined =
      deps.session.currentInviteView?.bootstrap.access ?? deps.session.currentView?.bootstrap.access;
    const scope = deps.session.scope;
    const available = !!scope && deps.session.contentAvailable(scope) &&
      (!inviteMode || access?.kind === 'invite');
    if (!access || !characterId) accessLine.textContent = '等待合成服务';
    else if (inviteMode && access.kind === 'guest') accessLine.textContent = '输入邀请码后开始体验';
    else if (access.kind === 'invite') accessLine.textContent = available ? '本机合成邀请体验' : '邀请访问已失效；私人内容已隐藏';
    else if (!available || access.retentionState === 'expired') accessLine.textContent = '试聊已到期；私人内容已隐藏';
    else if (access.kind === 'account') accessLine.textContent = '本机合成账号 · 可继续';
    else accessLine.textContent = `剩余可接纳次数：${access.trialRemaining ?? '—'}${access.trialExpiresAt ? ' · 试聊已有固定截止时间' : ''}`;
    reply.disabled = !available || !access?.canSend || !characterId || !!firstUncertain() ||
      accessUnconfirmed || recoveringPending;
    reply.readOnly = sending;
    sendButton.disabled = reply.disabled || sending || !reply.value.trim();
    lookupButton.hidden = !firstUncertain() || !available;
    lookupButton.disabled = recoveringPending || lookingUp;
  };
  const renderMessages = () => {
    messagesNode.replaceChildren();
    const scope = deps.session.scope;
    if (!scope || !deps.session.contentAvailable(scope)) return;
    for (const message of messages) {
      const row = document.createElement('div');
      row.className = `local-message ${message.author === 'player' ? 'is-player' : 'is-character'}`;
      const avatar = document.createElement('span'); avatar.className = 'local-avatar';
      avatar.textContent = message.author === 'player' ? '我' : '测';
      avatar.setAttribute('aria-hidden', 'true');
      if (message.author === 'player') {
        const text = document.createElement('p'); text.textContent = message.text; row.append(text, avatar);
      } else {
        const voice = document.createElement('div'); voice.className = 'local-voice';
        if (message.origin === 'trial_footer') {
          const label = document.createElement('span'); label.className = 'local-footer-label';
          label.textContent = '固定收尾'; voice.append(label);
        }
        const play = document.createElement('button'); play.type = 'button';
        play.textContent = playable(message) ? '播放合成语音' : '语音不可用';
        play.disabled = !playable(message);
        if (playable(message)) play.addEventListener('click', () => {
          const playScope = deps.session.scope;
          if (!playScope || !current(playScope)) return;
          void deps.audio.play(message).then(result => {
            if (!current(playScope)) return;
            if (result === 'needs_user_gesture') operationNode.textContent = '浏览器需要再次点击后播放。';
          }).catch(error => { if (current(playScope)) showError(error); });
        });
        const toggle = document.createElement('button'); toggle.type = 'button';
        toggle.textContent = '转文字'; toggle.setAttribute('aria-expanded', 'false');
        const transcript = document.createElement('p'); transcript.textContent = message.text; transcript.hidden = true;
        toggle.addEventListener('click', () => {
          transcript.hidden = !transcript.hidden;
          toggle.textContent = transcript.hidden ? '转文字' : '收起文字';
          toggle.setAttribute('aria-expanded', String(!transcript.hidden));
        });
        voice.append(play, toggle, transcript); row.append(avatar, voice);
      }
      messagesNode.append(row);
    }
    messagesNode.scrollTop = messagesNode.scrollHeight;
  };
  const renderOperation = () => {
    operationNode.textContent = firstUncertain() ? '发送回执待核对；不会自动重发。' :
      operation ? operationLabel(operation) : '';
  };
  const history = async (scope: LocalScope) => {
    if (!conversationId || !current(scope)) return;
    const id = conversationId;
    try {
      const page = await deps.api.history(id, undefined, deps.session.signal);
      if (!current(scope) || conversationId !== id) return;
      messages = page.messages.filter(message => message.conversationId === id && message.characterId === characterId);
      try { await deps.cache.putMessages(scope, messages); }
      catch { /* Server history is authoritative; cache failure must not hide a valid reply. */ }
      if (current(scope)) renderMessages();
    } catch (error) { if (current(scope)) showError(error); }
  };
  const receiveOperation = async (next: WebLocalOperation, scope: LocalScope) => {
    if (!current(scope) || !characterId) return;
    if (operation?.operationId === next.operationId && next.revision < operation.revision) return;
    operation = next; conversationId = next.conversationId;
    renderOperation();
    if (next.status === 'published') await history(scope);
  };
  const refreshAccess = async (scope: LocalScope) => {
    if (!current(scope)) return;
    accessUnconfirmed = true; renderAccess();
    try {
      const applied = await deps.access.refresh(scope);
      if (!current(scope)) return;
      if (!applied) throw new Error('access refresh was not applied');
      accessUnconfirmed = false; renderAccess();
    } catch (error) {
      if (sameScope(deps.session.scope, scope)) showError(error);
      throw error;
    }
  };
  const createSink = (ownedScope: LocalScope, ticket: number): SyncSink => {
    const owns = (scope: LocalScope) => ticket === bootTicket && sameScope(scope, ownedScope) && current(scope);
    return {
      async apply(event: WebLocalSyncEvent, scope) {
        if (!owns(scope)) return;
        if (event.kind === 'operation') {
          const id = event.payload.operationId;
          if (typeof id === 'string') await receiveOperation(await deps.api.operation(id, deps.session.signal), scope);
        } else if (event.kind === 'publication') await history(scope);
        if (owns(scope)) renderAccess();
      },
      async refreshAccess(scope) { if (owns(scope)) await refreshAccess(scope); },
      async refetchOperation(id, scope) {
        if (!owns(scope)) throw new Error('stale sync scope');
        const next = await deps.api.operation(id, deps.session.signal);
        if (owns(scope)) await receiveOperation(next, scope);
        return next;
      },
      async cursor(_cursor, _scope) { /* Bootstrap is authoritative after reload. */ },
      onError(error) { if (owns(ownedScope)) showError(error); },
    };
  };

  const accepted = async (result: SendResult, scope: LocalScope, clearDraft: boolean) => {
    if (!current(scope)) return;
    if (result.kind === 'network_uncertain') {
      holdUncertain(result.requestId); return;
    }
    if (result.kind !== 'accepted') return;
    uncertainRequestIds = uncertainRequestIds.filter(id => id !== result.operation.requestId);
    if (clearDraft) {
      reply.value = '';
      try { await deps.cache.putDraft(scope, characterId!, ''); }
      catch { /* The accepted operation remains authoritative. */ }
    }
    if (!current(scope)) return;
    renderOperation();
    await receiveOperation(result.operation, scope);
    await refreshAccess(scope);
    renderAccess();
  };
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const scope = deps.session.scope, id = characterId, text = reply.value.trim();
    if (!scope || !id || !current(scope) || inviteMode && !deps.session.currentInviteView ||
        sending || firstUncertain() || recoveringPending ||
        accessUnconfirmed || !text ||
        !(deps.session.currentInviteView?.bootstrap.access.canSend ??
          deps.session.currentView?.bootstrap.access.canSend)) return;
    sending = true; clearError(); renderAccess();
    void deps.sender.send(id, text).then(result => accepted(result, scope, true)).catch(error => {
      if (sameScope(deps.session.scope, scope)) showError(error);
    }).finally(() => { if (sameScope(deps.session.scope, scope)) { sending = false; renderAccess(); } });
  };
  const onLookup = () => {
    const scope = deps.session.scope, requestId = firstUncertain();
    if (!scope || !requestId || !current(scope) || lookingUp || recoveringPending) return;
    clearError(); lookingUp = true; renderAccess();
    void deps.pending.get(scope, requestId).then(item => {
      if (!item || !current(scope)) throw new Error('pending request unavailable');
      return deps.sender.lookup(item).then(result => ({ result, text: item.text }));
    }).then(({ result, text }) => accepted(result, scope, reply.value.trim() === text)).catch(error => {
      if (sameScope(deps.session.scope, scope)) showError(error);
    }).finally(() => { if (current(scope)) { lookingUp = false; renderAccess(); } });
  };
  const onInput = () => {
    renderAccess();
    const scope = deps.session.scope, id = characterId;
    if (scope && id && current(scope)) void deps.cache.putDraft(scope, id, reply.value).catch(error => {
      if (current(scope)) showError(error);
    });
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); form.requestSubmit();
    }
  };
  const onVisibility = () => {
    const ownedSync = sync, ownedScope = deps.session.scope, ticket = bootTicket;
    if (!ownedSync || !ownedScope) return;
    void ownedSync.visible(!document.hidden).catch(error => {
      if (ticket === bootTicket && sync === ownedSync && current(ownedScope)) showError(error);
    });
  };
  const mountInvite = (guest: boolean, ticket: number) => {
    disposeInvite?.(); disposeInvite = null;
    inviteMount.hidden = !guest;
    card.hidden = guest;
    reconnectButton.hidden = guest;
    if (!guest) return;
    if (!deps.invitePort || !deps.session.currentView?.capabilities.invite) {
      inviteMount.textContent = '当前合成服务未开放邀请码兑换。';
      return;
    }
    disposeInvite = startInviteForm(inviteMount, { port: deps.invitePort, synthetic: false,
      onAccepted: async () => {
        const invited = deps.session.currentInviteView;
        if (!invited || disposed || ticket !== bootTicket) return;
        const ownedScope = deps.session.scope;
        clearError();
        mountInvite(false, ticket);
        try { await activate(invited, ticket, true); }
        catch (error) {
          if (!ownedScope || disposed || ticket !== bootTicket ||
              !sameScope(deps.session.scope, ownedScope)) return;
          sync?.stop(); sync = null;
          accessUnconfirmed = true;
          showError(error);
        }
      } });
  };
  const activate = async (next: LocalView | WebInviteView, ticket: number, installed = false) => {
    if (disposed || ticket !== bootTicket) return;
    const scope = installed ? deps.session.scope : deps.session.install(next);
    if (!scope) return;
    characterId = next.bootstrap.characters[0]?.characterId ?? null;
    name.textContent = next.bootstrap.characters[0]?.name ?? '暂无人物';
    version.textContent = '本机合成';
    const guest = inviteMode && next.bootstrap.contractVersion === 'web-v1-local-2';
    mountInvite(guest, ticket);
    if (guest) { renderAccess(); return; }
    recoveringPending = true; renderAccess();
    const recovered = await deps.sender.recoverPending();
    if (!current(scope) || ticket !== bootTicket) return;
    for (const result of recovered) {
      if (result.kind === 'stale_generation') throw new Error('pending recovery lost its session');
      if (result.kind === 'network_uncertain') holdUncertain(result.requestId);
      else await accepted(result, scope, false);
      if (!current(scope) || ticket !== bootTicket) return;
    }
    recoveringPending = false; renderAccess();
    if (characterId) {
      deps.audio.selectCharacter(characterId);
      const draft = await deps.cache.draft(scope, characterId).catch(() => null);
      if (current(scope) && draft !== null) reply.value = draft;
    }
    if (!current(scope)) { renderAccess(); return; }
    conversationId ??= next.bootstrap.conversations.find(row => row.characterId === characterId)?.conversationId ?? null;
    const activeOperation = next.bootstrap.activeOperations.find(row =>
      conversationId ? row.conversationId === conversationId : !!characterId);
    if (!operation && activeOperation) {
      operation = activeOperation; conversationId = activeOperation.conversationId; renderOperation();
    }
    renderAccess();
    if (conversationId) await history(scope);
    if (!current(scope)) return;
    sync = deps.createSync(createSink(scope, ticket));
    await sync.start(next.bootstrap.syncCursor);
  };
  const boot = async () => {
    const ticket = ++bootTicket;
    deps.session.invalidate(); characterId = null;
    disposeInvite?.(); disposeInvite = null; inviteMount.hidden = true; card.hidden = false;
    clearError(); reconnectButton.disabled = true; name.textContent = '正在连接';
    version.textContent = ''; renderAccess();
    try {
      const next = inviteMode ? await deps.api.bootstrapAny?.() : await deps.api.bootstrap();
      if (disposed || ticket !== bootTicket) return;
      if (!next || next.kind !== 'synthetic-local' ||
          (inviteMode ? next.bootstrap.contractVersion !== 'web-v1-local-2' &&
            next.bootstrap.contractVersion !== 'web-v1-local-3' :
            next.bootstrap.contractVersion !== 'web-v1-local-2'))
        throw new UnsupportedLocalModeError();
      await activate(next, ticket);
    } catch (error) { if (!disposed && ticket === bootTicket) showError(error); }
    finally { if (!disposed && ticket === bootTicket) reconnectButton.disabled = false; }
  };

  const onInvalidated = deps.session.onInvalidate(privateClear);
  const onExpired = deps.session.onContentExpired(() => { privateClear(); renderAccess(); });
  form.addEventListener('submit', onSubmit);
  reply.addEventListener('input', onInput);
  reply.addEventListener('keydown', onKeydown);
  lookupButton.addEventListener('click', onLookup);
  reconnectButton.addEventListener('click', boot);
  document.addEventListener('visibilitychange', onVisibility);
  void boot();
  return () => {
    disposed = true; bootTicket++;
    disposeInvite?.(); disposeInvite = null;
    sync?.stop(); deps.audio.stop();
    onInvalidated(); onExpired();
    form.removeEventListener('submit', onSubmit);
    reply.removeEventListener('input', onInput);
    reply.removeEventListener('keydown', onKeydown);
    lookupButton.removeEventListener('click', onLookup);
    reconnectButton.removeEventListener('click', boot);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
