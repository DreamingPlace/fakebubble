# Part 24f review screenshots

Synthetic data, Chromium 1440×900, produced by `pnpm check:web:history -- <dir>` on the PR branch `claude/part-24f-history-restore`
(the two `00-before-*` images are the same pages on `main`, before the change).

| file | what it shows |
|---|---|
| 00-before-workbench / 00-before-members | 角色工作台 and 管理员与权限 on main (delete item in the matrix, no history) |
| 01-history-list | 版本历史 as the owner: newest first, 现行 mark, role label, origin, summary, 不可恢复 row |
| 02-snapshot-and-diff | an opened snapshot (read only) with its difference from the live version |
| 03-restore-confirm | the one confirm dialog |
| 04-unrestorable-row | a 不可恢复 version with its reason |
| 05-restore-busy | restore refused while a player task is unfinished |
| 06-after-restore | the restore published as a new live version, 恢复自 vN |
| 07-stale-draft | a draft whose base is now older than live (the draft panel behaves as before) |
| 08-non-owner-list / 08b-non-owner-snapshot | a non-owner: history and snapshots, no restore button, no 删除角色 |
| 09-members-without-delete | 管理员与权限 without a delete item; an old stored grant shown as 已失效 |
