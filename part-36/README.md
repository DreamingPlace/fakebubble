# Part 36 design board: several bubbles in a row, one long-press menu, quote-reply, the rated mark

Boards (6 frames each, day and night): `board-android-{light,dark}.png` (412x915 @3.5, Chromium, Android UA), `board-ios-{light,dark}.png` (iPhone 14 profile on REAL WebKit), `board-desktop-{light,dark}.png` (1440x900). Single frames: `frames/`.
Frames come from the real player page (real CSS, real chat DOM, offline fixture provider); batch, menu, quote and rated mark are proposals injected on top (`scripts/shoot-part-36-board.ts` on branch `part-36`). Board-only artefact: in frame 3 the lifted voice bubble is a DOM clone and loses its purple play disc; the build lifts the real bubble.

## Proposal
1. **Several in a row (frame 1).** Consecutive own bubbles stack tight (3 px gap, only the last keeps the full tail radius). Three quiet dots under the batch mark "she has not started" (no text). Each bubble is stored the moment it is sent.
2. **She starts replying (frame 2).** The header changes to 「正在讲话中」 (existing rule, same cross-fade); her voice bubble pops in under the batch. Bubbles sent now sit below it and wait for the next turn.
3. **Long-press menu (frames 3, 4).** Press ~450 ms (a small haptic where the phone has one): the page blurs and dims (180 ms), the bubble lifts 3.5 % with a soft shadow, and a pill menu springs out of the bubble (240 ms, origin at the bubble). On her voice message: 引用 · 分享为卡片 | 👍 · 👎. On her text-fallback reply: 引用 | 👍 · 👎. On the player's own bubble: 引用 only. On the welcome clip and the trial footer: 引用 only (no sharing, no rating). Tap outside, scroll or Back closes it; it opens no history entry of its own beyond Part 46's one-layer rule. A playing voice is never paused, ducked or restarted by the press or the menu.
4. **Quote (frame 5, 6).** Choosing 引用 slides a quote strip into the composer (accent bar for her bubble, neutral bar for the player's own, short name, one clipped line, 44 px ✕). Sent, the quote sits inside the top of the bubble; tapping it scrolls to the original and flashes it once. A deleted original shows the same strip, dimmed, with no text.
5. **Rated (frame 6).** A 24 px round mark on the bubble's lower corner: 👍 in the character's accent, 👎 in neutral grey; it pops in (320 ms). Tapping the same button again removes it, the other switches it. No text to the player.
6. **Voice bubble without the share icon (frames 2, 3, 6).** The 44 px 分享 icon beside voice messages is gone; sharing lives only in the menu (it opens the Part 45 share sheet).
No explanatory text anywhere; reduced-motion drops the lift/pop to a fade.

## Owner decisions needed before I build
- Menu labels: icon + word for 引用 / 分享为卡片, icon-only 👍 / 👎 (as drawn). OK, or words on all four?
- Rated mark sits outside the bubble corner (as drawn) vs inside the bubble. OK?
- Welcome clip and trial footer: 引用 only. OK?
- Quote strip shows a short name (瓜瓜 / 我). Drop the names and use the bar colour only?

Not started yet (waiting for your OK): store, business object, alarm, writer changes, admin page 「语音反馈」, tests. The one thing I can already say: batching and feedback look doable with **runtime steps only** (no numbered migration 132); I will STOP and ask before building one if that changes.
