# Contributing

## Setup and checks

Requires Node 24.19+ (24.x) and pnpm 11.19.0. The Node range is enforced: `engineStrict: true` in
`pnpm-workspace.yaml` makes `pnpm install` fail on any Node version outside `engines` in `package.json` (for example Node 22,
on which many tests fail). Switch to Node 24.19+ instead of working around it.

```sh
pnpm install --frozen-lockfile
pnpm format        # apply the Biome formatter
pnpm check         # format:check, typecheck and all tests
pnpm web:player:build
pnpm check:web:local-http
pnpm check:web:restart
```

Browser checks: `pnpm web:player:build` first, then `pnpm check:web:all` runs every `scripts/check-web-*-browser.ts` (found by file
name, one at a time, a few named stale ones skipped with their reason in the script) and prints a table of name / exit code /
seconds, also written to `work/check-web-all/results.json`; `pnpm check:web:all -- part-44 share-45` runs only the matching ones.
A new Part adds its script file and no `package.json` line, and writes its status notes to its own `docs/status/part-XX.md`
instead of appending to `docs/STATUS.md`, so parallel PRs no longer conflict on those two files.

All of these must pass before a change is ready. Tests use offline fixtures only: no real provider calls, no emails, no
deploys.

## Branches and commits

- Branch from `main`, using a short descriptive name such as `part-1-baseline` or `fix/queue-retry-copy`.
- Keep commits small with clear messages. Formatting-only changes go in their own commit and are added to
  `.git-blame-ignore-revs`.

## Tests and invariants are never weakened

Do not edit, skip or delete a test to make it pass, and do not relax these invariants:

- the business object is the only writer of state;
- budget is reserved before every provider call;
- a call whose result is unknown is never retried and its reservation is never released;
- identity, world and conversation scoping on every private read;
- CSRF and origin checks;
- request immutability;
- idempotent dispatch.

## Security

Never commit secrets, keys, real character materials or runtime data. See [SECURITY.md](SECURITY.md) for the security
policy and how to report a vulnerability.
