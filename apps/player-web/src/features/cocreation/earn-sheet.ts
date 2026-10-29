/**
 * 获得点数 (Part 24c): the small sheet behind the button next to the points in 我的信息. One line with the LIVE numbers of points for
 * co-creation notes (read from the server's settings each time it opens, never hard-coded) and a button that opens co-creation.
 * As little text as possible.
 */
import type { CocreationPointsSettings } from '../../../../../packages/contracts/cocreation-cards.ts';
import { h } from './h.ts';

export const earnCopy = {
  button: '获得点数',
  title: '获得点数',
  line: (s: CocreationPointsSettings) =>
    `写共创 +${s.notePoints}（每天最多 ${s.dailyCap} 条）· 被采用 +${s.adoptPoints}`,
  go: '去共创',
  close: '关闭',
  failed: '没能加载，稍后再试试',
};

export interface EarnSheetOptions {
  api: { cocreationRewards(): Promise<CocreationPointsSettings> };
  /** Opens co-creation (the caller closes whatever is behind this sheet). */
  openCocreation(): void;
  mount?: HTMLElement;
}

export function openEarnSheet(options: EarnSheetOptions) {
  const mountPoint = options.mount ?? document.body;
  const opener = document.activeElement as HTMLElement | null;
  const closeButton = h('button', {
    class: 'acct-close icon-button',
    attrs: { type: 'button', 'aria-label': earnCopy.close },
    text: '×',
  });
  const line = h('p', { class: 'earn-line', attrs: { role: 'status', 'aria-live': 'polite' } });
  const go = h('button', { class: 'acct-primary earn-go', text: earnCopy.go, attrs: { type: 'button' } });
  go.disabled = true;
  const sheet = h(
    'div',
    {
      class: 'acct-sheet earn-sheet',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'earn-title' },
    },
    h(
      'header',
      { class: 'acct-head' },
      h('strong', { class: 'acct-title', text: earnCopy.title, attrs: { id: 'earn-title' } }),
      closeButton,
    ),
    h('div', { class: 'acct-body earn-body' }, line, go),
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.remove();
    document.removeEventListener?.('keydown', onKey, true);
    opener?.focus?.();
  };
  function onKey(event: Event) {
    if ((event as KeyboardEvent).key === 'Escape') close();
  }
  closeButton.addEventListener('click', close);
  go.addEventListener('click', () => {
    close();
    options.openCocreation();
  });
  document.addEventListener?.('keydown', onKey, true);
  mountPoint.append(sheet);
  closeButton.focus?.();
  void options.api.cocreationRewards().then(
    (settings) => {
      if (closed) return;
      line.textContent = earnCopy.line(settings);
      go.disabled = false;
    },
    () => {
      if (!closed) line.textContent = earnCopy.failed;
    },
  );
  return { close, element: sheet };
}
