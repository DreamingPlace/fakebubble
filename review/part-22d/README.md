# Part 22d review material

Sample JSON of every new admin read route on a SEEDED SYNTHETIC database (in-memory SQLite through schema 130, synthetic
characters and players, synthetic clock; the numbers are not real). Not for main.

- `samples/chart-replies-{24h,7d,14d}.json`, `samples/chart-chat_users-{24h,7d,14d}.json`: `POST admin/stats/chart`
- `samples/spend-by-type-7.json`: `POST admin/stats/spend-by-type` (消耗表 by user type; the spend rows are seeded directly)

Regenerate from the PR branch: copy `samples-22d.ts` to the repo root, fix its two import prefixes to `./`, run `node samples-22d.ts out/`.
