/** Connects the approved visual shell to the provider-local server. No visual redesign here. */
import { mountPortrait } from '../brand/portrait.ts';
import type {
  WebProviderBootstrap,
  WebProviderCharacterId,
  WebProviderMessage,
} from '../../../../../packages/contracts/web-provider.ts';
import { ProviderApi, ProviderApiError, type AccountInfo } from '../../services/provider-api.ts';
import { replyPauseMs } from './reply-presentation.ts';
import { ProviderInviteController } from '../../session/provider-invite-controller.ts';
import { mountChatMenu } from '../cocreation/chat-menu.ts';
import { guideCopy, mountChatGuide } from '../cocreation/chat-guide.ts';
import { openEarnSheet } from '../cocreation/earn-sheet.ts';
import { openBillingSheet } from '../account/billing-sheet.ts';
import { cocreationCopy, openCocreationSheet } from '../cocreation/cocreation-sheet.ts';
import { accountCopy, openAccountSheet, type AccountSheetMode } from '../account/account-sheet.ts';
import { inviteDialogHtml } from '../account/invite-dialog-html.ts';
import { balanceLine, infoCopy, openMyInfo, quotaView, tierView, trialQuotaView } from '../account/my-info.ts';
import { mountReviewBanners } from './review-banner.ts';
import { backupNote, modelCopy, modelFooterNote, modelMenuItem, openModelPicker } from './model-picker.ts';
import { renderSignedOut, type SignedOutApi } from '../account/signed-out-page.ts';
import { playerPrefs } from '../prefs/player-prefs.ts';
import { lookCopy, openLookSheet } from './chat-look.ts';
import { clearVoiceProgress, setVoiceProgress } from './voice-progress.ts';
import { openShareSheet, shareCopy } from '../share/share-sheet.ts';
import { attachLongPress, MENU_ICONS, openMessageMenu, type MenuSet } from '../chat/message-menu.ts';
import { quoteBlock, quoteStrip, type QuoteDraft } from '../chat/quote.ts';

export type Shell = {
  say(message: string): void;
  head: HTMLElement;
  card(id: WebProviderCharacterId): HTMLElement;
  mark(id: WebProviderCharacterId): string;
  /** Part 31b: the character's picture URL, or null. */
  portrait?(id: WebProviderCharacterId): string | null;
  name(id: WebProviderCharacterId): string;
  /** Part 45: the number printed on the character's card (for the share sheet's small card). */
  cardNo?(id: WebProviderCharacterId): string;
};

/** Part 26a: the two lines of the one-character rule (GUEST_ONE_CHARACTER_ENABLED); 注册 in the second one opens the signup sheet. */
export const guestLockCopy = {
  first: '新客人，就决定是这位小四四了吗？',
  lockedLink: '注册',
  lockedAfter: '就能解锁全部小四四～',
};

export const errorText: Record<string, string> = {
  GUEST_CHARACTER_LOCKED: '注册就能解锁全部小四四～',
  TRIAL_CHARACTER_LOCKED: '体验期间只能和第一个聊天的人物继续聊哦',
  TRIAL_EXHAUSTED: '体验次数已用完（同一网络累计），输入邀请码可以继续聊',
  TRIAL_EXPIRED: '体验时间已结束，输入邀请码可以继续聊',
  QUEUE_FULL: '现在聊天的人有点多，稍后再试试',
  WEB_DAILY_LIMIT_REACHED: '今天聊得够多啦，明天再来找我吧～',
  RATE_LIMITED: '操作太频繁了，稍后再试试',
  WEB_INVITE_UNAVAILABLE: '邀请码无效或已被使用',
  WEB_INVITE_UNUSABLE: '这个邀请码暂时不能使用',
  INVALID_TEXT: '这条消息发不出去，换个说法试试',
  REPLY_NOT_DELIVERED: '这条回复未完成，未自动重发。剩余次数以页面显示为准。',
  REPLY_UNKNOWN: '这条回复的结果尚未确认，请勿重复发送；系统不会自动重发。',
  SEND_UNKNOWN: '发送结果尚未确认，请勿重复发送；系统不会自动重发。',
  IDENTITY_CHANGED: '登录身份已变化，请核对当前页面后再发送。',
  ACCESS_UNAVAILABLE: '当前访问权限不可用，请核对邀请状态。',
  CATALOG_CHANGED: '人物资料已更新，请先保留输入草稿，再刷新页面。未自动发送。',
  CHARACTER_UNAVAILABLE: '这个人物暂未开放，不能发送消息。',
  PLAYER_LOGIN_REQUIRED: '请先注册或登录，再输入邀请码',
  SESSION_EXPIRED: '登录状态已失效，请刷新页面回到首页',
  AUTH_REQUIRED: '登录状态已失效，请刷新页面回到首页',
};
const sound =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4m4-7v10m4-14v18m4-15v12m4-8v4"/></svg>';
const play =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 9 6-9 6V6Z"/></svg>';

/** One playable voice bubble; bubbles of the same reply (operationId) form a WeChat-style queue. */
/**
 * Part 38a: the header swaps between the nickname and 「正在讲话中」 with a short crossfade: the new text fades in while a
 * copy of the old one fades out above it. Nothing animates under reduced motion, or where the page has no animations.
 */
