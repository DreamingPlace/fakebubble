/**
 * Part 24b-7f round 3: the BUTTON TEXT audit, a string for page.evaluate (no build step). On every admin page, open state and workbench tab:
 *   clip   a button's text is cut off (scrollWidth > clientWidth), or its text lies outside the button's own box
 *   wrap   a button's label is on more than one line
 * Exempt (named, each with its reason): the whole-card hit areas whose text is a card, not a label (docs/ADMIN_LAYOUT.md §1: .cs-card-open,
 * .cc-row-open, .cc-card-open, .cn-add-card, .cs-cell, .cs-head, .cs-star-hit, .ot-row); the role rail (.wb-roster, its names are shown
 * when it expands, by design); the 声音 tab (Part 30, .vc-materials); and what sits inside Part 44's inner scroller (.rh-scroll). The
 * script pickers of 多轮预演 (.rh-pick) are a name and a count on one line by design and are measured like any button.
 */
export const BUTTON_TEXT_SOURCE = `(() => {
  const EXEMPT = '.cs-card-open, .cc-row-open, .cc-card-open, .cn-add-card, .cs-cell, .cs-head, .cs-star-hit, .ot-row, .wb-roster, .vc-materials, .vc-materials *, .rh-scroll, .rh-scroll *, .ad-tip';
  const out = [];
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[hidden]') && getComputedStyle(e).visibility !== 'hidden'; };
  const root = document.querySelector('.admin-frame') || document.querySelector('.admin-shell');
  for (const b of root.querySelectorAll('button, a.admin-primary, a.admin-secondary')) {
    if (!vis(b) || b.closest(EXEMPT)) continue;
    const r = b.getBoundingClientRect();
    const rects = []; let text = '';
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('.ad-tip') ? 2 : 1) });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.nodeValue || '').trim()) continue;
      text += n.nodeValue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const q of range.getClientRects()) if (q.width > 0) rects.push([q.top, q.bottom, q.left, q.right]);
    }
    if (!rects.length) continue;
    const label = text.trim().replace(/\\s+/g, ' ').slice(0, 28);
    const clipped = b.scrollWidth > b.clientWidth + 1;
    const outside = rects.some((q) => q[3] > r.right + 1 || q[2] < r.left - 1);
    const minBottom = Math.min(...rects.map((q) => q[1]));
    const wraps = rects.length > 1 && rects.some((q) => q[0] >= minBottom - 1);
    const where = String(b.className).split(' ')[0] || b.tagName.toLowerCase();
    if (clipped || outside) out.push('clip 「' + label + '」 ' + where + ' ' + Math.round(r.width) + 'px (text ' + b.scrollWidth + ')');
    if (wraps) out.push('wrap 「' + label + '」 ' + where + ' ' + Math.round(r.width) + 'px');
  }
  return out;
})()`;
