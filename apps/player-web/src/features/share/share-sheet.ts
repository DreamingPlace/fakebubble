/**
 * Part 45: the share sheet of one of a character's voice messages (design board approved by the owner, night mode).
 *
 * The entry is a 分享 icon beside the voice bubble (only a character's voice message that has audio gets one). Tapping it opens, on a
 * phone, a sheet from the bottom, and on a wider screen a small card beside the icon. It shows the character's small card (avatar,
 * name, number, length), the link, 复制链接 and, where the browser has a share sheet, 分享. There is no explanatory text.
 *
 * The sheet is an overlay on the page: it never touches the audio, so a voice message that is playing keeps playing while the sheet
 * opens, is used and closes. The link is made when the sheet opens (one request id per opening, so a retry gives the same link); the
 * address is built from the token and the page's own origin. The sharer's nickname, number and id are never put in it.
 */
import { pushBackLayer } from '../nav/back-layer.ts';
import { mountPortrait } from '../brand/portrait.ts';
import { formatDuration } from '../prototype/voice-pill.ts';

export const shareCopy = {
  open: '分享',
  copy: '复制链接',
  copied: '已复制',
  share: '分享',
  failed: '暂时无法分享',
};

const ICON_SHARE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const ICON_TICK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';

export interface ShareTarget {
  name: string;
  mark: string;
  portrait: string | null;
  no: string;
  durationMs: number | null;
}
export interface ShareSheetOptions {
  /** Makes the link: resolves to the token. Called once per opening with the same request id. */
  create: (requestId: string) => Promise<{ token: string }>;
  say: (message: string) => void;
  /** Where the address is built from; the page's own origin. */
  origin?: string;
  /** Overridable for tests. */
  clipboard?: { writeText(text: string): Promise<void> } | null;
  nativeShare?: ((data: { url: string }) => Promise<void>) | null;
  mobile?: boolean;
  reducedMotion?: boolean;
}

const element = (tag: string, className: string, html = '') => {
  const node = document.createElement(tag);
  node.className = className;
  if (html) node.innerHTML = html;
  return node;
};

/** The 分享 icon button that goes beside a voice bubble. */
export function shareButton() {
  const button = element('button', 'share-btn', ICON_SHARE) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-label', shareCopy.open);
  button.setAttribute('aria-haspopup', 'dialog');
  return button;
}

/** Shortens the address for display only: the full one is what is copied and shared. */
export const shortLink = (url: string) => {
  const match = /^https?:\/\/([^/]+)\/s\/([A-Za-z0-9_-]{32})$/.exec(url);
  return match ? `${match[1]}/s/${match[2]!.slice(0, 4)}…${match[2]!.slice(-4)}` : url;
};

let current: { close(): void } | null = null;

