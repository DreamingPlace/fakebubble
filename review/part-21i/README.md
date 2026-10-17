# Part 21i screenshots

Real player build (`pnpm web:player:build`, `?mode=provider`) in headless Chromium, against a scripted stand-in for
`/api/web/provider` (synthetic data only). Desktop is 1280 x 860, phone is 390 x 844. Never merged into main.

| file | what it shows |
| --- | --- |
| `*-1-cocreation-one-card-used` | co-creation sheet: one card answered today is disabled and says 今天已回答，明天再来; the others stay open |
| `*-2a-guest-more-menu` | a guest's 更多 menu: 消费记录 is back (no small print) |
| `*-2b-billing-guest` | 消费记录 for a guest: 免费试用 已用 3/5 条 and the trial replies, no balance |
| `*-2c-billing-signed-up` | 消费记录 for a signed-up player: 免费额度 130 点 · 已用 69 · 剩余 61, trial replies as 免费试用 / 0 点 |
| `*-3-account-dropdown` | the top-bar account dropdown: labels only |
| `*-4a` … `*-4d` | login errors: 这个邮箱还没有注册 (with 去注册), 密码不正确, 尝试次数太多，请稍后再试, 网络异常，请重试 |
| `*-5-signup-mismatch` | signup with two password fields: 两次输入的密码不一致 and the submit button disabled |
| `*-6-password-toggle-shown` | a password field with its 显示密码 / 隐藏密码 toggle pressed |
