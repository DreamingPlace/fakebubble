# Part 24f review screenshots (on the Part 24b-6 console)

Synthetic data, Chromium 1440×900, produced by `pnpm check:web:history -- <dir>` on the PR branch `claude/part-24f-history-restore`
(rebased onto main with PR #57). They replace the earlier set, which was drawn on the old console.

| file | what it shows |
|---|---|
| 01-history-list | 版本历史 as the owner: one more entry of the section bar, 现行 mark, role label, origin, summary, 不可恢复 row |
| 02-snapshot-and-diff | an opened snapshot: the difference from live (the 资料改动 comparison) and the read-only fields |
| 03-restore-confirm | the one confirm dialog, 恢复此版本 as the primary action |
| 04-unrestorable-row | a 不可恢复 version with its reason |
| 05-restore-busy | restore refused while a player task is unfinished |
| 06-after-restore | the restore published as a new live version, 恢复自 vN |
| 07-stale-draft | a draft whose base is now older than live; 删除角色 in the danger zone (owner) |
| 08-non-owner-list / 08b-non-owner-snapshot | a non-owner: history and snapshots, no restore button, no 删除角色 |
| 09-members-without-delete | 管理员与权限 without a delete item; an old stored grant reads 删除角色（已失效） |
