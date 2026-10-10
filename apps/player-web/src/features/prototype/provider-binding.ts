/** Connects the approved visual shell to the provider-local server. No visual redesign here. */
import type {
  WebProviderBootstrap,
  WebProviderCharacterId,
  WebProviderMessage,
} from '../../../../../packages/contracts/web-provider.ts';
import { ProviderApi, ProviderApiError } from '../../services/provider-api.ts';
import { replyPauseMs } from './reply-presentation.ts';
import { ProviderInviteController } from '../../session/provider-invite-controller.ts';
import { openRecoveryEntry, openRecoveryManage, recoveryCopy, showRecoveryCode } from './recovery-code.ts';
import { mountChatMenu } from '../cocreation/chat-menu.ts';
import { cocreationCopy, openCocreationSheet } from '../cocreation/cocreation-sheet.ts';

type Shell = {
  say(message: string): void;
  head: HTMLElement;
  card(id: WebProviderCharacterId): HTMLElement;
  mark(id: WebProviderCharacterId): string;
  name(id: WebProviderCharacterId): string;
};

export const errorText: Record<string, string> = {
  TRIAL_CHARACTER_LOCKED: '体验期间只能和第一个聊天的人物继续聊哦',
  TRIAL_EXHAUSTED: '体验次数已用完（同一网络累计），输入邀请码可以继续聊',
  TRIAL_EXPIRED: '体验时间已结束，输入邀请码可以继续聊',
  QUEUE_FULL: '现在聊天的人有点多，稍后再试试',
  WEB_DAILY_LIMIT_REACHED: '今天聊得够多啦，明天再来找我吧～',
  RATE_LIMITED: '操作太频繁了，稍后再试试',
  WEB_INVITE_UNAVAILABLE: '邀请码无效或已被使用',
  INVALID_TEXT: '这条消息发不出去，换个说法试试',
  REPLY_NOT_DELIVERED: '这条回复未完成，未自动重发。剩余次数以页面显示为准。',
  REPLY_UNKNOWN: '这条回复的结果尚未确认，请勿重复发送；系统不会自动重发。',
  SEND_UNKNOWN: '发送结果尚未确认，请勿重复发送；系统不会自动重发。',
  IDENTITY_CHANGED: '登录身份已变化，请核对当前页面后再发送。',
  ACCESS_UNAVAILABLE: '当前访问权限不可用，请核对邀请状态。',
  CATALOG_CHANGED: '人物资料已更新，请先保留输入草稿，再刷新页面。未自动发送。',
  CHARACTER_UNAVAILABLE: '这个人物暂未开放，不能发送消息。',
};
const sound =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4m4-7v10m4-14v18m4-15v12m4-8v4"/></svg>';
const play =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 9 6-9 6V6Z"/></svg>';

/** One playable voice bubble; bubbles of the same reply (operationId) form a WeChat-style queue. */
type VoiceEntry = {
  message: WebProviderMessage;
  characterId: WebProviderCharacterId;
  card: HTMLElement | null;
  button: HTMLElement | null;
  played: boolean;
};

export class LiveBinding {
  private view: WebProviderBootstrap;
  private readonly api: ProviderApi;
  private shell: Shell | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private readonly voices = new Map<string, VoiceEntry>();
  private readonly replies = new Map<string, VoiceEntry[]>();
  private nowPlaying: VoiceEntry | null = null;
  private voiceReply: string | null = null;
  private queueIdle = false;
  private generation = 0;
  private readonly loaded = new Set<string>();
  private readonly shown = new Set<string>();
  private busy = false;
  private viewRevision = 0;
  private sendingCharacter: WebProviderCharacterId | null = null;
  private readonly wait: (ms: number) => Promise<void>;
  private accessKnown = true;
  private refreshing: Promise<void> | null = null;
  private catalogChanged = false;

  private readonly invitation: ProviderInviteController;
  private dialog: HTMLDialogElement | null = null;
  private renderInvite: (() => void) | null = null;

