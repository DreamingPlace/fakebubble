/**
 * Part 24b-7c: the layout audit that runs INSIDE the page (a string for page.evaluate, so no build step). One function, `auditLayout(opts)`,
 * walks what is visible in the console's main area and returns the violations of the layout rules (docs/ADMIN_LAYOUT.md), by rule.
 * The 声音 tab (.vc-materials, Part 30) is never measured. Named, commented exemptions only (see EXEMPT).
 */
export const AUDIT_SOURCE = `(() => {
  const SCALE_H = [32, 40];                 // button heights: compact, standard (tokens --ad-h-compact / --ad-h-standard)
  const SCALE_GAP = [4, 8, 12, 16, 24];     // vertical rhythm (tokens --ad-sp-1 .. --ad-sp-5); 24 is the section step
  const STEP = 24;
  const WIDTH = { xs: 120, s: 176, m: 352, l: 920 };  // max width of a single-line field per width class
  // Buttons that are not row actions: whole-card / whole-row hit areas, the navigation and the rail. Each has its own spec.
  const EXEMPT_BUTTON = '.admin-nav-item, .admin-account-toggle, .admin-pick, .admin-pick-head, .cc-row-open, .cn-add-card, .wb-rail-item, .cs-card, .cs-cell, .cs-head, .cc-card-open, .admin-menu-item, .admin-nav-collapse';
  const VOICE = '.vc-materials';
  const root = document.querySelector('.admin-frame') || document.querySelector('.admin-shell');
  const out = { primary: [], buttonHeight: [], buttonGroup: [], fieldWidth: [], pair: [], gaps: [], emptyHeading: [], checkGroup: [], sideways: [], cut: [], rail: [] };
  const vis = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !n.closest('[hidden]') && !n.closest(VOICE); };
  const label = (n) => ((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('placeholder'))) || n.textContent || n.value || '').toString().trim().replace(/\\s+/g, ' ').slice(0, 24) + ' <' + n.tagName.toLowerCase() + '.' + (n.className || '').toString().split(' ')[0] + '>';
  const R = (n) => n.getBoundingClientRect();
  const near = (a, list, tol = 1) => list.some((x) => Math.abs(a - x) <= tol);
  const inRoot = (n) => root.contains(n);

  // 1. buttons: height on the scale; siblings share a height, and a width that is natural or common
  const buttons = [...root.querySelectorAll('button, a.admin-primary, a.admin-secondary')].filter((b) => vis(b) && !b.matches(EXEMPT_BUTTON) && !b.closest('.admin-nav, .wb-rail, .admin-rail'));
  for (const b of buttons) {
    const h = R(b).height;
    if (!near(h, SCALE_H, 0.75)) out.buttonHeight.push(label(b) + ' h=' + Math.round(h));
  }
  const parents = new Map();
  for (const b of buttons) { const p = b.parentElement; if (!parents.has(p)) parents.set(p, []); parents.get(p).push(b); }
  for (const [p, group] of parents) {
    if (group.length < 2) continue;
    const hs = group.map((b) => Math.round(R(b).height));
    if (Math.max(...hs) - Math.min(...hs) > 1) out.buttonGroup.push('heights ' + hs.join('/') + ' in ' + label(p));
    const ws = group.map((b) => R(b).width), allEqual = Math.max(...ws) - Math.min(...ws) <= 1;
    if (!allEqual) for (const b of group) {
      const cs = getComputedStyle(b), pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const range = document.createRange(); range.selectNodeContents(b);
      const natural = range.getBoundingClientRect().width + pad + (b.querySelector('.dc-chev, .ot-chevron') ? 24 : 0);
      if (R(b).width > natural * 1.6 + 16) out.buttonGroup.push('stretched ' + Math.round(R(b).width) + ' for ' + Math.round(natural) + ' ' + label(b));
    }
  }
  for (const b of buttons) {   // a lone button wider than 3x its text is also several times its neighbours
    if (parents.get(b.parentElement).length > 1) continue;
    const range = document.createRange(); range.selectNodeContents(b);
    const cs = getComputedStyle(b), natural = range.getBoundingClientRect().width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    if (R(b).width > natural * 2.2 + 24 && R(b).width > 200 && !b.closest('.admin-menu, .dz-go, .dz-open')) out.buttonGroup.push('lone button stretched ' + Math.round(R(b).width) + ' for ' + Math.round(natural) + ' ' + label(b));
  }

  // 1b. one solid primary per screen (an enabled button drawn in the primary colour)
  const solid = buttons.filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && /rgb\(91, 79, 196\)|rgb\(77, 65, 176\)/.test(getComputedStyle(b).backgroundColor));
  if (solid.length > 1) out.primary.push(solid.length + ' solid primaries: ' + solid.map(label).join(' | '));

  // 2. single-line fields never wider than their width class (data-w set by ui/field-width.ts); a missing class is a miss too
  const fields = [...root.querySelectorAll('input, select')].filter((n) => vis(n) && !n.matches('[type=checkbox],[type=radio],[type=color],[type=file],[type=range],[type=hidden]') && !n.closest('.admin-login, [data-surface=login], .admin-password-field'));
  for (const n of fields) {
    const w = n.getAttribute('data-w'), width = R(n).width;
    if (!w) out.fieldWidth.push('no width class ' + label(n) + ' ' + Math.round(width));
    else if (w !== 'full' && width > (WIDTH[w] || 9999) + 1) out.fieldWidth.push(w + ' field ' + Math.round(width) + 'px (max ' + WIDTH[w] + ') ' + label(n));
  }
  // a one-sentence box (data-grow=one) is a single-line field as well
  for (const n of root.querySelectorAll('textarea[data-grow="one"]')) if (vis(n) && R(n).height < 60 && R(n).width > WIDTH.l + 1) out.fieldWidth.push('one-line box ' + Math.round(R(n).width) + ' ' + label(n));

  // 3. a field and its action: one row = same height and one baseline; a long field with its button a line below is a miss
  for (const b of buttons) {
    const p = b.parentElement; if (!p) continue;
    const sibs = [...p.children].filter((c) => c !== b && vis(c));
    const f = sibs.map((c) => c.matches('input:not([type=checkbox]):not([type=radio]), select, textarea') ? c : c.querySelector && c.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea')).find(Boolean);
    if (!f || !vis(f)) continue;
    const fr = R(f), br = R(b);
    const stacked = br.top >= fr.bottom - 1;
    if (stacked && fr.width >= 480 && f.tagName !== 'TEXTAREA' && br.left < fr.left + 4 + 400) out.pair.push('button on the next line under a ' + Math.round(fr.width) + 'px field: ' + label(b));
    else if (!stacked && f.tagName !== 'TEXTAREA' && Math.abs((fr.top + fr.bottom) / 2 - (br.top + br.bottom) / 2) > 1.5 && Math.abs(fr.height - br.height) > 1 && fr.bottom > br.top) out.pair.push('misaligned ' + Math.round(fr.height) + '/' + Math.round(br.height) + ' ' + label(b));
  }

  // 4. vertical rhythm: the gap between consecutive visible children of a flow container is on the scale and never above the step
  const flows = root.querySelectorAll('.wb-card-body, .character-flow, form, .wb-sole, .admin-page > *, .admin-card, section, details > div, .dz-body, .tiers-new-form, .field-stack');
  const seen = new Set();
  for (const c of flows) {
    if (seen.has(c) || !vis(c) || c.closest(VOICE)) continue; seen.add(c);
    const cs = getComputedStyle(c);
    if (cs.display === 'grid' && cs.gridTemplateColumns.split(' ').length > 1) continue;      // two-dimensional: rows are not siblings
    if (cs.display === 'flex' && cs.flexDirection.startsWith('row')) continue;
    const kids = [...c.children].filter((k) => vis(k) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed' && getComputedStyle(k).position !== 'sticky');
    for (let i = 1; i < kids.length; i++) {
      const a = R(kids[i - 1]), b = R(kids[i]);
      if (b.top < a.top + 2 || Math.abs(b.left - a.left) > 600 || b.left >= a.right - 1) continue;   // side by side
      const gap = b.top - a.bottom;
      if (gap > STEP + 1) out.gaps.push(Math.round(gap) + 'px above the step, between ' + label(kids[i - 1]) + ' and ' + label(kids[i]));
      else if (gap > 2.5 && !near(gap, SCALE_GAP, 1)) out.gaps.push(Math.round(gap * 10) / 10 + 'px is not on the scale, between ' + label(kids[i - 1]) + ' and ' + label(kids[i]));
    }
  }

  // 5. no heading without content under it (a section whose body renders nothing shows a one-line empty state or does not render)
  for (const h of root.querySelectorAll('h2, h3, h4, legend, details[open] > summary, .admin-card-title, .section-title')) {
    if (!vis(h)) continue;
    let scope = h.parentElement;
    // a heading inside its card's header wrapper (…-head): the content is what follows the wrapper
    if (/head/.test((scope.className || '').toString()) && h.tagName !== 'SUMMARY') { const next = [...scope.parentElement.children].filter((k) => vis(k) && R(k).top >= R(scope).bottom - 1); if (next.some((k) => (k.innerText || '').trim().length > 0 || k.querySelector('input,select,textarea,button,table,svg,canvas,img'))) continue; }
    const after = [...scope.children].filter((k) => k !== h && vis(k) && !k.matches('h2, h3, h4, legend, summary') && R(k).top >= R(h).top - 1 && !(k.className || '').toString().includes('admin-page-meta'));
    const inside = h.tagName === 'SUMMARY' ? after.length : after.length;
    const textAfter = after.some((k) => (k.innerText || '').trim().length > 0 || k.querySelector('input,select,textarea,button,table,svg,canvas,img'));
    if (!inside || !textAfter) {
      // headings that share a header row with their own controls (flex row) are not section headings
      const ps = getComputedStyle(scope);
      if (ps.display === 'flex' && ps.flexDirection.startsWith('row') && scope.children.length > 1) continue;
      if (h.closest('.admin-page-head, header')) continue;
      out.emptyHeading.push(label(h));
    }
  }

  // 6. related checkboxes and radios stack close: consecutive ones in one container sit within the group gap, side by side within 24px
  const boxes = [...root.querySelectorAll('input[type=checkbox], input[type=radio]')].filter(vis);
  const byParent = new Map();
  for (const x of boxes) { const row = x.closest('label') || x; const key = (row.parentElement) || row; if (!byParent.has(key)) byParent.set(key, []); byParent.get(key).push(row); }
  for (const [p, rows] of byParent) {
    for (let i = 1; i < rows.length; i++) {
      const a = R(rows[i - 1]), b = R(rows[i]);
      if (Math.abs(a.top - b.top) < 6) { const gap = b.left - a.right; if (gap > 24) out.checkGroup.push(Math.round(gap) + 'px apart sideways ' + label(rows[i]) ); }
      else { const gap = b.top - a.bottom; if (gap > 12.5) out.checkGroup.push(Math.round(gap) + 'px apart ' + label(rows[i])); }
    }
  }

  // 7. sideways scroll, text cut off
  const de = document.documentElement;
  if (de.scrollWidth - de.clientWidth > 1) out.sideways.push('page ' + (de.scrollWidth - de.clientWidth));
  for (const n of root.querySelectorAll('.admin-frame, .admin-main, .wb-card, .wb-card-body, main, table, .admin-table-wrap')) {
    if (!vis(n)) continue; const o = getComputedStyle(n).overflowX;
    if (n.scrollWidth - n.clientWidth > 1 && (o === 'auto' || o === 'scroll' || o === 'hidden')) out.sideways.push(label(n) + ' ' + (n.scrollWidth - n.clientWidth));
  }
  for (const n of root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=color]):not([type=file]):not([type=range]), textarea, button, th, td, label > span, h1, h2, h3, .cs-chip, .cn-chip, .cc-filter-chip, .seg-button')) {
    if (n.closest('.admin-pick, .admin-pick-head')) continue; // the rail shows a name under the avatar and clips it by design (hover tip)
    if (!vis(n)) continue;
    if (n.scrollWidth - n.clientWidth > 1 || (n.tagName === 'TEXTAREA' && n.scrollHeight - n.clientHeight > 1)) out.cut.push(label(n) + ' ' + n.scrollWidth + '/' + n.clientWidth);
  }

  // 8. the rail: no avatar half hidden under the group count (an avatar is wholly in view or wholly out of it)
  const rail = root.querySelector('.wb-rail');
  if (rail && vis(rail)) {
    const rr = R(rail), heads = [...rail.querySelectorAll('.admin-pick-head')].filter(vis);
    for (const a of rail.querySelectorAll('.admin-pick')) {
      if (!vis(a)) continue; const ar = R(a);
      if (ar.top < rr.top - 1 && ar.bottom > rr.top + 1) out.rail.push('avatar half cut at the top of the rail ' + label(a));
      for (const h of heads) { const hr = R(h); const overlap = Math.min(ar.bottom, hr.bottom) - Math.max(ar.top, hr.top); if (overlap > 1 && getComputedStyle(h).position === 'sticky') out.rail.push('avatar under the group count ' + label(a)); }
    }
  }
  const counts = {}; let total = 0;
  for (const k of Object.keys(out)) { counts[k] = out[k].length; total += out[k].length; }
  return { counts, total, out };
})()`;
