/**
 * Part 24b-7d: the copy audit that runs INSIDE the page (a string for page.evaluate, so no build step). It walks what is visible in
 * the admin console and reports, by rule:
 *   codes     visible text that is an error-code pattern (^[A-Z][A-Z0-9_]{3,}$), e.g. WEB_SYSTEM_SOURCES_UNAVAILABLE, UNKNOWN
 *   english   a visible English word outside the allowlist (ALLOWED)
 *   dates     a native date or datetime-local input
 *   prices    a price cell (data-price, or text ending 「/ 百万令牌」「/ 百万字节」「/ 次」) without its exact value on hover
 *   units     the unit 「µ$」 in visible text
 *   terms     (round 2) a word the glossary retired: 修订, 服务器草稿, 现行, 人物 (人物 stays on 关系与故事, the story's word) or 「ID」 as a label
 *   numbers   (round 2) a count of 1 000 or more shown without its thousands separator (ids, codes, dates and years are not counts)
 *   sentences (Part 24b-7f) the standing rule of docs/ADMIN_COPY.md: NO EXPLANATORY TEXT on an admin page except beside an irreversible
 *             operation. Any visible sentence (a clause mark 。；，！？ in 8+ characters) or hint / note element outside KEEP fails.
 *             KEEP is the allowlist, each entry named and justified below: labels, buttons, errors and statuses, empty states, table
 *             values, data an administrator or player wrote, and the irreversible-action contexts (delete, publish, permanent deletion,
 *             撤销整批, 下线, 关闭账号, the danger zones and their confirms). Anything else useful is a hover tip (.ad-tip, hidden here).
 * Exempt (named): developer values in the mono style (`.admin-dev`, pre, code), the textarea / input values an admin typed, and the
 * hover bubbles while they are hidden (they are read by the `prices` rule). The 声音 tab is audited for wording too.
 */
