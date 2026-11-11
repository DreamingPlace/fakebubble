/** Display-only pause between already-published bubbles. Never re-roll or re-generate a reply. */
export function replyPauseMs(message) {
    return Math.max(1200, Math.min(4000, message.audio?.durationMs ?? 800 + [...message.text].length * 70));
}
