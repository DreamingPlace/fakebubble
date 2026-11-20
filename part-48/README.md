# Part 48 — mobile first screen

Cold, new-visitor mobile loads (Pixel 7 viewport, 4x CPU, real Cloudflare Turnstile with the published test site key), before (b822d25) and after:

- `video/before-cold-mobile-fast4g.webm` / `video/after-cold-mobile-fast4g.webm` — Fast 4G (9 Mbps, 60 ms)
- `video/before-cold-mobile-slow4g.webm` / `video/after-cold-mobile-slow4g.webm` — Slow 4G (1.6 Mbps, 150 ms)
- `built/` — pictures taken by `scripts/check-web-first-screen-48-browser.ts`: the skeleton and the real cards at phone / small phone / tablet / desktop, the verification sheet after a failed check, the chat after a retry and after the background pass.
- `built/first-screen-48-metrics.json` — the check's numbers.

Impeccable is not installed in this environment; the critique / audit / polish passes were done by hand on these pictures.