export const COPY_AUDIT_SOURCE = `(() => {
  // Allowlist (named, justified): model and provider names, the units and formats the brief names, and the audio format words a
  // sentence about a WAV file needs. Nothing else English is allowed in visible text.
  const ALLOWED = new Set(['DeepSeek','Deepseek','deepseek','Fish','Gemini','Grok','xAI','xai','Claude','Cloudflare','Access','Turnstile','24H','UTC','CSV','JSON','ID','WAV','PCM','PCM16','kHz','MB','Drama','HH','mm','DM','Mono','Pro','Flash','IP','ADMIN','JOJO','PNG','JPEG','WebP','WEBP']);
  // PNG / JPEG / WebP are file formats (like CSV and JSON), named in the 头像 hint (Part 31).
  // Named, justified: Pro / Flash are model names; IP is an abbreviation Part 29 pins in a browser check; ADMIN is the brand lock-up
  // next to the wordmark; JOJO is a character code (admin-entered data) in the fixture.
  const root = document.querySelector('.admin-frame') || document.querySelector('.admin-shell');
  const out = { codes: [], english: [], dates: [], prices: [], units: [], terms: [], numbers: [], sentences: [] };
  const seen = new Set();
  const add = (rule, text, where) => { const key = rule + '|' + text + '|' + where; if (seen.has(key)) return; seen.add(key); out[rule].push(text + '  @ ' + where); };
  const where = (n) => { const e = n.nodeType === 3 ? n.parentElement : n; return (e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ')[0]).slice(0, 40); };
  const visible = (e) => {
    if (!e || e.closest('[hidden]')) return false;
    if (e.checkVisibility) return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && e.getBoundingClientRect().width > 0;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  // Also exempt: what a player wrote (co-creation notes) and the profile diff (it prints the profile's own values, e.g. an IANA zone).
  const EXEMPT = '.admin-dev, pre, code, textarea, .pw-raw, .ad-tip, script, style, .cc-first, .cc-answer-text, .pd-add, .pd-del';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue || '').trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest(EXEMPT) || !visible(el)) continue;
    if (text.includes('µ$')) add('units', text.slice(0, 60), where(n));
    for (const m of text.matchAll(/修订|服务器草稿|现行|人物|(?:^|[^A-Za-z])ID(?:[^A-Za-z]|$)/g)) if (m[0] !== '人物' || !el.closest('#admin-cast')) add('terms', m[0].trim() + ' in 「' + text.slice(0, 40) + '」', where(n));
    for (const m of text.matchAll(/(?<![\\w.\\-:/,#])\\d{4,}(?![\\w.\\-:/,%])/g)) if (!/^(19|20)\\d\\d$/.test(m[0])) add('numbers', m[0] + ' in 「' + text.slice(0, 40) + '」', where(n));
    for (const token of text.split(/[^A-Za-z0-9_\\-.'’]+/)) {
      if (!token) continue;
      if (/^[A-Z][A-Z0-9_]{3,}$/.test(token) && !ALLOWED.has(token) && !/^[0-9A-F]{6}$/.test(token)) add('codes', token, where(n));
      else if (/^[A-Za-z]{2,}$/.test(token) && !ALLOWED.has(token)) add('english', token + ' in 「' + text.slice(0, 40) + '」', where(n));
    }
  }
  for (const input of root.querySelectorAll('input[type="date"], input[type="datetime-local"]')) if (visible(input)) add('dates', input.id || input.getAttribute('aria-label') || 'input', where(input));
  const hasTip = (e) => !!e.querySelector('.ad-tip') || e.classList.contains('has-tip');
  for (const cell of root.querySelectorAll('[data-price], td, .ot-cell, span')) {
    if (!visible(cell)) continue;
    const own = cell.hasAttribute('data-price') || (cell.children.length === 0 || cell.querySelector(':scope > .ad-tip')) && /\\/ (百万令牌|百万字节|次)\\s*(?:存储值.*)?$/.test((cell.firstChild && cell.firstChild.nodeValue || '').trim());
    if (own && !hasTip(cell)) add('prices', (cell.textContent || '').trim().slice(0, 40), where(cell));
  }

  // ---- sentences (Part 24b-7f) ----
  // KEEP: where a sentence is not an explanation. Each group is one reason; nothing else is allowed.
  const KEEP = [
    // a label, a button, a heading, a table value: the words of a control or a value, not prose beside it
    'button, a, [role="button"], label, summary, legend, caption, th, td, dt, dd, option, select, h1, h2, h3, h4, h5, h6, .ot-cell, .ot-detail, .ot-head, .cs-label, .cs-lb, .cs-items-label, .cn-lab',
    // a badge, a chip or a status pill: a value, not prose
    '.cs-tag, .cc-chip, .models-pill, .head-status, .admin-badge, .status-badge, .ov-tile-sub, .ov-tile-label',
    // an error or a status the page is telling now, an empty state, and the reason a control is off (a state of the page, not an explanation)
    '[role="alert"], [role="status"], [aria-live], .admin-error-line, .admin-error-text, .error-line, .admin-empty, .ot-empty, .cc-empty, .cc-target-empty, .rh-empty, .ovx-empty, .vh-note, .pw-fail, .pw-reason, .wb-reason, .admin-toast, .toast, .ad-toast, [data-empty], [data-reason]',
    // data an administrator or a player wrote, and what a diff, a transcript or an import's to-do list prints
    '.cc-first, .cc-answer-text, .cc-text, .text-bubble, .pd-add, .pd-del, .pd-cell, .review-text, .review-lines, .vc-slot, .wl, .pw-line, .pw-bubble, .pw-raw, .cn-field, .cv, .vh-detail, .wb-checklist',
    // irreversible operations: the danger zone and its confirms, 发布 and its row, permanent deletion (data-irreversible marks a line
    // beside one: 立即删除 of a closed account's chat, 确认导入 replacing the whole cast draft), 撤销整批, 下线
    '[data-irreversible], .dz-note, .dz-body, .dz-inner, .danger-zone, .ic-text, .ic-box, .inline-confirm, .confirm-dialog, [role="dialog"], [role="alertdialog"], dialog, .review-confirm, .wb-publish-row',
  ].join(', ');
  const HINT = '.admin-hint, .cs-hint, .cs-hint-line, .arc-hint, .wb-code-note, .av-side p, .permission-note, [class*="-hint"], [class*="-note"], [class$="-help"]';
  const walkerS = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walkerS.nextNode(); n; n = walkerS.nextNode()) {
    const text = (n.nodeValue || '').trim();
    const el = n.parentElement;
    if (!el || !visible(el) || el.closest('script, style, textarea, pre, code, .ad-tip, .admin-dev')) continue;
    const cjk = (text.match(/[\\u4e00-\\u9fff]/g) || []).length;
    const sentence = cjk >= 8 && /[，。；！？]/.test(text);
    const hint = cjk >= 4 && !!el.closest(HINT);
    if (!(sentence || hint) || el.closest(KEEP)) continue;
    add('sentences', text.slice(0, 60), where(n));
  }
  const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), out };
})()`;
