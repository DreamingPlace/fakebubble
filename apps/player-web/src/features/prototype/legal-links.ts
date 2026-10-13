/** The chat footer's first part: 免费体验 with the free tier on (SIGNUP_BONUS_ENABLED), 邀请体验 as before otherwise. */
export function footerNote(freeTier: boolean | undefined) {
  return `${freeTier ? '免费体验' : '邀请体验'} · 回复由AI生成`;
}

/** Part 17: with the legal pages published (LEGAL_PAGES_ENABLED) the footer line links them. Nothing is added otherwise. */
export function appendLegalLinks(note: Element | null, enabled: boolean | undefined) {
  if (!enabled || !note) return;
  for (const [text, href] of [
    ['用户协议', '/terms.html'],
    ['隐私政策', '/privacy.html'],
  ] as const) {
    const link = document.createElement('a');
    link.className = 'legal-link';
    link.textContent = text;
    link.setAttribute('href', href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener');
    note.append(' · ', link);
  }
}
