/**
 * Part 25b: the welcome on a character's 小卡 is voice only - a play pill with a waveform and the length, no words. The words of a
 * welcome are still there in the chat (转文字), but never on the card.
 */
import { escapeCardText } from './provider-catalog-view.ts';

/** The waveform's bar heights (design/burbur-v2 Shared board), drawn as one path: no markup per bar, no style attribute. */
const WAVE = [8, 12, 18, 22, 14, 10, 20, 22, 16, 12, 20, 14, 8, 18, 22, 16, 10, 14, 22, 18, 12, 16, 8, 20, 12, 18];
const wave = () => WAVE.map((height, i) => `M${2 + i * 4} ${12 - height / 2}v${height}`).join('');

/** 0:06 - whole seconds, at least one. */
export const formatDuration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export function voicePill(name: string, durationMs: number | null | undefined) {
  const time = typeof durationMs === 'number' && durationMs > 0 ? formatDuration(durationMs) : '';
  return `<button class="face-voice" type="button" aria-label="播放${escapeCardText(name)}的语音"><span class="face-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span><svg class="face-wave" viewBox="0 0 106 24" preserveAspectRatio="none" aria-hidden="true"><path d="${wave()}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>${
    time ? `<span class="face-dur">${time}</span>` : ''
  }</button>`;
}
