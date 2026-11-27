/**
 * Part 36: the quote of a bubble. Two pieces: the strip above the composer (with ✕) and the block inside a sent bubble. Both show who
 * wrote the quoted bubble (an accent bar for the character, a neutral bar for the player), a short name and one clipped line. A quoted
 * message that is gone shows the same block dimmed and empty: no sentence says why. Tapping the block in a bubble scrolls to the
 * original (when it is on the page) and flashes it once.
 */
export interface QuoteDraft {
  messageId: string;
  author: 'player' | 'character';
  /** null: the original is gone. */
  text: string | null;
}

const clip = (text: string, limit = 120) => [...text].slice(0, limit).join('');

export function quoteBlock(quote: QuoteDraft, name: string, interactive = true): HTMLElement {
  const block = document.createElement('span');
  block.className = `quote-ref${quote.text === null ? ' is-gone' : ''}`;
  block.dataset.from = quote.author === 'character' ? 'her' : 'me';
  block.dataset.quoteId = quote.messageId;
  const body = document.createElement('span');
  if (quote.text !== null) {
    const who = document.createElement('b');
    who.textContent = quote.author === 'character' ? name : '我';
    body.append(who);
  }
  const line = document.createElement('i');
  line.textContent = quote.text === null ? '' : clip(quote.text);
  body.append(line);
  block.append(body);
  if (quote.text !== null && interactive) {
    block.setAttribute('role', 'button');
    block.tabIndex = 0;
    const go = (event: Event) => {
      event.stopPropagation();
      scrollToMessage(block, quote.messageId);
    };
    block.addEventListener('click', go);
    block.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        go(event);
      }
    });
  }
  return block;
}

export function scrollToMessage(from: HTMLElement, messageId: string) {
  const list = from.closest('.chat-body') ?? document;
  const target = Array.from(list.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (row) => row.dataset.messageId === messageId,
  );
  if (!target) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  target.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  target.classList.remove('is-flash');
  // restart the animation
  void target.offsetWidth;
  target.classList.add('is-flash');
  window.setTimeout(() => target.classList.remove('is-flash'), 1400);
}

/** The strip above the composer's field. `onClear` runs for ✕. */
export function quoteStrip(quote: QuoteDraft, name: string, onClear: () => void): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'quote-strip';
  // inside the composer a tap on the block does not scroll away from what is being typed
  const block = quoteBlock(quote, name, false);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'quote-strip-x';
  clear.setAttribute('aria-label', '取消引用');
  clear.textContent = '✕';
  clear.addEventListener('click', onClear);
  strip.append(block, clear);
  return strip;
}