export function crossfadeTitle(title: HTMLElement, previous: string, ms = 180) {
  if (typeof title.animate !== 'function' || !title.parentElement) return;
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const ghost = document.createElement('span');
  ghost.className = 'title-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = previous;
  title.parentElement.append(ghost);
  const options = { duration: ms, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' };
  title.animate([{ opacity: 0 }, { opacity: 1 }], options);
  const out = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { ...options, fill: 'forwards' });
  out.onfinish = () => ghost.remove();
}

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
  /** Voice messages waiting for the current clip to end, in arrival order (Part 38a). Emptied when the player leaves the chat. */
  private queue: VoiceEntry[] = [];
  /** A clip is being fetched: the queue must not start another one. */
  private loading = false;
  /** Replies whose clips have been handed to the queue; a clip registered later (same reply) joins it. */
  private readonly queuedReplies = new Set<string>();
  private generation = 0;
  private readonly loaded = new Set<string>();
  private readonly shown = new Set<string>();
  /** Part 36: a reply (a turn) is being waited for. The composer is never blocked by it: new bubbles wait for the next turn. */
  private get busy() {
    return this.watching.size > 0;
  }
  /** Characters whose turn this page is following. */
  private readonly watching = new Set<WebProviderCharacterId>();
  /** The messages this page shows, by id (the long-press menu reads what a bubble is from here). */
  private readonly messageById = new Map<string, WebProviderMessage>();
  /** The player's own 👍 / 👎 on character replies. */
  private readonly ratings = new Map<string, NonNullable<WebProviderMessage['rating']>>();
  /** The bubble each character's composer is quoting. */
  private readonly quotes = new Map<WebProviderCharacterId, QuoteDraft>();
  /** Bubbles are sent one after another, in the order they were typed. */
  private readonly sendChain = new Map<WebProviderCharacterId, Promise<void>>();
  private viewRevision = 0;
  private readonly wait: (ms: number) => Promise<void>;
  private accessKnown = true;
  private refreshing: Promise<void> | null = null;
  private catalogChanged = false;

  /** Email account state (GET /account); unknown until loaded, and a failed read leaves the guest defaults. */
  private account: AccountInfo = { signupEnabled: false, signedIn: false };
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
    const binding = new LiveBinding(api, await api.bootstrap(), wait);
    await binding.loadAccount();
    return binding;
  }
  /** Best effort: the chat works without it, the account entries just stay at their guest defaults. */
  private async loadAccount() {
    if (typeof this.api.account !== 'function') return;
    try {
      this.account = await this.api.account();
    } catch {
      /* keep the defaults */
    }
  }
  private get hasLogin() {
    return this.account.signedIn && this.account.hasLogin;
  }
  private get signupOpen() {
    return this.account.signupEnabled;
  }
  /** The two legal pages are published (LEGAL_PAGES_ENABLED): the footer and the signup sheet link them. */
  get legalEnabled() {
    return this.account.features?.legal === true;
  }
  /** The free tier is on (SIGNUP_BONUS_ENABLED) and this is a trial guest: the footer says 免费体验 instead of 邀请体验. */
  get freeTierEnabled() {
    if (this.bonusOffer <= 0) return false;
    return !this.account.signedIn || (this.account.kind === 'guest' && !this.account.hasLogin);
  }
  /** A guest who signed up for the free tier (free replies or points): no longer a trial. */
  get signedUpPlayer() {
    return this.bonusOffer > 0 && this.hasLogin;
  }
  /** A guest past its trial and inside the 7-day grace period (GUEST_GRACE_ENABLED), or null. */
  private get grace() {
    return this.account.signedIn && !this.account.hasLogin ? (this.account.grace ?? null) : null;
  }
  /** Free replies a signup gives (SIGNUP_BONUS_ENABLED), or 0 when the offer is not on. */
  private get bonusOffer() {
    return this.account.features?.signupBonus ?? 0;
  }
  /** CHAT_REVIEW_ENABLED: the delete / clear sheets say the chat text is kept anonymously for 180 more days. */
  private get reviewRetention() {
    return this.account.features?.chatReview === true;
  }
  private get deleteEnabled() {
    return this.account.features?.accountDelete === true;
  }
  /** Part 48: the real binding is the session itself, so it is always ready (the first paint's deferred binding is not). */
  readonly ready = true;
  request() {
    return Promise.resolve(this);
  }
  catalog() {
    return structuredClone({ characters: this.view.characters, slots: this.view.slots });
  }

  attach(shell: Shell) {
    this.shell = shell;
    for (const character of this.view.characters) {
      const card = shell.card(character.characterId);
      // The bubble in the chat and the pill on the card are the same welcome voice.
      for (const selector of ['.welcome-row .play-button', '.face-voice'])
        card
          .querySelector<HTMLButtonElement>(selector)
          ?.setAttribute(
            'aria-label',
            character.welcome.audio.state === 'available'
              ? `播放${shell.name(character.characterId)}的语音`
              : `播放${shell.name(character.characterId)}的语音，当前没有音频素材`,
          );
    }
    this.renderAccess();
    this.mountChatMenus(shell);
    this.mountReviewBanner(shell);
    if (this.account.signedIn && this.account.modelChoice?.notice === 'model_withdrawn') shell.say(modelCopy.withdrawn);
    const onReturn = () => {
      if (!document.hidden && !this.busy && !this.invitation.locked) void this.refreshAccess().catch(() => {});
    };
    document.addEventListener('visibilitychange', onReturn);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopVoice();
    });
    window.addEventListener('focus', onReturn);
    // Fetch only visible history; switching/opening a card loads its own conversation.
    for (const conversation of this.view.conversations) {
      const card = shell.card(conversation.characterId);
      if (card.classList.contains('is-active')) void this.open(conversation.characterId, card);
    }
  }

  /** The one-time banner about anonymous transcript review (CHAT_REVIEW_ENABLED), until the player closes it. */
  private mountReviewBanner(shell: Shell) {
    if (this.account.features?.chatReview !== true || typeof this.api.closeReviewNotice !== 'function') return;
    const closed = this.account.signedIn && this.account.reviewNoticeClosed === true;
    mountReviewBanners(
      this.view.characters.map((character) => shell.card(character.characterId)),
      { closed, persist: () => this.api.closeReviewNotice() },
    );
  }

  /** The "⋯" menu in each chat header: 切换回复模型 (a player who can choose one) and 共创 (everyone). Nothing else. */
  private mountChatMenus(shell: Shell) {
    for (const character of this.view.characters) {
      const card = shell.card(character.characterId);
      const more = card?.querySelector<HTMLElement>('.chat-more');
      const head = card?.querySelector<HTMLElement>('.chat-head');
      if (!more || !head) continue;
      const name = shell.name(character.characterId);
      // The first-time guide points at the button; it appears when this chat is opened (see open()).
      this.guides.set(
        character.characterId,
        mountChatGuide(more, head, () => guideCopy.text(name)),
      );
      mountChatMenu(more, head, () => {
        const model = this.modelMenu(name, card.style.getPropertyValue('--accent'));
        return [
          ...model,
          {
            label: cocreationCopy.title(name),
            sub: cocreationCopy.sub(name),
            // Any principal with a valid session may submit; only a pending invitation check holds it back.
            disabled: this.invitation.locked,
            onSelect: () => this.openCocreation(character.characterId),
          },
          // Part 25b: 外观 is for everyone, guests included; the choices stay on this device.
          {
            label: lookCopy.title,
            onSelect: () =>
              openLookSheet({
                characterId: character.characterId,
                prefs: playerPrefs(),
                card,
                frameHost: document.body.querySelector<HTMLElement>('.page-shell') ?? document.body,
              }),
          },
        ];
      });
    }
  }
  private guides = new Map<WebProviderCharacterId, ReturnType<typeof mountChatGuide>>();
  /** The co-creation sheet of one character (from its ⋯ menu, or from 获得点数). The other live characters feed the pair story card. */
  private openCocreation(characterId: WebProviderCharacterId) {
    const shell = this.shell,
      card = shell?.card(characterId);
    if (!shell || !card) return;
    openCocreationSheet({
      api: this.api,
      characterId,
      name: shell.name(characterId),
      mark: shell.mark(characterId),
      color: card.style.getPropertyValue('--avatar-bg'),
      ink: card.style.getPropertyValue('--avatar-ink'),
      aura: ['--aura-1', '--aura-2', '--aura-3', '--accent'].map((name) =>
        card.style.getPropertyValue(name),
      ) as unknown as [string, string, string, string],
      // Part 39: every live character in the home page order (首页顺序): the dice and the ＋ pick from it.
      everyone: this.view.characters.map((entry) => ({
        characterId: entry.characterId,
        name: shell.name(entry.characterId),
      })),
      say: (message) => shell.say(message),
      guest: this.cocreationGuest,
    });
  }
  /** Part 25c: no signed-up account and not an unlimited player - the co-creation thank-you hints that signing up earns points. */
  private get cocreationGuest() {
    if (this.hasLogin) return false;
    const account = this.account;
    return !(account.signedIn && (account.tier?.unlimited === true || account.kind === 'unlimited'));
  }
  /** 获得点数: the character whose chat is open (else the first one) is where co-creation opens. */
  private openEarn() {
    const shell = this.shell;
    if (!shell) return;
    openEarnSheet({
      api: this.api,
      openCocreation: () => {
        this.info?.close();
        const active = this.view.characters.find((entry) =>
          shell.card(entry.characterId)?.classList.contains('is-active'),
        );
        const target = active ?? this.view.characters[0];
        if (target) this.openCocreation(target.characterId);
      },
    });
  }
  /** The server's effective tier of a signed-in player (the page never derives one from the principal kind). */
  private get tier() {
    return this.account.signedIn ? this.account.tier : undefined;
  }
  /** The model picker state of a player who can choose one (a points account or an invited player), else undefined. */
  private get modelChoice() {
    return this.account.signedIn ? this.account.modelChoice : undefined;
  }

  /** Chats the current guest has: a login switches to another principal and never merges them. */
  private guestHasChats() {
    return this.view.access.kind === 'guest' && this.view.conversations.some((entry) => entry.lastMessageId !== null);
  }

  private openAccount(mode: AccountSheetMode, after?: () => void) {
    return openAccountSheet({
      api: this.api,
      mode,
      signupEnabled: this.signupOpen,
      legal: this.legalEnabled,
      ...(this.reviewRetention ? { reviewRetention: true } : {}),
      ...(this.bonusOffer ? { bonus: this.bonusOffer } : {}),
      nickname: this.account.signedIn ? this.account.nickname : null,
      hasGuestChats: this.guestHasChats(),
      onDone: (done) => {
        // After an erasure the cookie is gone: the last page this tab shows is the signed-out first page.
        if (done === 'delete' || done === 'clear') {
          // What the player chose about the look is on this device too: erasing the device's data erases it.
          playerPrefs().clear();
          const root = document.body.querySelector<HTMLElement>('#app');
          if (root)
            renderSignedOut(root, {
              api: this.api as unknown as SignedOutApi,
              reload: () => location.reload(),
              erased: done === 'delete' ? accountCopy.doneDelete : accountCopy.doneClear,
            });
          else location.reload();
        } else if (after) after();
        // A login or reset replaces the session cookie, a signup or bind changes who the page belongs to: start clean.
        else if (done === 'login' || done === 'reset' || done === 'signup') location.reload();
        else void this.loadAccount();
      },
      onSwitch: (to) => this.openAccount(to),
    });
  }

  /** Part 21b: the model picker entry of the chat's ⋯ menu, only for a player who can choose a model (PLAYER_MODEL_CHOICE_ENABLED). */
  private modelMenu(characterName: string, accent: string) {
    const info = this.account.signedIn ? this.account.modelChoice : undefined;
    if (!info) return [];
    return [
      modelMenuItem(info, () =>
        openModelPicker({
          info,
          characterName,
          accent,
          api: this.api,
          say: (message) => this.shell?.say(message),
          onChanged: (next) => {
            if (this.account.signedIn) this.account = { ...this.account, modelChoice: next };
            this.renderAccess();
          },
        }),
      ),
    ];
  }

  /**
   * 消费记录: a player with a points account or an invitation, and (Part 21i) a guest on the trial, whose page lists its own
   * trial replies and no balance. Undefined when this player has none.
   */
  private billingAction(): (() => void) | undefined {
    const info = this.modelChoice;
    const guestTrial = this.view.access.kind === 'guest' && !this.hasLogin;
    if (!guestTrial && !(info && (info.metered || this.tier?.unlimited === true))) return undefined;
    const shell = this.shell;
    return () =>
      openBillingSheet({
        api: this.api,
        name: (id) => (shell ? shell.name(id as WebProviderCharacterId) : ''),
      });
  }

  /** The top bar's line under the nickname: the same words as 我的信息 (balance and replies, or 不限量). */
  private headNote(): string {
    const access = this.view.access;
    const info = this.modelChoice;
    // The line comes from the server's effective tier (the same words as 我的信息); the principal kind decides nothing here.
    const held = this.tier ? tierView({ tier: this.tier, modelChoice: info }) : null;
    if (this.invitation.locked) return '邀请兑换待核对';
    if (!this.accessKnown) return '额度暂无法确认';
    if (!(access.remainingReplies === 0 || access.canSend)) return '体验已结束';
    if (this.hasLogin && held?.unlimited) return infoCopy.unlimited;
    if (this.hasLogin && this.bonusOffer)
      return access.remainingReplies === 0
        ? '免费消息已用完'
        : info?.metered
          ? modelFooterNote(info)
          : `免费消息剩余 ${access.remainingReplies} 条`;
    return `体验剩余 ${access.remainingReplies} 次`;
  }

  /** 我的信息: one page for everything the account dropdown and the 邀请码 button used to hold. */
  private info: { close(): void } | null = null;
  private openInfo() {
    if (this.info) return;
    const account = this.account.signedIn ? this.account : null;
    const mode = this.hasLogin ? 'player' : 'guest';
    const shell = this.shell;
    const billing = this.billingAction();
    this.info = openMyInfo({
      mode,
      nickname: account?.nickname ?? null,
      playerNumber: account?.playerNumber ?? null,
      emailMasked: account?.emailMasked ?? null,
      quota:
        mode === 'guest'
          ? trialQuotaView({
              remaining: this.view.access.remainingReplies,
              // The page is not told how many replies the trial started with: it is 5 while the free tier is on, 3 otherwise.
              offered: this.freeTierEnabled ? 5 : 3,
              endsAt: this.view.access.trialExpiresAt,
            })
          : account
            ? quotaView({ tier: this.tier, modelChoice: this.modelChoice })
            : null,
      trialLine: mode === 'guest' ? this.headNote() : null,
      signupOpen: this.signupOpen,
      deleteEnabled: this.deleteEnabled,
      codeLabel: this.invitation.locked ? '核对邀请' : infoCopy.enterCode,
      saveNickname: async (value) => {
        await this.api.setNickname(value);
        await this.loadAccount();
        this.renderAccess();
      },
      say: (message) => shell?.say(message),
      onClose: () => {
        this.info = null;
      },
      actions: {
        password: () => void this.openAccount('password'),
        logoutOthers: () => this.api.logoutOthers().then(() => undefined),
        logout: () => this.api.logout().then(() => location.reload()),
        deleteAccount: () => void this.openAccount('delete'),
        clearDevice: () => void this.openAccount('clear'),
        signup: () => void this.openAccount('signup'),
        login: () => void this.openAccount('login'),
        ...(billing ? { billing } : {}),
        // Part 24c: only a player on points earns them (not a guest, not an unlimited player).
        ...(account && this.modelChoice?.metered === true && !this.tier?.unlimited
          ? { earn: () => this.openEarn() }
          : {}),
        // The invite box is a modal step of its own: 我的信息 closes behind it (reopen it to see the new figures).
        enterCode: () => {
          this.info?.close();
          this.inviteDialog();
        },
      },
    });
  }
  /** After the account or access changed: an open 我的信息 shows the new figures. */
  private refreshInfo() {
    if (!this.info) return;
    this.info.close();
    this.openInfo();
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
    shell.head.querySelector('.head-actions')?.remove();
    shell.head.querySelector('.head-hint')?.remove();
    // Account entries live in the top bar: a guest gets 登录 / 注册 and 我的信息, a signed-in player a nickname button that
    // opens 我的信息 directly. 邀请码 is inside 我的信息; only a redemption that still needs checking keeps a top-bar button.
    const actions = document.createElement('span');
    actions.className = 'head-actions';
    const action = (text: string, className: string, onClick: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = text;
      button.addEventListener('click', onClick);
      actions.append(button);
      return button;
    };
    if (this.hasLogin) {
      action(
        this.account.signedIn && this.account.nickname ? this.account.nickname : infoCopy.title,
        'head-account',
        () => this.openInfo(),
      );
    } else if (!this.invitation.locked) {
      action('登录', 'head-account desktop-account', () => void this.openAccount('login'));
      action('注册', 'head-account desktop-account', () => void this.openAccount('signup'));
      action('登录/注册', 'head-account mobile-account', () => void this.openAccount('login'));
      action(infoCopy.title, 'head-account head-more', () => this.openInfo());
    }
    note.textContent = this.headNote();
    // A guest past its trial but inside the 7-day grace period: signing up saves the chats and brings them back.
    if (this.grace && this.accessKnown && !this.invitation.locked) {
      // (no sentence here: 注册 stays in the top bar)
    } else if (this.accessKnown && !this.invitation.locked && access.remainingReplies === 0) {
      // Trial used up: one short line says what to do next (a signed-up guest already has an account to keep chats in).
      const hint = document.createElement('span');
      hint.className = 'head-hint';
      hint.textContent = this.bonusOffer
        ? this.hasLogin
          ? accountCopy.freeUsedUp
          : accountCopy.signupForBonus(this.bonusOffer)
        : this.hasLogin
          ? '输入邀请码继续'
          : '注册保存聊天，或输入邀请码继续';
      shell.head.append(hint);
    }
    if (this.invitation.locked) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'invite-entry';
      entry.textContent = '核对邀请';
      entry.addEventListener('click', () => this.inviteDialog());
      if (actions.children.length) shell.head.append(actions);
      shell.head.append(entry);
    } else if (actions.children.length) shell.head.append(actions);
    this.refreshInfo();
  }

  /**
   * Part 26a. The characters an unregistered guest may chat with, or undefined when the rule does not apply (the server only
   * sends the list to such a guest while GUEST_ONE_CHARACTER_ENABLED is on). [] = none chosen yet.
   */
  private get guestMay() {
    return this.view.access.lockedCharacterIds;
  }
  private guestLocked(characterId: WebProviderCharacterId) {
    const may = this.guestMay;
    return !!may && may.length > 0 && !may.includes(characterId);
  }
  /** Characters whose chat has been tapped on send while locked: they keep showing the prompt until the rule stops applying. */
  private readonly lockPrompted = new Set<WebProviderCharacterId>();
  private lockPrompt(characterId: WebProviderCharacterId, card: HTMLElement) {
    this.lockPrompted.add(characterId);
    this.renderGuestNote(characterId, card);
  }
  /** One light centered line above the composer; it fades in (CSS) when it appears and holds no buttons but the 注册 word. */
  private renderGuestNote(characterId: WebProviderCharacterId, card: HTMLElement) {
    const may = this.guestMay;
    const mode =
      !may || may.includes(characterId)
        ? null
        : may.length === 0
          ? this.busy
            ? null
            : ('first' as const)
          : this.lockPrompted.has(characterId)
            ? ('locked' as const)
            : null;
    if (!may || may.includes(characterId)) this.lockPrompted.delete(characterId);
    let note = card.querySelector<HTMLElement>('.guest-note');
    if (!note && mode === null) return;
    if (!note) {
      note = document.createElement('p');
      note.className = 'guest-note';
      note.setAttribute('role', 'status');
      const composer = card.querySelector<HTMLElement>('.composer');
      if (composer) composer.before(note);
      else card.append(note);
    }
    // Rebuilt only when the line changes, so the fade-in does not restart and a tap on 注册 is not lost to a re-render.
    if ((note.dataset.mode ?? '') === (mode ?? '')) return;
    note.dataset.mode = mode ?? '';
    note.hidden = mode === null;
    note.replaceChildren();
    if (mode === 'first') note.textContent = guestLockCopy.first;
    if (mode === 'locked') {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'guest-note-link';
      link.textContent = guestLockCopy.lockedLink;
      link.addEventListener('click', () => void this.openAccount('signup'));
      note.append(link, guestLockCopy.lockedAfter);
    }
  }

  updateComposer(characterId: WebProviderCharacterId) {
    const card = this.shell?.card(characterId);
    if (!card) return;
    this.renderGuestNote(characterId, card);
    const access = this.view.access;
    // Part 26a: while the one-character rule applies, its prompt answers a tap on send; the old trial lock must not disable the button first.
    const locked =
      !access.lockedCharacterIds &&
      access.kind === 'guest' &&
      access.lockedCharacterId !== null &&
      access.lockedCharacterId !== characterId;
    const button = card.querySelector<HTMLButtonElement>('.send-button');
    const available =
      this.view.characters.find((character) => character.characterId === characterId)?.availability.state ===
      'available';
    if (button)
      button.disabled =
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
      // The balance is settled server-side when a reply lands or fails: take the current figure, not the one from page load.
      if (this.modelChoice) await this.loadAccount();
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
      this.queuedReplies.clear();
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
    // While accounts are open a redemption belongs to a login (Part 22a: an invite is an entitlement of a signed-up player). A
    // guest may open this dialog, but a code it enters is not sent anywhere: it is told to sign up, and the code is not consumed.
    const guestMustSignUp = () => this.signupOpen && !this.hasLogin;
    // Once the guest has been told to sign up, 兑换 goes away: there is nothing it could do.
    let guestRefused = false;
    const dialog = document.createElement('dialog');
    this.dialog = dialog;
    dialog.className = 'invite-dialog';
    dialog.setAttribute('aria-labelledby', 'invite-label');
    dialog.innerHTML = inviteDialogHtml(!this.hasLogin);
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
      submit.hidden = phase === 'uncertain' || phase === 'recovering' || phase === 'blocked' || guestRefused;
      submit.disabled = phase !== 'entry';
      submit.textContent = phase === 'submitting' ? '正在兑换…' : '兑换';
      recover.hidden = phase !== 'uncertain' && phase !== 'recovering';
      recover.disabled = phase !== 'uncertain';
      recover.textContent = phase === 'recovering' ? '正在核对…' : '核对原请求';
      cancel.textContent = this.invitation.locked ? '关闭' : '取消';
      if (errorCode === 'PLAYER_LOGIN_REQUIRED' && signupNote) signupNote.hidden = false;
      status.textContent =
        phase === 'entry'
          ? errorCode === 'INVALID_CODE'
            ? '请填写完整的 43 位邀请码。'
            : errorCode === 'WEB_INVITE_UNAVAILABLE'
              ? '邀请码无效或已被使用，请核对后再输入。'
              : errorCode === 'WEB_INVITE_UNUSABLE'
                ? '这个邀请码暂时不能使用'
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
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    recover.addEventListener('click', () => {
      void this.invitation.recover().then((ok) => {
        if (ok) {
          this.shell?.say('邀请已解锁，可以和所有人聊天了');
          void this.afterRedeem();
        }
        finish(ok);
      });
    });
    const signupNote = dialog.querySelector<HTMLElement>('.invite-signup');
    dialog.querySelector('.invite-signup-button')?.addEventListener('click', () => {
      close();
      this.openAccount('signup', () => {
        void this.refreshLoginThenInvite();
      });
    });
    dialog.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      if (guestMustSignUp()) {
        // Nothing is sent: the code stays unused and the field keeps what was typed.
        if (signupNote) signupNote.hidden = false;
        guestRefused = true;
        submit.hidden = true;
        status.textContent = '';
        return;
      }
      void this.redeem(input.value.trim()).then(finish);
    });
    document.body.append(dialog);
    this.renderInvite();
    dialog.showModal();
  }

  private async refreshLoginThenInvite() {
    await this.loadAccount();
    if (this.hasLogin) this.inviteDialog();
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
      void this.afterRedeem();
    }
    return ok;
  }

  private async afterRedeem() {
    await this.loadAccount();
    this.renderAccess();
  }

  private fail(error: unknown) {
    const code = error instanceof ProviderApiError ? error.code : 'NETWORK';
    // With the signup bonus on, a used-up trial says what to do next: sign up for the bonus, or (signed up) enter an invite.
    if (code === 'TRIAL_EXHAUSTED' && this.bonusOffer) {
      this.shell?.say(this.hasLogin ? accountCopy.freeUsedUp : accountCopy.signupForBonus(this.bonusOffer));
      return;
    }
    this.shell?.say(errorText[code] ?? '网络不太稳定，稍后再试试');
  }

  private progressTarget(entry: VoiceEntry | null): HTMLElement | null {
    return (this.welcomeButton ?? entry?.button ?? this.nowPlaying?.button ?? null) as HTMLElement | null;
  }
  private clearProgress() {
    for (const button of [this.welcomeButton, this.nowPlaying?.button])
      clearVoiceProgress(button as HTMLElement | null | undefined);
  }

  private stopAudio() {
    this.clearProgress();
    this.audio?.pause();
    if (this.audioUrl?.startsWith('blob:')) URL.revokeObjectURL(this.audioUrl);
    this.audio = null;
    this.audioUrl = null;
    this.mark(this.nowPlaying, false);
    this.nowPlaying = null;
    this.welcomeButton?.setAttribute('data-playing', 'false');
    this.welcomeButton = null;
  }

  /** Stops the current clip and drops the whole voice queue (leaving the chat, new message, page hidden). */
  stopVoice() {
    this.generation++;
    this.clearQueued();
    this.queue = [];
    this.loading = false;
    this.stopAudio();
  }

  private mark(entry: VoiceEntry | null, playing: boolean) {
    entry?.button?.setAttribute('data-playing', String(playing));
  }

  private start(url: string, entry: VoiceEntry | null = null) {
    this.stopAudio();
    // No Audio instance or source exists until an explicit play / queued continuation.
    const audio = new Audio(url);
    audio.preload = 'none';
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
      this.pump();
    };
    // Part 24k-2: the played part of the waveform (pill and chat bubbles alike) is painted in the character's main.
    audio.addEventListener('timeupdate', () => {
      if (this.audio !== audio) return;
      const button = this.progressTarget(entry);
      if (!button || !(audio.duration > 0)) return;
      setVoiceProgress(button, audio.currentTime / audio.duration);
    });
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

  private get playbackBusy() {
    return this.loading || this.audio !== null;
  }

  /** Puts a voice message at the back of the queue; it plays when the current clip ends (at once if nothing plays). */
  private enqueue(entry: VoiceEntry) {
    if (!entry.message.audio?.mediaId || entry.played || this.queue.includes(entry) || this.nowPlaying === entry)
      return;
    this.queue.push(entry);
    entry.button?.setAttribute('data-queued', 'true');
    this.pump();
  }

  /** Starts the next waiting clip when nothing is playing. Leaving the chat or hiding the page drops the queue. */
  private pump() {
    if (this.playbackBusy) return;
    let next: VoiceEntry | undefined;
    while ((next = this.queue.shift())) {
      next.button?.removeAttribute('data-queued');
      if (!next.played) break;
    }
    if (!next) return;
    if (this.canContinue(next)) void this.playEntry(next);
    else this.stopVoice();
  }

  private clearQueued() {
    for (const entry of this.queue) entry.button?.removeAttribute('data-queued');
  }

  /** The clips of a freshly published reply go to the queue in order (history never auto-plays). */
  private queueReply(operationId: string) {
    this.queuedReplies.add(operationId);
    for (const entry of this.replies.get(operationId) ?? []) this.enqueue(entry);
  }

  private register(entry: VoiceEntry) {
    const operationId = entry.message.operationId ?? entry.message.messageId;
    this.voices.set(entry.message.messageId, entry);
    this.replies.set(operationId, [...(this.replies.get(operationId) ?? []), entry]);
    // A clip arriving after its reply was queued joins the queue behind whatever is waiting.
    if (this.queuedReplies.has(operationId)) this.enqueue(entry);
  }

  /** The welcome of one character, from the pill on its card or the bubble in its chat; `button` shows that it is playing. */
  playWelcome(characterId: WebProviderCharacterId, button?: HTMLElement) {
    if (this.catalogChanged) {
      this.fail(new ProviderApiError(409, 'CATALOG_CHANGED'));
      return;
    }
    const audio = this.view.characters.find((item) => item.characterId === characterId)?.welcome.audio;
    if (audio?.state === 'available') {
      this.stopVoice();
      this.start(audio.url);
      this.welcomeButton = button ?? null;
      this.welcomeButton?.setAttribute('data-playing', 'true');
    } else this.shell?.say('这段语音暂时无法播放');
  }
  private welcomeButton: HTMLElement | null = null;

  private async playMessage(characterId: WebProviderCharacterId, message: WebProviderMessage) {
    if (!message.audio?.mediaId || this.catalogChanged) return;
    const entry = this.voices.get(message.messageId) ?? {
      message,
      characterId,
      card: null,
      button: null,
      played: false,
    };
    // A tap on purpose wins over whatever plays or waits; the queue then continues from this message: the rest of
    // its own reply first, then what was already waiting.
    const reply = this.replies.get(message.operationId ?? message.messageId) ?? [];
    const following = reply.slice(reply.indexOf(entry) + 1).filter((item) => !item.played);
    this.clearQueued();
    this.queue = [...new Set([...following, ...this.queue])].filter((item) => item !== entry);
    for (const item of this.queue) item.button?.setAttribute('data-queued', 'true');
    await this.playEntry(entry);
  }

  private async playEntry(entry: VoiceEntry) {
    const { message, characterId } = entry;
    if (!message.audio?.mediaId || this.catalogChanged) return;
    const revision = this.viewRevision;
    const generation = ++this.generation;
    entry.button?.removeAttribute('data-queued');
    this.stopAudio();
    this.loading = true;
    try {
      const bytes = await this.api.audio({
        characterId,
        conversationId: message.conversationId,
        messageId: message.messageId,
        mediaId: message.audio.mediaId,
      });
      if (this.catalogChanged || revision !== this.viewRevision || generation !== this.generation) return;
      this.loading = false;
      this.start(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })), entry);
    } catch (error) {
      if (generation !== this.generation) return;
      this.loading = false;
      this.fail(error);
      this.pump();
    }
  }

  private row(characterId: WebProviderCharacterId, message: WebProviderMessage, card: HTMLElement) {
    const shell = this.shell!;
    const row = document.createElement('div');
    row.dataset.messageId = message.messageId;
    this.messageById.set(message.messageId, message);
    if (message.rating) this.ratings.set(message.messageId, message.rating);
    const quote = (bubble: HTMLElement) => {
      if (message.quote) bubble.prepend(quoteBlock({ ...message.quote }, shell.name(characterId)));
    };
    if (message.author === 'player') {
      row.className = 'message-row outgoing';
      const bubble = document.createElement('p');
      bubble.className = 'text-bubble';
      bubble.textContent = message.text;
      quote(bubble);
      row.append(bubble);
      this.attachMenu(characterId, row, '.text-bubble');
      return row;
    }
    if (message.deliveryFallback === 'text') {
      // Voice was busy or unavailable: the reply arrives as an ordinary text bubble. No error, retry or notice.
      row.className = 'message-row incoming';
      const avatar = document.createElement('span');
      avatar.className = 'avatar message-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = shell.mark(characterId);
      mountPortrait(avatar, shell.portrait?.(characterId) ?? null);
      const bubble = document.createElement('p');
      bubble.className = 'text-bubble incoming-text';
      bubble.textContent = message.text;
      if (message.viaBackup && message.replyOrdinal === 0) {
        // Part 21b: the bubble and its one-line note stay together as a single flex item.
        const stack = document.createElement('div');
        stack.className = 'text-with-note';
        stack.append(bubble, backupNote(message.viaBackup, this.modelChoice?.metered !== false));
        row.append(avatar, stack);
      } else row.append(avatar, bubble);
      this.showRating(row, message.messageId, false);
      this.attachMenu(characterId, row, '.text-bubble');
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
    mountPortrait(row.querySelector<HTMLElement>('.message-avatar')!, shell.portrait?.(characterId) ?? null);
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
    // Part 21b: a reply the backup model wrote says so, once, under its first voice bubble.
    if (message.viaBackup && message.replyOrdinal === 0)
      row.querySelector('.voice-stack')?.append(backupNote(message.viaBackup, this.modelChoice?.metered !== false));
    this.showRating(row, message.messageId, false);
    this.attachMenu(characterId, row, '.voice-bubble');
    return row;
  }

  /**
   * Part 36: the one long-press menu. 引用 for any bubble (the welcome clip is not a stored message, so it has none); a character's voice
   * message that has audio also offers 分享为卡片 (the share sheet of Part 45; sharing lives only here); her replies offer 👍 / 👎.
   */
  private attachMenu(characterId: WebProviderCharacterId, row: HTMLElement, bubbleSelector: string) {
    attachLongPress(row, () => this.openMenu(characterId, row, bubbleSelector));
  }

  private openMenu(characterId: WebProviderCharacterId, row: HTMLElement, bubbleSelector: string) {
    const id = row.dataset.messageId;
    const message = id ? this.messageById.get(id) : undefined;
    const shell = this.shell;
    if (!id || !message || !shell) return;
    const card = shell.card(characterId);
    const items = (): MenuSet => {
      const set: MenuSet = [
        {
          key: 'quote',
          icon: MENU_ICONS.quote,
          label: '引用',
          name: '引用',
          run: () => this.setQuote(characterId, card, { messageId: id, author: message.author === 'player' ? 'player' : 'character', text: message.text }),
        },
      ];
      const voice = message.author === 'character' && message.origin === 'narrative' && !!message.audio?.mediaId;
      if (voice)
        set.push({
          key: 'share',
          icon: MENU_ICONS.card,
          label: '分享为卡片',
          name: '分享为卡片',
          run: () => this.openShare(characterId, row, bubbleSelector, message),
        });
      // her replies: a voice message or a text-fallback reply published by a turn (a broadcast, the footer and the welcome clip are not rated)
      if (message.author === 'character' && message.origin === 'narrative' && message.operationId) {
        const current = this.ratings.get(id)?.value ?? null;
        set.push(
          'separator',
          {
            key: 'up',
            icon: MENU_ICONS.up,
            name: '赞',
            on: current === 'up',
            run: () => void this.rate(characterId, message, current === 'up' ? 'none' : 'up'),
          },
          {
            key: 'down',
            icon: MENU_ICONS.down,
            name: '踩',
            on: current === 'down',
            run: () => {
              if (current === 'down') {
                void this.rate(characterId, message, 'none');
                return;
              }
              // A voice message asks what is rated down; a reply that came as text is its content.
              if (!message.audio?.mediaId) {
                void this.rate(characterId, message, 'down', 'content');
                return;
              }
              menu.render([
                { key: 'down', icon: MENU_ICONS.down, name: '踩', on: true, run: () => 'stay' },
                'separator',
                { key: 'voice', icon: MENU_ICONS.voice, label: '语音', name: '语音', run: () => void this.rate(characterId, message, 'down', 'voice') },
                { key: 'content', icon: MENU_ICONS.content, label: '内容', name: '内容', run: () => void this.rate(characterId, message, 'down', 'content') },
              ]);
              return 'stay';
            },
          },
        );
      }
      return set;
    };
    const menu = openMessageMenu(row, bubbleSelector, items());
  }

  private openShare(characterId: WebProviderCharacterId, row: HTMLElement, bubbleSelector: string, message: WebProviderMessage) {
    const shell = this.shell!;
    const anchor = row.querySelector<HTMLElement>(bubbleSelector) ?? row;
    const target = {
      name: shell.name(characterId),
      mark: shell.mark(characterId),
      portrait: shell.portrait?.(characterId) ?? null,
      no: shell.cardNo?.(characterId) ?? '',
      durationMs: message.audio?.durationMs ?? null,
    };
    try {
      openShareSheet(anchor, target, {
        say: (text) => shell.say(text),
        create: (requestId) =>
          this.api.share({ requestId, conversationId: message.conversationId, messageId: message.messageId }),
      });
    } catch {
      shell.say(shareCopy.failed); // never silent: a sheet that could not be built is said
    }
  }

  /** The rated mark: outside the bubble at its bottom-right corner, bottom on the bubble's bottom edge. Replaced, never stacked. */
  private showRating(row: HTMLElement, messageId: string, animate: boolean) {
    row.querySelector('.rating-mark')?.remove();
    const rating = this.ratings.get(messageId);
    if (!rating) return;
    const host = row.querySelector<HTMLElement>('.voice-bubble') ?? row.querySelector<HTMLElement>('.text-bubble');
    if (!host) return;
    const mark = document.createElement('span');
    mark.className = `rating-mark${animate ? ' is-new' : ''}`;
    mark.dataset.rating = rating.value;
    if (rating.target) mark.dataset.target = rating.target;
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', rating.value === 'up' ? '已赞' : '已踩');
    mark.innerHTML = rating.value === 'up' ? MENU_ICONS.up : MENU_ICONS.down;
    host.append(mark);
  }

  private async rate(
    characterId: WebProviderCharacterId,
    message: WebProviderMessage,
    rating: 'up' | 'down' | 'none',
    target?: 'voice' | 'content',
  ) {
    const before = this.ratings.get(message.messageId) ?? null;
    const row = this.shell?.card(characterId).querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.messageId)}"]`);
    // The mark answers at once; a refused request puts it back.
    if (rating === 'none') this.ratings.delete(message.messageId);
    else this.ratings.set(message.messageId, { value: rating, target: target ?? null });
    if (row) this.showRating(row, message.messageId, rating !== 'none');
    try {
      await this.api.rate({
        requestId: crypto.randomUUID(),
        conversationId: message.conversationId,
        messageId: message.messageId,
        rating,
        ...(target ? { target } : {}),
      });
    } catch (error) {
      if (before) this.ratings.set(message.messageId, before);
      else this.ratings.delete(message.messageId);
      if (row) this.showRating(row, message.messageId, false);
      this.fail(error);
    }
  }

  /** The composer quotes one bubble (a strip with ✕ above the field); a second 引用 replaces the first. */
  private setQuote(characterId: WebProviderCharacterId, card: HTMLElement, quote: QuoteDraft) {
    this.quotes.set(characterId, quote);
    const composer = card.querySelector<HTMLElement>('.composer');
    if (!composer) return;
    composer.querySelector('.quote-strip')?.remove();
    const strip = quoteStrip(quote, this.shell!.name(characterId), () => this.clearQuote(characterId, card));
    composer.classList.add('has-quote');
    composer.prepend(strip);
    card.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
  }

  private clearQuote(characterId: WebProviderCharacterId, card: HTMLElement) {
    this.quotes.delete(characterId);
    const composer = card.querySelector<HTMLElement>('.composer');
    const strip = composer?.querySelector<HTMLElement>('.quote-strip');
    composer?.classList.remove('has-quote');
    if (!strip) return;
    if (typeof strip.animate !== 'function' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) strip.remove();
    else {
      strip.classList.add('is-leaving');
      window.setTimeout(() => strip.remove(), 160);
    }
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
    if (!title) return;
    const next = active ? '正在讲话中' : this.shell!.name(characterId);
    if (title.textContent === next) return;
    const previous = title.textContent ?? '';
    title.textContent = next;
    crossfadeTitle(title, previous);
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
    if (card.classList.contains('is-chat')) this.guides.get(characterId)?.show();
    if (this.catalogChanged) return;
    const revision = this.viewRevision;
    const conversationId = this.conversation(characterId);
    if (!conversationId || this.loaded.has(conversationId)) return;
    this.loaded.add(conversationId);
    try {
      const page = await this.api.history({ characterId, conversationId, before: null });
      if (this.catalogChanged || revision !== this.viewRevision) return;
      this.append(characterId, card, page.messages);
    } catch (error) {
      this.loaded.delete(conversationId);
      this.fail(error);
    }
  }

  /**
   * Part 36: sends ONE bubble. Bubbles in a row are stored one by one, in the order they were typed (the composer is never blocked
   * by a reply); the character answers the whole batch once, after 4 s of quiet or at five bubbles. This page follows that turn
   * (`watchTurn`): it shows her reply when it lands, and says "正在讲话中" only while she is replying.
   */
  async send(characterId: WebProviderCharacterId, text: string, card: HTMLElement, onAccepted?: () => void) {
    // Part 26a: nothing is sent and the draft stays; the page says why, and 注册 opens the signup sheet.
    if (this.guestLocked(characterId)) {
      this.lockPrompt(characterId, card);
      return;
    }
    if (this.invitation.locked) {
      this.shell?.say('请先核对邀请兑换结果，未发送消息');
      return;
    }
    const revision = this.viewRevision;
    const list = card.querySelector<HTMLElement>('.sent-messages')!;
    const echo = document.createElement('div');
    echo.className = 'message-row outgoing';
    const bubble = document.createElement('p');
    bubble.className = 'text-bubble';
    bubble.textContent = text;
    const quote = this.quotes.get(characterId) ?? null;
    if (quote) bubble.prepend(quoteBlock({ ...quote }, this.shell!.name(characterId)));
    echo.append(bubble);
    const requestId = crypto.randomUUID();
    const previous = this.sendChain.get(characterId) ?? Promise.resolve();
    const turn = (async () => {
      await previous;
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
        // The page was stale: the refresh above brought the guest's list, which no longer includes this character.
        if (this.guestLocked(characterId)) throw new ProviderApiError(403, 'GUEST_CHARACTER_LOCKED');
        list.append(echo);
        const body = card.querySelector<HTMLElement>('.chat-body')!;
        body.scrollTop = body.scrollHeight;
        let receipt;
        try {
          receipt = await this.api.sendBubble({
            requestId,
            characterId,
            text,
            ...(quote ? { quoteMessageId: quote.messageId } : {}),
          });
        } catch (error) {
          // Uncertain receipt: nothing is sent again by this page; the stored bubble shows up with the next history read.
          if (
            error instanceof ProviderApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408 &&
            error.code !== 'PROTOCOL_INVALID'
          )
            throw error;
          uncertain = true;
          throw new ProviderApiError(0, 'SEND_UNKNOWN');
        }
        accepted = true;
        // The echo IS the stored bubble now: a later history read skips it.
        echo.dataset.messageId = receipt.messageId;
        this.shown.add(receipt.messageId);
        this.loaded.add(receipt.conversationId);
        this.messageById.set(receipt.messageId, {
          messageId: receipt.messageId,
          conversationId: receipt.conversationId,
          characterId,
          operationId: null,
          replyOrdinal: null,
          author: 'player',
          origin: 'input',
          text,
          createdAt: Date.now(),
          audio: null,
        });
        this.attachMenu(characterId, echo, '.text-bubble');
        if (quote) this.clearQuote(characterId, card);
        onAccepted?.();
        void this.watchTurn(characterId, card);
      } catch (error) {
        if (revision !== this.viewRevision) {
          this.fail(error);
          return;
        }
        // A definite rejection is not an accepted bubble, nor an uncertain receipt.
        if (echo.isConnected) {
          echo.classList.add(accepted || uncertain ? 'delivery-unconfirmed' : 'not-sent');
          const state = document.createElement('span');
          state.className = 'message-send-state';
          state.setAttribute('role', 'status');
          state.textContent = uncertain ? '发送结果待确认，请勿重复发送' : '未发送 · 草稿已保留';
          echo.append(state);
          // Never retain the old "3" after the server has rejected quota/access.
          await this.refreshAccess().catch(() => {});
        }
        // A stale page: the server answered that this guest's character is another one. Same prompt, never a toast.
        if (error instanceof ProviderApiError && error.code === 'GUEST_CHARACTER_LOCKED')
          this.lockPrompt(characterId, card);
        else this.fail(error);
      }
    })();
    this.sendChain.set(characterId, turn);
    await turn;
  }

  /**
   * Follows the turn of one character's chat until nothing is waiting: collecting (the quiet period; the header stays the nickname),
   * her reply running (「正在讲话中」), her reply landed (shown one bubble after the other, the clips queued behind whatever is
   * playing), then the next turn if bubbles were sent meanwhile. A reply that failed or whose result is unknown marks the bubbles it
   * answered; nothing is ever sent again from here.
   */
  private async watchTurn(characterId: WebProviderCharacterId, card: HTMLElement) {
    if (this.watching.has(characterId)) return;
    this.watching.add(characterId);
    this.renderAccess();
    const revision = this.viewRevision;
    try {
      for (;;) {
        if (revision !== this.viewRevision || this.catalogChanged) return;
        const turn = await this.api.turn(characterId);
        if (turn.state === 'idle') return;
        if (turn.state === 'refused') {
          this.markUnanswered(card, null, 'not-sent', '未发送');
          await this.refreshAccess().catch(() => {});
          this.fail(new ProviderApiError(403, turn.errorCode ?? 'ACCESS_UNAVAILABLE'));
          return;
        }
        if (turn.state === 'collecting' || !turn.operationId) {
          await this.wait(600);
          continue;
        }
        this.speaking(characterId, card, true);
        let operation = await this.api.operation(turn.operationId);
        operation = await this.api.waitForOperation(operation);
        await this.refreshAccess();
        const page = await this.api.history({ characterId, conversationId: operation.conversationId, before: null });
        if (revision !== this.viewRevision || this.catalogChanged) return;
        this.loaded.add(operation.conversationId);
        // The bubbles this turn answered (the history names the turn of every stored bubble).
        const answered = new Set<string>();
        for (const message of page.messages)
          if (message.author === 'player' && message.operationId === operation.operationId) {
            answered.add(message.messageId);
            const known = this.messageById.get(message.messageId);
            if (known) known.operationId = operation.operationId;
          }
        if (operation.status !== 'published') {
          this.markUnanswered(card, answered, 'delivery-unconfirmed', '已发送 · 回复未完成，请勿重复发送');
          this.fail(new ProviderApiError(409, operation.status === 'unknown' ? 'REPLY_UNKNOWN' : 'REPLY_NOT_DELIVERED'));
          // The turn is over (never resent); bubbles sent meanwhile get their own turn.
          this.speaking(characterId, card, false);
          continue;
        }
        await this.present(characterId, card, page.messages, operation.operationId, revision);
        if (revision !== this.viewRevision || this.catalogChanged) return;
        if (!document.hidden && card.classList.contains('is-chat')) this.queueReply(operation.operationId);
        this.speaking(characterId, card, false);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.speaking(characterId, card, false);
      this.watching.delete(characterId);
      this.renderAccess();
    }
  }

  /**
   * The bubbles a turn answered but whose reply did not arrive: say so on the rows the page shows, once. `ids` null = every bubble
   * still waiting for a turn (a refused batch).
   */
  private markUnanswered(card: HTMLElement, ids: Set<string> | null, state: 'not-sent' | 'delivery-unconfirmed', text: string) {
    for (const row of card.querySelectorAll<HTMLElement>('.message-row.outgoing[data-message-id]')) {
      const id = row.dataset.messageId!;
      if (row.classList.contains('not-sent') || row.classList.contains('delivery-unconfirmed')) continue;
      if (ids ? !ids.has(id) : this.messageById.get(id)?.operationId) continue;
      row.classList.add(state);
      const note = document.createElement('span');
      note.className = 'message-send-state';
      note.setAttribute('role', 'status');
      note.textContent = text;
      row.append(note);
    }
  }
}
