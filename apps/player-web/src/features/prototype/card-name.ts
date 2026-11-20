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

/**
 * Part 46: a change smaller than this (a fraction of the current size) is not written. The text's width is read in whole pixels, so two
 * reads of the same name differ by up to 0.5 px (0.2%); anything under this is that noise, and writing it would move the name (and the
 * voice bar placed from it) for nothing. The fit aims 2% inside the room, so skipping a 0.8% step never lets the name touch the edge.
 */
export const NAME_SIZE_EPSILON = 0.008;
/** The most times one card's fit writes without its width changing in between: a stop for anything that would not settle. */
export const NAME_FIT_WRITES = 6;

interface FitState {
  fitting: boolean;
  width: number;
  writes: number;
}
const states = new WeakMap<HTMLElement, FitState>();

/**
 * Fit the card's name to its width. It MEASURES WITHOUT WRITING: the text's width at the size it has now, scaled to NAME_SIZE_MAX
 * (width is proportional to size), against a room worked out from the card face's width alone, never from the name box or the text.
 * It writes `--name-size` once, and only when the result differs from the current size by more than NAME_SIZE_EPSILON. It does not
 * re-enter itself. Skipped while the card has no width yet.
 */
export function fitCardName(card: HTMLElement) {
  const state = states.get(card) ?? { fitting: false, width: 0, writes: 0 };
  states.set(card, state);
  if (state.fitting) return;
  const face = card.querySelector<HTMLElement>('.card-face:not(.face-reserve)');
  const box = face?.querySelector<HTMLElement>('.face-name');
  const text = box?.querySelector<HTMLElement>('.face-name-text');
  if (!face || !box || !text) return;
  state.fitting = true;
  try {
    // the room is the face's own content width (its width less its padding): it does not depend on the name, whatever the name's box does
    const faceStyle = getComputedStyle(face);
    const room = face.clientWidth - Number.parseFloat(faceStyle.paddingLeft) - Number.parseFloat(faceStyle.paddingRight);
    if (!(room > 0)) return;
    if (Math.abs(room - state.width) > 0.5) {
      state.width = room;
      state.writes = 0; // the card changed width: the fit may write again
    }
    // layout widths, not bounding rects: the name pops in with a scale animation, which a rect would include
    const fontPx = Number.parseFloat(getComputedStyle(box).fontSize);
    if (!(fontPx > 0)) return;
    const natural = ((text.offsetWidth - 0.24 * fontPx) * (NAME_SIZE_MAX * room)) / fontPx; // the text's width at NAME_SIZE_MAX
    const next = fitNameSize(natural, room);
    const current = fontPx / room;
    if (Math.abs(next - current) <= NAME_SIZE_EPSILON * current) return;
    if (state.writes >= NAME_FIT_WRITES) return;
    state.writes += 1;
    card.style.setProperty('--name-size', String(Math.round(next * 10000) / 10000));
  } finally {
    state.fitting = false;
  }
}

/**
 * Fit now, when the card's WIDTH changes, and when the fonts have arrived (a font changes the width of the text). Only the card's own
 * face is observed for size: never the text, whose size this very function sets.
 */
export function watchCardName(card: HTMLElement) {
  if (watching.has(card)) return;
  watching.add(card);
  const fit = () => fitCardName(card);
  const face = card.querySelector<HTMLElement>('.card-face:not(.face-reserve)');
  if (face && typeof ResizeObserver !== 'undefined') {
    let width = -1;
    new ResizeObserver(() => {
      if (Math.abs(face.clientWidth - width) < 0.5) return; // a change of height, or of nothing, is not a reason to fit
      width = face.clientWidth;
      fit();
    }).observe(face);
  }
  // the name itself changing (a rename while the page is open) is a change of WORDS, seen by a mutation observer: that is not a size,
  // so setting --name-size can never wake it
  const text = card.querySelector<HTMLElement>('.face-name-text');
  if (text && typeof MutationObserver !== 'undefined')
    new MutationObserver(fit).observe(text, { characterData: true, childList: true, subtree: true });
  void document.fonts?.ready.then(fit);
  // a face that loads late (the device's Latin face is fetched when the first name uses it) changes the text's width
  document.fonts?.addEventListener?.('loadingdone', fit);
  fit();
}
const watching = new WeakSet<HTMLElement>();
