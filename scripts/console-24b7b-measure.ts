/**
 * Part 24b-7b: what the browser checks of this part measure, in one place (run inside the page with `page.evaluate`).
 * Everything is scoped to the 角色工作台 form column; the numbers are what the owner saw: a value that does not fit its field, a
 * one-sentence box that is taller than its text, a form column that moves from one tab to the next, a save bar out of sight.
 */
export type TabMeasure = {
  tab: string;
  /** Fields (input / textarea) and chips whose text does not fit: scrollWidth > clientWidth (or, for a textarea, scrollHeight > clientHeight + 1). */
  cut: string[];
  /** Visible one-sentence boxes (data-grow="one") with more than one line of height while their text is one line. */
  tall: string[];
  /** Left edge and width of the form column (the first `.wb-card-body` form section's content box). */
  column: { left: number; width: number } | null;
  /** The save bar's rectangle against the viewport. */
  saveBar: { top: number; bottom: number; visible: boolean } | null;
  /** Sideways scroll of the page. */
  over: number;
  /** Left edge of every label that sits in a field row (`label > span:first-child`), rounded. */
  labelLeft: number[];
};

export const MEASURE_SOURCE = `(() => {
  const vis = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
  const name = (n) => (n.getAttribute('aria-label') || n.closest('label')?.querySelector('span')?.textContent || n.className || n.tagName).toString().slice(0, 40);
  const cut = [];
  const pane = document.querySelector('.wb-card-body') || document;
  for (const n of pane.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=color]):not([type=file]), textarea, .cn-chip, .cn-chip-text, .chip-text, [data-chip]')) {
    if (!vis(n)) continue;
    const wide = n.scrollWidth - n.clientWidth > 1;
    const high = n.tagName === 'TEXTAREA' && n.scrollHeight - n.clientHeight > 1;
    if (wide || high) cut.push(name(n) + ' (' + n.scrollWidth + '/' + n.clientWidth + ' x ' + n.scrollHeight + '/' + n.clientHeight + ')');
  }
  const tall = [];
  for (const n of pane.querySelectorAll('textarea[data-grow="one"]')) {
    if (!vis(n)) continue;
    const s = getComputedStyle(n);
    const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.5;
    const pad = parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
    const lines = Math.round((n.scrollHeight - pad) / line);
    const boxLines = Math.round((n.getBoundingClientRect().height - pad) / line);
    if (lines <= 1 && boxLines > 1) tall.push(name(n) + ' (' + boxLines + ' lines high for ' + lines + ')');
  }
  const bodyForm = pane.querySelector('.cn-pane:not([hidden]), fieldset:not([hidden]), .wb-sole:not([hidden])');
  const rect = bodyForm ? bodyForm.getBoundingClientRect() : null;
  const bar = document.querySelector('.wb-savebar');
  const br = bar ? bar.getBoundingClientRect() : null;
  const labels = [];
  for (const l of pane.querySelectorAll('fieldset:not([hidden]) label > span:first-child, .wl .wl-row, .cn-label')) {
    if (!vis(l)) continue;
    labels.push(Math.round(l.getBoundingClientRect().left));
  }
  return {
    cut, tall,
    column: rect ? { left: Math.round(rect.left), width: Math.round(rect.width) } : null,
    saveBar: br ? { top: Math.round(br.top), bottom: Math.round(br.bottom), visible: br.top >= 0 && br.bottom <= window.innerHeight + 1 } : null,
    over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    labelLeft: labels,
  };
})()`;
