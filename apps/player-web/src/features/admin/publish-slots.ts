import type { ClipTakes, Slot } from '../../services/clip-takes-api.ts';

/** The owner's name for a slot: 欢迎 N counts the welcome lines in order; the footer is 结束. Never an id. */
export const slotLabel = (slots: Slot[], index: number) => {
  const slot = slots[index]!;
  return slot.kind === 'footer'
    ? '结束'
    : `欢迎 ${slots.slice(0, index + 1).filter((s) => s.kind === 'welcome').length}`;
};
export type SlotState = 'approved' | 'unapproved' | 'stale';
/**
 * Where one slot stands for a publication: its 选用 take is approved, is not approved yet, or is no longer usable (its text or
 * voice changed under it; with takes but none usable, the chosen one is gone).
 */
export function slotState(slot: Slot): SlotState {
  const chosen = slot.takes.find((take) => take.takeId === slot.selectedTakeId);
  if (chosen ? !chosen.usable : slot.takes.length > 0 && slot.takes.every((take) => !take.usable)) return 'stale';
  return chosen && slot.approved ? 'approved' : 'unapproved';
}
/** The first slot a publication cannot use, as the standing sentence; null when every slot is approved. */
export function publishBlocker(clips: ClipTakes): string | null {
  for (const [index, slot] of clips.slots.entries()) {
    const state = slotState(slot);
    if (state === 'stale') return `${slotLabel(clips.slots, index)} 的选用版本已失效，请重录或另选`;
    if (state === 'unapproved') return `${slotLabel(clips.slots, index)} 还没批准`;
  }
  return null;
}
