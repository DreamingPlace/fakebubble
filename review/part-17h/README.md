# Part 17h screenshots (review only, never on main)

Pages are the real built player (`?mode=provider`) driven by real server answers: `/bootstrap` and `/account` were captured
from the workerd retention-world fixture in each state, then replayed to the page. 1 = plain guest past the 7-day window
(trial-ended header and the signup prompt, no model picker, no balance). 2 = invited player with no login whose invite is
gone (header 邀请已失效, composer off). 3 = the new message when a send is answered `WEB_INVITE_ACCESS_REQUIRED` (HTTP 410)
by a page that still thought it could send (header text in this shot is the stale page's; the toast is the point).
4 = signed-up player whose invite later expired: 剩余 138 点 · 约可聊 11 条 and it chats on points (was HTTP 410).
5 = old account with a login and no bonus row, trial long over: bonus granted once on first touch, chats on points.
