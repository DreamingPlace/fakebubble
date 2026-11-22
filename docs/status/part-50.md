# Part 50 — the first tap without waiting (verification at page load) and fewer merge conflicts

## 1. Verification starts at page load

**What changed (no migration, no pinned prompt or policy hash, no server-side security change).**

- The session (bootstrap) starts at page load, in parallel with the public catalog read, not after the catalog (and not after the first paint's grace). The catalog is requested first; the bootstrap is requested in the same tick.
- The public catalog answer carries the PUBLIC Turnstile site key (`turnstileSiteKey`, only when the server asks for the check; same character set rule as before). The page no longer needs `/account` to learn it; `/account` is still the fallback when the bootstrap's refusal arrives before the catalog.
- For a visitor with no session on this device (a boolean hint `fakebubble.session-seen.v1`, no id and no content), the invisible challenge is rendered as soon as the key is known, before the cards' own drawing work. Its token is used ONCE, only for the new guest's bootstrap and only after the server answered `TURNSTILE_REQUIRED`; a failed early check is reported only when its token is needed (the same sheet and 重试 as before). A returning visitor starts no early challenge.
- The document response carries `Link: <…/turnstile/v0/api.js?render=explicit>; rel=preload; as=script, <https://challenges.cloudflare.com>; rel=preconnect` only when `TURNSTILE_ENABLED` (a header, so the manifest-verified bytes are untouched; without Turnstile nothing is sent and the CSP still refuses the host). `index.html` also has a `preconnect` to the host (harmless without Turnstile). Cloudflare's script is loaded async, early, by the page's own loader as soon as the key is known.
- The widget renders with `execution: 'render'` and `appearance: 'interaction-only'`: silent unless Cloudflare asks for a click; only then does the verification sheet show, and only on the first action that needs a session (as before).
- Security unchanged: a guest is created only by a bootstrap that carries a passed challenge; no write, no provider call and nothing that costs money runs before a session; no secret anywhere (Cloudflare's published always-pass test key in the checks).

**Measured** (cold, new visitor, Pixel 7 viewport, Fast 4G + 4× CPU, the real Turnstile with the test key, `scripts/measure-first-screen-48.ts`, 8 runs each, same machine, alternating):

| | page load → session ready (median, range) | first real card (median) |
|---|---|---|
| before (origin/main) | 3.53 s (3.41 – 3.99 s; one 7.5 s outlier) | 1.19 s |
| after | 3.15 s (2.95 – 3.43 s) | 1.38 s |

About 0.4 s (11 %) faster to a ready session. The first card is about 0.2 s later in the median (the challenge frame now competes with the cards' drawing on a 4×-throttled CPU; still within the 1.5 s median-of-3 limit of the Part 48 check).

**Where the time goes (after, one cold run):** app script runs and the bootstrap leaves at ~0.6 s (parse and run on a throttled CPU); Cloudflare's script arrives by ~0.15 s (preloaded, no longer on the critical path); the widget's challenge frame starts at ~0.65 s and returns its token at ~2.8–3.1 s; the token-carrying bootstrap is answered ~80 ms later. That is **about 2.0 – 2.3 s of the ~3.1 s in Cloudflare's challenge itself**. What the page can do (start it earlier, take the key from the catalog, preload the script) is done; the rest is Cloudflare's. For the owner, in the Cloudflare Turnstile dashboard: check the widget **mode** is *Managed* (or *Non-interactive* / *Invisible*), never *Interactive* (which always asks for a click), and that the hostnames list contains the production host. A real phone's CPU is usually faster than the 4× throttle, so expect less than the numbers above; on a real phone, `https://challenges.cloudflare.com` taking long in the network panel points at Cloudflare/the carrier, not at the page.

**Checks.** `scripts/check-web-verify-50-browser.ts` (new, in two visits: catalog at once, and catalog held 1.5 s): the bootstrap request leaves before the catalog answer arrives; the session becomes ready with the Turnstile test key and no user action (no sheet, one refusal and one pass, no `/account` read before the token-carrying bootstrap, no write); the first tap opens the chat with no verification sheet and a message sends after the session; the document carries the preload/preconnect hint. Unit: `apps/player-web/tests/components/verify-50.test.ts` (strict catalog key, the Link header and CSP, the early token used once, a failed early check reported only when needed, no early check for a returning visitor). `scripts/measure-first-screen-48.ts` gained `--catalog-key on|off` and a request timeline.

## 2. Fewer merge conflicts (tooling only)

- `pnpm check:web:all` (`scripts/check-web-all.ts`): finds `scripts/check-web-*-browser.ts` by file name, adds `check-web-browser.ts` and the history check, runs them one at a time, prints a table of name / exit code / seconds and writes `work/check-web-all/results.json` (per-script logs next to it). `pnpm check:web:all -- part-44 share-45` filters by name. Skipped, each with its reason in the script: `admin-24b7c`, `cast-file`, `console-24b2`. New Parts add no `package.json` line; the existing `check:web:*` lines are unchanged.
- Status notes: from Part 50 on, each Part writes `docs/status/part-XX.md`. `docs/STATUS.md` got one line under its title pointing here; its content is untouched. CONTRIBUTING.md has the paragraph.
