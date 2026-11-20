/**
 * Part 44: the nickname on a home card. ONE size rule for every card: a fixed size (NAME_SIZE_MAX, a fraction of the card's width) that
 * shrinks only when the name would not fit the card's width (fit-to-width), never below NAME_SIZE_MIN. No table per length of name.
 * `--name-size` is what the card's other parts (the voice bar under the name) are placed from, as before.
 */
export const NAME_SIZE_MAX = 0.2;
export const NAME_SIZE_MIN = 0.065;

/**
 * The size for a name whose text is `naturalPx` wide at NAME_SIZE_MAX, in a name box `roomPx` wide (the card's width less the 16px it
 * keeps on each side). Text width is proportional to the size, so the fit is a plain ratio.
 */
export function fitNameSize(naturalPx: number, roomPx: number) {
  const room = roomPx;
  if (!(naturalPx > 0) || !(room > 0)) return NAME_SIZE_MAX;
  return Math.min(NAME_SIZE_MAX, Math.max(NAME_SIZE_MIN, (NAME_SIZE_MAX * room * 0.98) / naturalPx));
}

/** Measure the card's name at the maximum size and set `--name-size` to the fitted one. Skipped while the card has no width yet. */
export function fitCardName(card: HTMLElement) {
  const box = card.querySelector<HTMLElement>('.card-face:not(.face-reserve) .face-name');
  const text = card.querySelector<HTMLElement>('.face-name-text');
  if (!box || !text || box.offsetWidth === 0) return;
  card.style.setProperty('--name-size', String(NAME_SIZE_MAX));
  // layout widths, not bounding rects: the name pops in with a scale animation, which a rect would include
  const fontPx = Number.parseFloat(getComputedStyle(box).fontSize);
  const natural = text.offsetWidth - 0.24 * fontPx; // the text's own width: its padding is undone by its negative margin
  card.style.setProperty('--name-size', String(fitNameSize(natural, box.offsetWidth)));
}

/** Fit now, when the card is laid out or resized, and when the fonts have arrived (a font changes the width of the text). */
export function watchCardName(card: HTMLElement) {
  const fit = () => fitCardName(card);
  if (typeof ResizeObserver !== 'undefined') {
    const face = card.querySelector<HTMLElement>('.card-face:not(.face-reserve)');
    const text = card.querySelector<HTMLElement>('.face-name-text');
    const observer = new ResizeObserver(fit);
    // the text too: when the device's Latin face arrives late its width changes without any event on the fonts
    if (face) observer.observe(face);
    if (text) observer.observe(text);
  }
  void document.fonts?.ready.then(fit);
  // a face that loads late (the device's Latin face is fetched when the first name uses it) changes the text's width
  document.fonts?.addEventListener?.('loadingdone', fit);
  fit();
}
