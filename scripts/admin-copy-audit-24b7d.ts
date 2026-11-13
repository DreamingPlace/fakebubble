/**
 * Part 24b-7d: the copy audit that runs INSIDE the page (a string for page.evaluate, so no build step). It walks what is visible in
 * the admin console and reports, by rule:
 *   codes     visible text that is an error-code pattern (^[A-Z][A-Z0-9_]{3,}$), e.g. WEB_SYSTEM_SOURCES_UNAVAILABLE, UNKNOWN
 *   english   a visible English word outside the allowlist (ALLOWED)
 *   dates     a native date or datetime-local input
 *   prices    a price cell (data-price, or text ending 「/ 百万令牌」「/ 百万字节」「/ 次」) without its exact value on hover
 *   units     the unit 「µ$」 in visible text
 * Exempt (named): developer values in the mono style (`.admin-dev`, pre, code), the textarea / input values an admin typed, and the
 * hover bubbles while they are hidden (they are read by the `prices` rule). The 声音 tab is audited for wording too.
 */
export const COPY_AUDIT_SOURCE = `(() => {
  // Allowlist (named, justified): model and provider names, the units and formats the brief names, and the audio format words a
  // sentence about a WAV file needs. Nothing else English is allowed in visible text.
  const ALLOWED = new Set(['DeepSeek','Deepseek','deepseek','Fish','Gemini','Grok','xAI','xai','Claude','Cloudflare','Access','Turnstile','24H','UTC','CSV','JSON','ID','WAV','PCM','PCM16','kHz','MB','Drama','HH','mm','DM','Mono','Pro','Flash','IP','ADMIN','JOJO']);
  // Named, justified: Pro / Flash are model names; IP is an abbreviation Part 29 pins in a browser check; ADMIN is the brand lock-up
  // next to the wordmark; JOJO is a character code (admin-entered data) in the fixture.
  const root = document.querySelector('.admin-frame') || document.querySelector('.admin-shell');
  const out = { codes: [], english: [], dates: [], prices: [], units: [] };
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
  const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), out };
})()`;