export function openShareSheet(anchor: HTMLElement, target: ShareTarget, options: ShareSheetOptions) {
  // one sheet at a time: opening another (or the same icon again) closes the first
  current?.close();
  const mobile = options.mobile ?? window.matchMedia('(max-width: 599px)').matches;
  const reduced = options.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clipboard = options.clipboard === undefined ? (navigator.clipboard ?? null) : options.clipboard;
  const nativeShare =
    options.nativeShare === undefined
      ? typeof navigator.share === 'function' && navigator.canShare?.({ url: window.location.origin }) !== false
        ? (data: { url: string }) => navigator.share(data)
        : null
      : options.nativeShare;
  const scrim = mobile ? element('div', 'share-scrim') : null;
  const sheet = element('div', mobile ? 'share-sheet' : 'share-pop');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', shareCopy.open);
  if (mobile) sheet.append(element('div', 'share-grip'));
  const avatar = element('span', 'avatar share-av');
  avatar.textContent = target.mark;
  avatar.setAttribute('aria-hidden', 'true');
  mountPortrait(avatar, target.portrait, { eager: true });
  const who = element('div', 'share-who');
  who.append(element('div', 'share-name'), element('div', 'share-no'));
  who.firstElementChild!.textContent = target.name;
  who.lastElementChild!.textContent = target.no ? `No.${target.no}` : '';
  const mini = element('div', 'share-mini');
  mini.append(avatar, who);
  if (target.durationMs) {
    const pill = element('div', 'share-pill', `<span class="share-dot">${ICON_PLAY}</span>`);
    pill.append(Object.assign(document.createElement('span'), { textContent: formatDuration(target.durationMs) }));
    mini.append(pill);
  }
  const link = element('div', 'share-link');
  link.dataset.state = 'busy';
  const linkText = document.createElement('span');
  link.append(element('i', 'share-sheen'), linkText);
  const actions = element('div', 'share-actions');
  const copy = element('button', 'share-act', `${ICON_COPY}<span>${shareCopy.copy}</span>`) as HTMLButtonElement;
  copy.type = 'button';
  copy.disabled = true;
  actions.append(copy);
  let share: HTMLButtonElement | null = null;
  if (mobile && nativeShare) {
    share = element(
      'button',
      'share-act share-act-main',
      `${ICON_SHARE}<span>${shareCopy.share}</span>`,
    ) as HTMLButtonElement;
    share.type = 'button';
    share.disabled = true;
    actions.append(share);
  }
  sheet.append(mini, link, actions);
  // inside the page (its styles are scoped to it), above everything; the page's own audio is never touched
  const host = anchor.closest<HTMLElement>('.page-shell') ?? document.body;
  if (scrim) host.append(scrim);
  host.append(sheet);
  if (!mobile) {
    const rect = anchor.getBoundingClientRect();
    const width = 340;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right + 10));
    sheet.style.left = `${left}px`;
    sheet.style.top = `${Math.max(12, Math.min(window.innerHeight - 260, rect.bottom - 250))}px`;
  }
  // the character's colours, for the small card (they live on the card, not on the page)
  const slot = anchor.closest<HTMLElement>('.card-slot');
  if (slot) {
    const style = getComputedStyle(slot);
    for (const name of ['--aura-1', '--aura-2', '--aura-3', '--n-aura-1', '--n-aura-2', '--n-aura-3'])
      sheet.style.setProperty(name, style.getPropertyValue(name));
  }
  anchor.dataset.on = 'true';
  let closed = false;
  // Part 46: the sheet is a history layer: the system back closes it (the chat under it stays), and closing it here takes its entry off
  let releaseLayer: (() => void) | null = pushBackLayer(() => close());
  let url = '';
  let copiedTimer = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    const release = releaseLayer;
    releaseLayer = null;
    release?.();
    clearTimeout(copiedTimer);
    anchor.removeAttribute('data-on');
    document.removeEventListener('keydown', onKey, true);
    if (current === handle) current = null;
    const remove = () => {
      sheet.remove();
      scrim?.remove();
    };
    if (reduced) remove();
    else {
      sheet.classList.add('is-out');
      scrim?.classList.add('is-out');
      setTimeout(remove, 210);
    }
    if (document.activeElement === document.body || sheet.contains(document.activeElement)) anchor.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  scrim?.addEventListener('click', close);
  if (!mobile) {
    // a click anywhere else closes the card (a card beside the icon is not modal)
    const away = (event: Event) => {
      if (closed) return document.removeEventListener('pointerdown', away, true);
      if (!sheet.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
        document.removeEventListener('pointerdown', away, true);
        close();
      }
    };
    document.addEventListener('pointerdown', away, true);
  }
  // A failure is shown IN the sheet (the page's toast sits under the sheet's scrim, out of sight), as a short state of the button that
  // was tapped, and it goes back by itself. Nothing in here fails silently.
  const failTimers = new Map<HTMLButtonElement, number>();
  const markFailed = (button: HTMLButtonElement, restore: string) => {
    button.dataset.state = 'failed';
    button.innerHTML = `<span>${shareCopy.failed}</span>`;
    options.say(shareCopy.failed);
    clearTimeout(failTimers.get(button));
    failTimers.set(
      button,
      window.setTimeout(() => {
        button.dataset.state = '';
        button.innerHTML = restore;
      }, 2600),
    );
  };
  /** The old way, still allowed where the clipboard API is not (an insecure page, a webview): select the address and ask to copy it. */
  const copyBySelection = () => {
    const range = document.createRange();
    range.selectNodeContents(linkText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  };
  const markCopied = () => {
    copy.dataset.state = 'done';
    copy.innerHTML = `${ICON_TICK}<span>${shareCopy.copied}</span>`;
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copy.dataset.state = '';
      copy.innerHTML = `${ICON_COPY}<span>${shareCopy.copy}</span>`;
    }, 2200);
  };
  const copyHtml = `${ICON_COPY}<span>${shareCopy.copy}</span>`;
  copy.addEventListener('click', async () => {
    if (!url) return;
    let done = false;
    try {
      if (!clipboard) throw new Error('NO_CLIPBOARD');
      await clipboard.writeText(url);
      done = true;
    } catch {
      done = copyBySelection();
    }
    if (done) markCopied();
    else markFailed(copy, copyHtml); // the address stays selected, so it can still be copied by hand
  });
  const shareHtml = `${ICON_SHARE}<span>${shareCopy.share}</span>`;
  // navigator.share is called HERE, synchronously inside this tap's own handler (nothing awaited before it): the browser only opens its
  // sheet for a call made while the tap's user activation is alive.
  share?.addEventListener('click', () => {
    if (!url || !nativeShare) return;
    let sharing: Promise<void>;
    try {
      sharing = nativeShare({ url });
    } catch {
      markFailed(share!, shareHtml);
      return;
    }
    sharing.catch((error: unknown) => {
      // the player closing the system sheet is an answer, not a failure
      if ((error as { name?: string } | null)?.name === 'AbortError') return;
      markFailed(share!, shareHtml);
    });
  });
  const requestId = crypto.randomUUID();
  void options.create(requestId).then(
    ({ token }) => {
      if (closed) return;
      url = `${options.origin ?? window.location.origin}/s/${token}`;
      linkText.textContent = shortLink(url);
      link.dataset.state = 'ready';
      copy.disabled = false;
      if (share) share.disabled = false;
      (share ?? copy).focus({ preventScroll: true });
    },
    () => {
      if (closed) return;
      // the link could not be made: say so in the sheet's own link line, short; the sheet closes with the next tap
      link.dataset.state = 'failed';
      linkText.textContent = shareCopy.failed;
      options.say(shareCopy.failed);
    },
  );
  const handle = { close, element: sheet };
  current = handle;
  return handle;
}
