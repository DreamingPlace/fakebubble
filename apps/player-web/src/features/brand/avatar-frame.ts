/**
 * Part 25b: avatar frames. A frame is a ring of three colours around a soft fill, with a thin gap of page colour between them
 * (the design's "aura ring"). A character's frame comes from the colour the card already carries (its published main colour, else
 * today's palette, else the neutral one); the player's own comes from a small set they pick from.
 */
import type { Aura } from './character-colour.ts';

export type FrameStops = readonly [string, string, string];
export type Frame = { ring: FrameStops; fill: readonly [string, string] };

export const PLAYER_FRAMES = [
  { id: 'soft', label: '柔光', ring: ['#FFB295', '#BBA4FF', '#97C8F5'] },
  { id: 'peach', label: '蜜桃', ring: ['#E8561E', '#FFB295', '#FFEBC9'] },
  { id: 'sky', label: '天空', ring: ['#2F7BEA', '#97C8F5', '#D5F6EE'] },
  { id: 'mint', label: '薄荷', ring: ['#1F9E7A', '#8FD9BE', '#D5F6EE'] },
  { id: 'grape', label: '葡萄', ring: ['#7C4DEB', '#BBA4FF', '#FFD8EE'] },
  { id: 'ink', label: '墨', ring: ['#141414', '#4A4A4A', '#141414'] },
] as const;
export type FrameId = (typeof PLAYER_FRAMES)[number]['id'];
export const DEFAULT_FRAME: FrameId = 'soft';
export const isFrameId = (value: unknown): value is FrameId => PLAYER_FRAMES.some((frame) => frame.id === value);

/** The frame of a character: ring accent, deep cloud, light cloud; the fill is the card's own two clouds. */
export function characterFrame(aura: Aura): Frame {
  return { ring: [aura[3], aura[2], aura[1]], fill: [aura[2], aura[1]] };
}
export function playerFrame(id: FrameId): Frame {
  const frame = PLAYER_FRAMES.find((entry) => entry.id === id) ?? PLAYER_FRAMES[0];
  return { ring: frame.ring, fill: ['#F2EEE9', '#E9E2F2'] };
}

/** Custom properties through the CSSOM (strict CSP: no style attribute). `prefix` names the set: --frame-a... or --own-a... */
export function setFrameProperties(element: HTMLElement, frame: Frame, prefix: 'frame' | 'own') {
  const names = ['a', 'b', 'c'] as const;
  names.forEach((name, i) => element.style.setProperty(`--${prefix}-${name}`, frame.ring[i]!));
  element.style.setProperty(`--${prefix}-f1`, frame.fill[0]);
  element.style.setProperty(`--${prefix}-f2`, frame.fill[1]);
}
