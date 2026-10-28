# Part 25b screenshots and recordings (real build of `claude/part-25b-player-ui`)

Taken with Chromium against the real player build and the offline provider server (`scripts/check-web-browser.ts`'s fixture).
Sizes: **390×844** (phone) and **1440×900**, each **light** (`-light-`) and **night** (`-dark-`, the system's dark mode).
Boards are in `design/burbur-v2/` on branch `design/burbur-v2`. Where a state needs a server setting the offline fixture does not
have, the one response is rewritten in the browser (listed below); nothing else is faked.

| Screenshots | What | Board |
|---|---|---|
| `home-*` | home: the stack (a phone shows the front card with neighbours peeking), the welcome as a play pill, the avatar oval | Main, Motion 1 |
| `chat-*` | a chat before any choice: centred header, avatars with the gap, the aura | Chat |
| `chat-custom-*` | the same chat with a custom background colour, the player's own frame (葡萄) and a sent message (desktop night has no message: the offline fixture's 3 trial replies were used up by the earlier shots) | Chat |
| `menu-*`, `look-*`, `look-custom-*` | the ⋯ menu with 外观, the 外观 sheet, and after picking a colour and a frame | — |
| `guest-prompt-*` | the guest's line in the middle of the chat (the response of `/bootstrap` gets `lockedCharacterIds: []`, what the server sends while GUEST_ONE_CHARACTER_ENABLED is on) | — |
| `myinfo-guest-*`, `myinfo-player-*` | 我的信息 for a trial guest and a registered player | MyInfo |
| `myinfo-refill-*`, `myinfo-unlimited-*` | 470 点 / 每天 +50 with the bar, and 不限量 (the response of `/account` gets a tier and a model state) | MyInfo |
| `shared-*` | the shared voice 小卡: 收到一张语音小卡, no nickname, 来聊几句嘛～ (the component, with sample data) | Shared |
| `signup-*`, `login-*`, `signed-out-*`, `invite-*` | sheets and pages in both themes; the account sheets slide up | — |
| `model-*`, `cocreate-*`, `after-cocreate-*`, `billing-*` | the model sheet, 共创 and 消费记录 in both themes (390 only; billing's tables are empty in the fixture) | — |

Recordings (webm, 390×844): `video/swipe-mobile.webm` (swiping through the stack, both ways, past an empty slot) and
`video/enter-chat-mobile.webm` (opening a chat: the card grows to fill the screen while the top bar lifts and fades, then back).

## Fix list from looking at every screenshot
- The footer note touched the chosen avatar's ring on a phone: the avatar row got more room (86 px, 20 px down).
- A phone's 共创 and 外观 sheets, 共创 cards, billing and the ⋯ button were unreadable in night: night rules added.
- The send button turned into a clear glass disc when hovered in night: the hover rule no longer applies to it.
- The shared card's page colour did not show (the custom properties live on the page, not on <html>): painted by the page.
- 我的信息: secondary pill buttons were nearly invisible on the white card; the card's tint is stronger.
- Escape in 外观 closed the chat behind it too: it stops there now. (The model sheet and the ⋯ menu's neighbours behave as before.)

## Reproduce
`pnpm web:player:build`, then from the repository root `node review/part-25b/tools/capture.ts <out> [guest|player|sheets|misc|video]`
(Playwright from `PLAYWRIGHT_MODULE` or the usual global directories, as in `scripts/check-web-browser.ts`). The shared card:
bundle `tools/shared-entry.ts` with esbuild to `tools/shared-bundle.js` (iife) and run `tools/shared-snap.ts <out>`.
