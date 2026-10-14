/**
 * Part 19 (CHAT_REVIEW_ENABLED): a one-time banner at the top of every chat telling the player that, while testing, an
 * administrator may read whole chats under an anonymous code. It shows until the player closes it with ×; the close is
 * remembered per principal on the server. It is plain page furniture: it never disables, delays or reorders sending.
 */
export const reviewBannerCopy = {
  lead: '测试期间，管理员可能以匿名编号（如 JOJO-AX01）查看聊天全文，用于改进角色。详见',
  privacy: '隐私政策',
  close: '关闭提示',
};

/** Builds one banner element (the page puts one at the top of each chat). */
export function createReviewBanner(onClose: () => void) {
  const banner = document.createElement('div');
  banner.className = 'review-banner';
  banner.setAttribute('role', 'note');
  const text = document.createElement('p');
  text.className = 'review-banner-text';
  text.append(reviewBannerCopy.lead);
  const link = document.createElement('a');
  link.textContent = reviewBannerCopy.privacy;
  link.setAttribute('href', '/privacy.html');
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener');
  text.append(link);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'review-banner-close';
  close.setAttribute('aria-label', reviewBannerCopy.close);
  close.textContent = '×';
  close.addEventListener('click', onClose);
  banner.append(text, close);
  return banner;
}

/**
 * Puts the banner between each card's header and its message list. `closed` is what the server remembers; `persist` tells the
 * server (best effort: a failed call only means the banner may come back on the next visit). Returns the banners.
 */
export function mountReviewBanners(
  cards: Iterable<HTMLElement>,
  options: { closed: boolean; persist: () => Promise<void> },
) {
  if (options.closed) return [] as HTMLElement[];
  const banners: HTMLElement[] = [];
  const hideAll = () => {
    for (const banner of banners) banner.remove();
    banners.length = 0;
    void options.persist().catch(() => {});
  };
  for (const card of cards) {
    const body = card.querySelector<HTMLElement>('.chat-body');
    if (!body || card.querySelector('.review-banner')) continue;
    const banner = createReviewBanner(hideAll);
    body.before(banner);
    banners.push(banner);
  }
  return banners;
}
