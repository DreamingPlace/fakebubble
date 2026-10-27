# Apex cover (independent of the chat service)

Buildless HTML/CSS served by Cloudflare Workers Static Assets. No application Worker,
JavaScript, cookies, model calls, secrets, service bindings or database bindings.
The entry link navigates to the existing chat origin; it does not embed or proxy it.

The AdSense meta tag identifies the publisher for ownership verification only.
It does not load ads or imply review approval. Do not add ad scripts or submit a
review as part of deploying this cover.

The checked-in Wrangler configuration is closed by default (no routes,
workers.dev and preview URLs disabled). After explicit operator approval, create
a new private release snapshot, hash its assets, and generate a release config
with the approved account and the sole custom domain `4th-generation.fans`.
Do not redeploy `fake-paopao-web-*` or `fake-paopao-staging-*` for this page.

Before deployment, run the repository checks from CONTRIBUTING.md, the apex test,
and a Wrangler dry run. Verify that the apex has no conflicting DNS or Worker
binding. Record each write once; after an uncertain result, read back rather than
retrying. Verify public HTTPS, the meta tag, security headers, navigation and the
unchanged chat deployment. Keep deployment receipts and account details private.

The favicon is copied from `apps/player-web/src/assets/favicon.svg` to keep the
static deployment self-contained. The test guards against accidental drift.