  private constructor(api: ProviderApi, view: WebProviderBootstrap, wait: (ms: number) => Promise<void>) {
    this.wait = wait;
    this.api = api;
    this.view = view;
    this.invitation = new ProviderInviteController(
      api,
      () => this.view,
      (next) => {
        this.updateView(next);
      },
      () => {
        this.renderAccess();
        this.renderInvite?.();
      },
    );
  }
  static async connect(
    api = new ProviderApi(),
    wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {
    return new LiveBinding(api, await api.bootstrap(), wait);
  }
  catalog() {
    return structuredClone({ characters: this.view.characters, slots: this.view.slots });
  }

  attach(shell: Shell) {
    this.shell = shell;
    for (const character of this.view.characters) {
      const button = shell.card(character.characterId).querySelector<HTMLButtonElement>('.welcome-row .play-button');
      button?.setAttribute(
        'aria-label',
        character.welcome.audio.state === 'available'
          ? `播放${shell.name(character.characterId)}的语音`
          : `播放${shell.name(character.characterId)}的语音，当前没有音频素材`,
      );
    }
    this.renderAccess();
    this.mountChatMenus(shell);
    const onReturn = () => {
      if (!document.hidden && !this.busy && !this.invitation.locked) void this.refreshAccess().catch(() => {});
    };
    document.addEventListener('visibilitychange', onReturn);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopVoice();
    });
    window.addEventListener('focus', onReturn);
    // Browse cards show the existing conversation, not just the welcome bubble.
    for (const conversation of this.view.conversations)
      void this.open(conversation.characterId, shell.card(conversation.characterId));
  }

  /** An invited player with a live grant may take part in co-creation; a guest sees the entry, disabled. */
  private cocreationAllowed() {
    const access = this.view.access;
    return access.kind === 'invite' && access.status === 'active' && this.accessKnown && !this.invitation.locked;
  }

  /** The "⋯" menu in each chat header. Its items are read when it opens, so they follow the current access. */
  private mountChatMenus(shell: Shell) {
    for (const character of this.view.characters) {
      const card = shell.card(character.characterId);
      const more = card?.querySelector<HTMLElement>('.chat-more');
      const head = card?.querySelector<HTMLElement>('.chat-head');
      if (!more || !head) continue;
      const name = shell.name(character.characterId);
      mountChatMenu(more, head, () => {
        const allowed = this.cocreationAllowed();
        return [
          {
            label: cocreationCopy.title(name),
            sub: allowed ? cocreationCopy.sub(name) : cocreationCopy.guestSub,
            disabled: !allowed,
            onSelect: () =>
              openCocreationSheet({
                api: this.api,
                characterId: character.characterId,
                name,
                mark: shell.mark(character.characterId),
                color: card.style.getPropertyValue('--avatar-bg'),
                ink: card.style.getPropertyValue('--avatar-ink'),
                say: (message) => shell.say(message),
              }),
          },
        ];
      });
    }
  }

  private renderAccess() {
    const shell = this.shell;
    if (!shell) return;
    const note = shell.head.querySelector<HTMLElement>('.head-note')!;
    const access = this.view.access;
    for (const character of this.view.characters) this.updateComposer(character.characterId);
    if (this.catalogChanged) {
      note.textContent = '人物资料已更新，请保留草稿后刷新';
      return;
    }
    shell.head.querySelector('.invite-entry')?.remove();
    shell.head.querySelector('.recovery-entry')?.remove();
    if (access.kind === 'invite' && !this.invitation.locked) {
      if (access.status === 'active' && this.accessKnown) {
        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'invite-entry recovery-entry';
        manage.textContent = recoveryCopy.manage;
        manage.addEventListener('click', () => openRecoveryManage(this.api, (message) => this.shell?.say(message)));
        shell.head.append(manage);
      }
      note.textContent = !this.accessKnown
        ? '访问权限暂无法确认'
        : access.status === 'active'
          ? '邀请已解锁'
          : '邀请已失效';
      return;
    }
    note.textContent = this.invitation.locked
      ? '邀请兑换待核对'
      : !this.accessKnown
        ? '额度暂无法确认'
        : access.remainingReplies === 0 || access.canSend
          ? `体验剩余 ${access.remainingReplies} 次`
          : '体验已结束';
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'invite-entry';
    entry.textContent = this.invitation.locked ? '核对邀请' : '邀请码';
    entry.addEventListener('click', () => this.inviteDialog());
    shell.head.append(entry);
  }

  updateComposer(characterId: WebProviderCharacterId) {
    const card = this.shell?.card(characterId);
    if (!card) return;
    const access = this.view.access;
    const locked =
      access.kind === 'guest' && access.lockedCharacterId !== null && access.lockedCharacterId !== characterId;
    const button = card.querySelector<HTMLButtonElement>('.send-button');
    const available =
      this.view.characters.find((character) => character.characterId === characterId)?.availability.state ===
      'available';
    if (button)
      button.disabled =
        this.busy ||
        this.invitation.locked ||
        !this.accessKnown ||
        this.catalogChanged ||
        !available ||
        !access.canSend ||
        locked ||
        !card.querySelector<HTMLTextAreaElement>('textarea')?.value.trim();
  }

  private async refreshAccess() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const changed = this.updateView(await this.api.bootstrap());
      this.renderAccess();
      if (changed) throw new ProviderApiError(401, 'IDENTITY_CHANGED');
    })();
    try {
      await this.refreshing;
    } catch (error) {
      this.accessKnown = false;
      this.renderAccess();
      throw error;
    } finally {
      this.refreshing = null;
    }
  }

  private updateView(next: WebProviderBootstrap) {
    const prior = this.view;
    const changed =
      next.instanceId !== prior.instanceId ||
      next.recoveryEpoch !== prior.recoveryEpoch ||
      next.access.principalId !== prior.access.principalId ||
      next.access.playerId !== prior.access.playerId ||
      next.access.worldId !== prior.access.worldId;
    this.catalogChanged ||=
      JSON.stringify([prior.characters, prior.slots]) !== JSON.stringify([next.characters, next.slots]);
    if (changed || this.catalogChanged) {
      this.viewRevision++;
      this.stopVoice();
      this.voices.clear();
      this.replies.clear();
      this.loaded.clear();
      this.shown.clear();
      for (const character of prior.characters)
        this.shell?.card(character.characterId)?.querySelector('.sent-messages')?.replaceChildren();
    }
    // Do not point a mounted old shell at new IDs or silently erase an unsent editor draft.
    if (this.catalogChanged) {
      this.accessKnown = false;
      this.renderAccess();
      throw new ProviderApiError(409, 'CATALOG_CHANGED');
    }
    this.view = next;
    this.accessKnown = true;
    return changed;
  }

  private inviteDialog() {
    if (this.dialog) return;
    const dialog = document.createElement('dialog');
    this.dialog = dialog;
    dialog.className = 'invite-dialog';
    dialog.setAttribute('aria-labelledby', 'invite-label');
    dialog.innerHTML = `<form method="dialog"><label id="invite-label" for="invite-code">输入邀请码</label>
      <input id="invite-code" name="code" autocomplete="one-time-code" maxlength="64" required aria-describedby="invite-state">
      <p id="invite-state" class="invite-state" role="status" aria-live="polite"></p>
      <div class="invite-actions"><button type="button" class="invite-cancel">取消</button>
      <button type="button" class="invite-recover" hidden>核对原请求</button>
      <button type="submit">解锁</button></div>
      <button type="button" class="invite-have-code">${recoveryCopy.have}</button></form>`;
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const recover = dialog.querySelector<HTMLButtonElement>('.invite-recover')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('.invite-cancel')!;
    const status = dialog.querySelector<HTMLElement>('.invite-state')!;
    const close = () => {
      input.value = '';
      this.dialog = null;
      this.renderInvite = null;
      dialog.close();
      dialog.remove();
    };
    const finish = (ok: boolean) => {
      if (ok && this.dialog === dialog) close();
    };
    this.renderInvite = () => {
      const { phase, errorCode } = this.invitation.state;
      if (phase === 'accepted') {
        close();
        return;
      }
      input.readOnly = phase !== 'entry';
      input.required = phase === 'entry';
      if (phase !== 'entry') {
        input.value = '';
        input.placeholder = '本次邀请码已保留，请勿重复兑换';
      } else input.placeholder = '';
      submit.hidden = phase === 'uncertain' || phase === 'recovering' || phase === 'blocked';
      submit.disabled = phase !== 'entry';
      submit.textContent = phase === 'submitting' ? '正在解锁…' : '解锁';
      recover.hidden = phase !== 'uncertain' && phase !== 'recovering';
      recover.disabled = phase !== 'uncertain';
      recover.textContent = phase === 'recovering' ? '正在核对…' : '核对原请求';
      cancel.textContent = this.invitation.locked ? '关闭' : '取消';
      status.textContent =
        phase === 'entry'
          ? errorCode === 'INVALID_CODE'
            ? '请填写完整的 43 位邀请码。'
            : errorCode === 'WEB_INVITE_UNAVAILABLE'
              ? '邀请码无效或已被使用，请核对后再输入。'
              : ''
          : phase === 'submitting'
            ? '正在兑换，请勿重复提交。'
            : phase === 'recovering'
              ? '只核对原请求，不会再次兑换。'
              : phase === 'blocked'
                ? '当前身份或人物资料已变化，已停止兑换。请联系管理员核对，勿重复提交。'
                : '结果尚未确认。请核对原请求，不要刷新页面或再次兑换；关闭后可从“核对邀请”继续。';
    };
    cancel.addEventListener('click', close);
    dialog.querySelector('.invite-have-code')?.addEventListener('click', () => {
      if (this.invitation.locked) return;
      close();
      openRecoveryEntry(this.api, () => location.reload());
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    recover.addEventListener('click', () => {
      void this.invitation.recover().then((ok) => {
        if (ok) {
          this.shell?.say('邀请已解锁，可以和所有人聊天了');
          void this.issueRecoveryCode();
        }
        finish(ok);
      });
    });
    dialog.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.redeem(input.value.trim()).then(finish);
    });
    document.body.append(dialog);
    this.renderInvite();
    dialog.showModal();
  }

  private async redeem(code: string) {
    if (this.busy || this.refreshing) {
      this.shell?.say('上一条回复或访问状态仍在核对，请稍后兑换');
      return false;
    }
    if (this.catalogChanged || !this.accessKnown) {
      this.shell?.say('当前访问状态尚未确认，请先核对页面状态');
      return false;
    }
    const ok = await this.invitation.redeem(code);
    if (ok) {
      this.shell?.say('邀请已解锁，可以和所有人聊天了');
      void this.issueRecoveryCode();
    }
    return ok;
  }

  /** Right after redemption: create the player's recovery code and show it once. Never persisted or logged. */
  private async issueRecoveryCode() {
    try {
      showRecoveryCode(await this.api.regenerateRecoveryCode());
    } catch {
      this.shell?.say(`${recoveryCopy.regenerateFailed}。可点右上角“${recoveryCopy.manage}”重新生成`);
    }
  }

  private fail(error: unknown) {
    const code = error instanceof ProviderApiError ? error.code : 'NETWORK';
    this.shell?.say(errorText[code] ?? '网络不太稳定，稍后再试试');
  }

  private stopAudio() {
    this.audio?.pause();
    if (this.audioUrl?.startsWith('blob:')) URL.revokeObjectURL(this.audioUrl);
    this.audio = null;
    this.audioUrl = null;
    this.mark(this.nowPlaying, false);
    this.nowPlaying = null;
  }

  /** Stops the current clip and drops the whole voice queue (leaving the chat, new message, page hidden). */
  stopVoice() {
    this.generation++;
    this.voiceReply = null;
    this.queueIdle = false;
    this.stopAudio();
  }

  private mark(entry: VoiceEntry | null, playing: boolean) {
    entry?.button?.setAttribute('data-playing', String(playing));
  }

  private start(url: string, entry: VoiceEntry | null = null) {
    this.stopAudio();
    const audio = new Audio(url);
    this.audio = audio;
    this.audioUrl = url;
    this.nowPlaying = entry;
    if (entry) {
      entry.played = true;
      this.mark(entry, true);
    }
    const finish = () => {
      if (this.audio !== audio) return;
      this.stopAudio();
      if (entry) this.advance(entry);
    };
    audio.addEventListener('ended', finish);
    audio.addEventListener('error', finish);
    void audio.play().catch(() => {
      if (this.audio === audio) {
        // Blocked autoplay: release the clip; a tap on the bubble resumes the queue from there.
        if (entry) entry.played = false;
        this.stopAudio();
      }
      this.shell?.say('点一下再播放语音');
    });
  }

  private canContinue(entry: VoiceEntry) {
    return !document.hidden && !!entry.card?.classList.contains('is-chat');
  }

  private advance(entry: VoiceEntry) {
    const list = this.replies.get(entry.message.operationId ?? entry.message.messageId) ?? [];
    const next = list.slice(list.indexOf(entry) + 1).find((item) => !item.played);
    if (!next) {
      this.queueIdle = true;
      return;
    }
    if (this.canContinue(next)) void this.playEntry(next);
    else this.stopVoice();
  }

  private register(entry: VoiceEntry) {
    const operationId = entry.message.operationId ?? entry.message.messageId;
    this.voices.set(entry.message.messageId, entry);
    this.replies.set(operationId, [...(this.replies.get(operationId) ?? []), entry]);
    // A clip arriving after the queue ran dry joins the same reply's queue.
    if (this.voiceReply === operationId && this.queueIdle && this.canContinue(entry)) void this.playEntry(entry);
  }

  playWelcome(characterId: WebProviderCharacterId) {
    if (this.catalogChanged) {
      this.fail(new ProviderApiError(409, 'CATALOG_CHANGED'));
      return;
    }
    const audio = this.view.characters.find((item) => item.characterId === characterId)?.welcome.audio;
    if (audio?.state === 'available') {
      this.stopVoice();
      this.start(audio.url);
    } else this.shell?.say('这段语音暂时无法播放');
  }

  private async playMessage(characterId: WebProviderCharacterId, message: WebProviderMessage) {
    if (!message.audio?.mediaId || this.catalogChanged) return;
    const entry = this.voices.get(message.messageId) ?? {
      message,
      characterId,
      card: null,
      button: null,
      played: false,
    };
    await this.playEntry(entry);
  }

  private async playEntry(entry: VoiceEntry) {
    const { message, characterId } = entry;
    if (!message.audio?.mediaId || this.catalogChanged) return;
    const revision = this.viewRevision;
    const generation = ++this.generation;
    this.voiceReply = message.operationId ?? message.messageId;
    this.queueIdle = false;
    this.stopAudio();
    try {
      const bytes = await this.api.audio({
        characterId,
        conversationId: message.conversationId,
        messageId: message.messageId,
        mediaId: message.audio.mediaId,
      });
      if (this.catalogChanged || revision !== this.viewRevision || generation !== this.generation) return;
      this.start(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })), entry);
    } catch (error) {
      if (generation !== this.generation) return;
      this.voiceReply = null;
      this.fail(error);
    }
  }

  private row(characterId: WebProviderCharacterId, message: WebProviderMessage, card: HTMLElement) {
    const shell = this.shell!;
    const row = document.createElement('div');
    row.dataset.messageId = message.messageId;
    if (message.author === 'player') {
      row.className = 'message-row outgoing';
      const bubble = document.createElement('p');
      bubble.className = 'text-bubble';
      bubble.textContent = message.text;
      row.append(bubble);
      return row;
    }
    if (message.deliveryFallback === 'text') {
      // Voice was busy or unavailable: the reply arrives as an ordinary text bubble. No error, retry or notice.
      row.className = 'message-row incoming';
      const avatar = document.createElement('span');
      avatar.className = 'avatar message-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = shell.mark(characterId);
      const bubble = document.createElement('p');
      bubble.className = 'text-bubble incoming-text';
      bubble.textContent = message.text;
      row.append(avatar, bubble);
      return row;
    }
    row.className = 'message-row incoming';
    const seconds = message.audio?.durationMs ? Math.max(1, Math.round(message.audio.durationMs / 1000)) : null;
    row.innerHTML = `<span class="avatar message-avatar" aria-hidden="true"></span>
      <div class="voice-stack"><div class="voice-bubble">
        <button class="play-button" type="button">${play}<span class="sound-bars">${sound}</span>${
          seconds ? `<span class="voice-seconds">${seconds}″</span>` : ''
        }</button>
        <button class="transcript-toggle" type="button" aria-expanded="false">转文字</button>
      </div><p class="transcript" hidden></p></div>`;
    row.querySelector('.message-avatar')!.textContent = shell.mark(characterId);
    const playButton = row.querySelector<HTMLButtonElement>('.play-button')!;
    playButton.setAttribute('aria-label', `播放${shell.name(characterId)}的语音`);
    if (message.audio?.mediaId) {
      playButton.addEventListener('click', () => void this.playMessage(characterId, message));
      this.register({ message, characterId, card, button: playButton, played: false });
    } else playButton.disabled = true;
    const toggle = row.querySelector<HTMLButtonElement>('.transcript-toggle')!;
    const transcript = row.querySelector<HTMLElement>('.transcript')!;
    toggle.addEventListener('click', () => {
      const visible = transcript.hidden;
      transcript.hidden = !visible;
      transcript.textContent = visible ? message.text : '';
      toggle.textContent = visible ? '收起文字' : '转文字';
      toggle.setAttribute('aria-expanded', String(visible));
    });
    return row;
  }

  private append(characterId: WebProviderCharacterId, card: HTMLElement, messages: WebProviderMessage[]) {
    const list = card.querySelector<HTMLElement>('.sent-messages')!;
    const body = card.querySelector<HTMLElement>('.chat-body')!;
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 72;
    for (const message of messages) {
      if (this.shown.has(message.messageId)) continue;
      this.shown.add(message.messageId);
      list.append(this.row(characterId, message, card));
    }
    if (follow) body.scrollTop = body.scrollHeight;
  }

  private speaking(characterId: WebProviderCharacterId, card: HTMLElement, active: boolean) {
    const title = card.querySelector<HTMLElement>('.chat-head strong');
    if (title) title.textContent = active ? '正在讲话中' : this.shell!.name(characterId);
  }

  private async present(
    characterId: WebProviderCharacterId,
    card: HTMLElement,
    messages: WebProviderMessage[],
    operationId: string,
    revision: number,
  ) {
    let previous: WebProviderMessage | undefined;
    for (const message of messages) {
      if (this.shown.has(message.messageId)) continue;
      const incoming = message.operationId === operationId && message.author !== 'player';
      if (previous && incoming && !document.hidden && card.classList.contains('is-chat'))
        await this.wait(replyPauseMs(previous));
      if (revision !== this.viewRevision || this.catalogChanged) return;
      this.append(characterId, card, [message]);
      if (incoming) previous = message;
    }
  }

  private conversation(characterId: WebProviderCharacterId) {
    return this.view.conversations.find((item) => item.characterId === characterId)?.conversationId ?? null;
  }

  async open(characterId: WebProviderCharacterId, card: HTMLElement) {
    if (this.catalogChanged || this.sendingCharacter === characterId) return;
    const revision = this.viewRevision;
    const conversationId = this.conversation(characterId);
    if (!conversationId || this.loaded.has(conversationId)) return;
    this.loaded.add(conversationId);
    try {
      const page = await this.api.history({ characterId, conversationId, before: null });
      if (this.catalogChanged || revision !== this.viewRevision || this.sendingCharacter === characterId) return;
      this.append(characterId, card, page.messages);
    } catch (error) {
      this.loaded.delete(conversationId);
      this.fail(error);
    }
  }

  async send(characterId: WebProviderCharacterId, text: string, card: HTMLElement, onAccepted?: () => void) {
    if (this.invitation.locked) {
      this.shell?.say('请先核对邀请兑换结果，未发送消息');
      return;
    }
    if (this.busy) {
      this.shell?.say('上一条还在回复中');
      return;
    }
    this.stopVoice();
    this.busy = true;
    this.sendingCharacter = characterId;
    const revision = this.viewRevision;
    this.renderAccess();
    const list = card.querySelector<HTMLElement>('.sent-messages')!;
    const echo = document.createElement('div');
    echo.className = 'message-row outgoing';
    const bubble = document.createElement('p');
    bubble.className = 'text-bubble';
    bubble.textContent = text;
    echo.append(bubble);
    const requestId = crypto.randomUUID();
    let accepted = false,
      uncertain = false;
    try {
      // IP quota can be consumed by another tab/session after this page was opened.
      await this.refreshAccess();
      if (
        this.view.characters.find((character) => character.characterId === characterId)?.availability.state !==
        'available'
      )
        throw new ProviderApiError(409, 'CHARACTER_UNAVAILABLE');
      const access = this.view.access;
      if (!access.canSend)
        throw new ProviderApiError(
          403,
          access.kind === 'guest'
            ? access.remainingReplies === 0
              ? 'TRIAL_EXHAUSTED'
              : 'TRIAL_EXPIRED'
            : 'ACCESS_UNAVAILABLE',
        );
      if (access.kind === 'guest' && access.lockedCharacterId !== null && access.lockedCharacterId !== characterId)
        throw new ProviderApiError(403, 'TRIAL_CHARACTER_LOCKED');
      list.append(echo);
      this.speaking(characterId, card, true);
      card.querySelector<HTMLElement>('.chat-body')!.scrollTop =
        card.querySelector<HTMLElement>('.chat-body')!.scrollHeight;
      let operation;
      try {
        operation = (await this.api.submit({ requestId, characterId, text, delivery: 'voice' })).operation;
      } catch (error) {
        // Uncertain receipt: the same requestId tells us whether the server accepted it.
        if (
          error instanceof ProviderApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.code !== 'PROTOCOL_INVALID'
        )
          throw error;
        uncertain = true;
        try {
          operation = await this.api.byRequest(requestId);
        } catch {
          throw new ProviderApiError(0, 'SEND_UNKNOWN');
        }
      }
      accepted = true;
      uncertain = false;
      onAccepted?.();
      operation = await this.api.waitForOperation(operation);
      await this.refreshAccess();
      if (operation.status === 'unknown') throw new ProviderApiError(409, 'REPLY_UNKNOWN');
      if (operation.status !== 'published') throw new ProviderApiError(409, 'REPLY_NOT_DELIVERED');
      const page = await this.api.history({ characterId, conversationId: operation.conversationId, before: null });
      if (revision !== this.viewRevision || this.catalogChanged) return;
      this.loaded.add(operation.conversationId);
      echo.remove();
      await this.present(characterId, card, page.messages, operation.operationId, revision);
      if (revision !== this.viewRevision || this.catalogChanged) return;
      const first = page.messages.find(
        (message) =>
          message.operationId === operation.operationId && message.author === 'character' && message.audio?.mediaId,
      );
      if (first && !document.hidden && card.classList.contains('is-chat')) void this.playMessage(characterId, first);
    } catch (error) {
      if (revision !== this.viewRevision) {
        this.fail(error);
        return;
      }
      // A definite rejection is not an accepted operation, nor an uncertain receipt.
      if (echo.isConnected) {
        echo.classList.add(accepted || uncertain ? 'delivery-unconfirmed' : 'not-sent');
        const state = document.createElement('span');
        state.className = 'message-send-state';
        state.setAttribute('role', 'status');
        state.textContent = accepted
          ? '已发送 · 回复未完成，请勿重复发送'
          : uncertain
            ? '发送结果待确认，请勿重复发送'
            : '未发送 · 草稿已保留';
        echo.append(state);
        // Never retain the old "3" after the server has rejected quota/access.
        await this.refreshAccess().catch(() => {});
      }
      this.fail(error);
    } finally {
      this.speaking(characterId, card, false);
      this.sendingCharacter = null;
      this.busy = false;
      this.renderAccess();
    }
  }
}
