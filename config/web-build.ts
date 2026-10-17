/**
 * The commit this code was built from. A constant, not a runtime lookup: the Cloudflare package step
 * (scripts/web-cloudflare-package.ts) rewrites the value below in the packaged copy only, from `git rev-parse HEAD`
 * (or WEB_BUILD_COMMIT); everywhere else - source checkout, tests - it stays 'unbuilt'. Shown by operator inspect so an
 * operator can tell which code is answering.
 */
export const WEB_BUILD_COMMIT = 'unbuilt';
