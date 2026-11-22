/**
 * Part 49: ONE way to show a playing voice. The played part of the waveform's bars is painted in the character's main colour: a copy of
 * the bars (`.pk-played`) sits over the grey ones and is clipped to the playhead by `--pk-progress` (0..1) on the voice button.
 * Used by the chat's voice bubbles and welcome row (a `.sound-bars` drawing), the home card's pill and the shared page (`.face-bars`).
 * There is no separate progress line anywhere.
 */

/** The wrapper that holds the bars of a voice button: the chat's `.sound-bars`, or the pill's `.face-bars`. */
const barsOf = (button: HTMLElement) => button.querySelector<HTMLElement>('.sound-bars, .face-bars');

/** Makes the played copy of the bars if the button has none yet (the pill draws its own in markup). */
export function ensurePlayedBars(button: HTMLElement) {
  const bars = barsOf(button);
  const drawing = bars?.querySelector('svg');
  if (!bars || !drawing || bars.querySelector('.pk-played')) return;
  const copy = drawing.cloneNode(true) as SVGElement;
  copy.classList.add('pk-played');
  copy.setAttribute('aria-hidden', 'true');
  bars.append(copy);
}

/** Moves the playhead: `fraction` of the clip played, clamped to 0..1. */
export function setVoiceProgress(button: HTMLElement, fraction: number) {
  ensurePlayedBars(button);
  button.style.setProperty('--pk-progress', String(Math.min(1, Math.max(0, fraction))));
}

/** Back to the start: the played colour is gone. */
export function clearVoiceProgress(button: HTMLElement | null | undefined) {
  button?.style?.removeProperty?.('--pk-progress');
}
