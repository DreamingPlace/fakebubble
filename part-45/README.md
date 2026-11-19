# Part 45 design board: 分享 on a voice message, the share state, the opened link page

Boards (6 frames each, day and night): board-android-{light,dark}.png (412x915 @3.5), board-ios-{light,dark}.png (iPhone 15 profile), board-desktop-{light,dark}.png (1440x900).
NOTE: WebKit is not installed in this build container, so the "ios" boards are Chromium with the iPhone 15 device profile, not real WebKit. Real WebKit shots to be taken when available; the final browser script runs WebKit when present.
Frames come from the real player page (real CSS, real chat DOM, real renderSharedCard); the 分享 icon, sheet and expired page are proposals injected on top.

Proposal
1. Entry: a 44px 分享 icon beside each voice bubble (only voice messages), always visible, quiet (72% ink), no long-press.
2. Tap: a bottom sheet slides up (360ms, same bb-sheet motion; on desktop a popover anchored to the icon, 240ms pop). It holds a mini card (character, No., length), the link, 复制链接 and (phones) 分享 (system share sheet). The icon stays lit while open.
3. Creating: link row shimmers, buttons dim. Ready: link shown. Copied: 复制链接 morphs to a green 已复制 tick.
4. A playing voice message is never touched: the sheet is a non-modal overlay for audio, nothing pauses, ducks or restarts it.
5. Link page: the existing card page without the quote line or date/time; play pill + length. Expired: neutral grey card, 链接已过期, 也来聊聊 (no 这是什么？, no hint line).
No explanatory text anywhere on player pages (no "valid for 1 day").

Owner decision needed: the expired/unknown page cannot say 也和{角色}聊聊 without revealing that the token existed and which character it was (you asked unknown and expired to look identical). Proposed: one generic 也来聊聊 for both. Alternative: show the character only for expired tokens (leaks existence).
