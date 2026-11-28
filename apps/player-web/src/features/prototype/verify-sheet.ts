import { ProviderApiError } from '../../services/provider-api.ts';
import type { LiveBinding } from './provider-binding.ts';
import type { SessionGate } from './session-gate.ts';

/** The sheet's one line per state. No paragraph, no explanation: the player page says nothing else about verification. */
export const verifyCopy = {
  connecting: '正在验证…',
  interactive: '请完成安全验证',
  failed: '验证没有完成',
  /** The session failed for another reason than the check (the network, the server): still one line, still 重试. */
  unreachable: '连接没有成功',
  retry: '重试',
  close: '关闭',
};
/** A verification that finishes within this time never shows the sheet at all (a tap just continues). */
const SHOW_AFTER_MS = 350;

export interface VerifySheet {
  /** Where the Turnstile widget's box goes (it lives in the sheet; the sheet shows it only while the player is waiting). */
  widgetHost: HTMLElement;
  /** An action that needs a session calls this: resolves with the session, shows the sheet while it is not ready yet. */
  request(): Promise<LiveBinding>;
}

/**
 * Part 48: the small sheet that appears at the moment the player first does something that needs a session while the background
 * check is still running or has failed. It holds the Turnstile widget (a click is asked for only when Cloudflare wants one), one short
 * line, and 重试 after a failure. When the session arrives it closes by itself and the tapped action continues; closing it by hand
 * (× / the dim background / Escape) drops the waiting action.
 */
export function mountVerifySheet(gate: SessionGate, doc: Document = document): VerifySheet {
  const root = doc.createElement('div');
  root.className = 'vs-root';
  root.innerHTML = `<div class="vs-scrim"></div>
    <div class="vs-sheet" role="dialog" aria-modal="true" aria-labelledby="vs-line" tabindex="-1">
      <button class="vs-close" type="button" aria-label="${verifyCopy.close}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      <p class="vs-line" id="vs-line" role="status" aria-live="polite"></p>
      <div class="vs-widget"></div>
      <button class="vs-retry" type="button">${verifyCopy.retry}</button>
    </div>`;
  doc.body.append(root);
  const sheet = root.querySelector<HTMLElement>('.vs-sheet')!;
  const line = root.querySelector<HTMLElement>('.vs-line')!;
  const retry = root.querySelector<HTMLButtonElement>('.vs-retry')!;
  const widgetHost = root.querySelector<HTMLElement>('.vs-widget')!;
  let wanted = false;
  let timer = 0;
  let returnFocus: Element | null = null;
  const setOpen = (open: boolean) => {
    if ((root.dataset.open === 'true') === open) return;
    root.dataset.open = String(open);
    // The page behind a modal sheet is inert, exactly like the other sheets of the page.
    sheet.inert = !open;
    if (open) {
      returnFocus = doc.activeElement;
      queueMicrotask(() => (gate.state === 'failed' ? retry : sheet).focus({ preventScroll: true }));
    } else if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
      returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
  };
  const render = () => {
    clearTimeout(timer);
    const state = gate.state;
    const failed = state === 'failed';
    root.dataset.state = state;
    line.textContent = failed
      ? verifyCopy.failed
      : state === 'interactive'
        ? verifyCopy.interactive
        : verifyCopy.connecting;
    retry.hidden = !failed;
    if (!wanted || state === 'ready' || state === 'idle') {
      wanted = wanted && state !== 'ready';
      setOpen(false);
      return;
    }
    // A failure or a wanted click shows the sheet at once; a check that is just running gets a moment to finish unseen.
    if (failed || state === 'interactive') setOpen(true);
    else timer = window.setTimeout(() => setOpen(wanted && gate.state !== 'ready'), SHOW_AFTER_MS);
  };
  const dismiss = () => {
    wanted = false;
    gate.cancel();
    render();
  };
  gate.onChange(render);
  retry.addEventListener('click', () => gate.retry());
  root.querySelector('.vs-close')!.addEventListener('click', dismiss);
  root.querySelector('.vs-scrim')!.addEventListener('click', dismiss);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.dataset.open === 'true') dismiss();
  });
  sheet.inert = true;
  render();
  return {
    widgetHost,
    request() {
      const session = gate.require();
      if (gate.state !== 'ready') {
        wanted = true;
        render();
      }
      return session;
    },
  };
}
