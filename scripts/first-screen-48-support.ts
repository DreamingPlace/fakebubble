/**
 * Part 48 support for the first-screen browser check and the before/after measurement: the throttle profiles, and a Turnstile that
 * behaves like production but needs no secret. The page talks to the REAL local server; a route in front of it answers what the Cloudflare
 * edge would:
 *   - GET /bootstrap with no token and no cookie -> 403 TURNSTILE_REQUIRED (the page then loads the real Turnstile script and solves it
 *     with Cloudflare's published TEST site key, which always passes);
 *   - GET /account names that site key in its features (that is how the page learns it).
 * Nothing here is a secret: 1x00000000000000000000AA is Cloudflare's documented always-pass test key.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Any = any;
import { playerCsp } from '../apps/server/cloudflare/web-assets.ts';
export const TEST_SITE_KEY = '1x00000000000000000000AA';

/** Chrome DevTools-style profiles. "Fast 4G" is the acceptance profile (with a 4x CPU slowdown); "Slow 4G" is the harsher one. */
export const PROFILES = {
  fast4g: {
    label: 'Fast 4G (9 Mbps down, 1.5 Mbps up, 60 ms RTT) + 4x CPU',
    down: 9_000_000,
    up: 1_500_000,
    latency: 60,
    cpu: 4,
  },
  slow4g: {
    label: 'Slow 4G (1.6 Mbps down, 750 kbps up, 150 ms RTT) + 4x CPU',
    down: 1_600_000,
    up: 750_000,
    latency: 150,
    cpu: 4,
  },
} as const;
export type ProfileName = keyof typeof PROFILES;

export async function throttle(context: Any, page: Any, name: ProfileName) {
  const profile = PROFILES[name];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latency,
    downloadThroughput: profile.down / 8,
    uploadThroughput: profile.up / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  return cdp;
}

export interface TurnstileStats {
  /** bootstrap answers refused for want of a token */
  refused: number;
  /** bootstrap calls that carried a token */
  withToken: number;
  /** every request that was not a GET, in order, with the number of bootstraps that had passed by then */
  writes: { call: string; sessionsBefore: number }[];
}

export async function turnstileRoutes(context: Any, origin: string, options: { siteKey?: string } = {}) {
  const stats: TurnstileStats = { refused: 0, withToken: 0, writes: [] };
  let sessions = 0;
  const base = '/api/web/provider';
  // The page's CSP names Cloudflare's hosts only when the edge runs with TURNSTILE_ENABLED; the local server has no such switch, so the
  // document answers with the very policy the edge sends in that case.
  await context.route(
    (url: URL) => url.origin === origin && !url.pathname.startsWith(base) && !url.pathname.startsWith('/assets/'),
    async (route: Any) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': playerCsp(true) },
      });
    },
  );
  await context.route(`${origin}${base}/**`, async (route: Any) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(base.length);
    if (request.method() !== 'GET' && request.method() !== 'HEAD')
      stats.writes.push({ call: `${request.method()} ${path}`, sessionsBefore: sessions });
    if (path === '/bootstrap') {
      const token = request.headers()['x-turnstile-token'];
      if (!token && (await context.cookies(origin)).length === 0) {
        stats.refused++;
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'TURNSTILE_REQUIRED', requestId: null, retryAfterMs: null } }),
        });
      }
      if (token) stats.withToken++;
      sessions++;
      return route.continue();
    }
    if (path === '/account') {
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({
        response,
        json: { ...body, features: { ...(body.features ?? {}), turnstileSiteKey: options.siteKey ?? TEST_SITE_KEY } },
      });
    }
    return route.continue();
  });
  return stats;
}

/** Records the moments the page shows what, with the page's own clock (installed before any script of the page runs). */
export const TIMING_SCRIPT = `
  (() => {
    const t = { paints: {}, card: null, ready: null, sheet: null, parsed: null };
    window.__first = t;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) t.paints[e.name] = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    const look = () => {
      const now = performance.now();
      if (t.card === null && document.querySelector('.card-slot:not(.is-skeleton) .face-name-text')) t.card = now;
      if (t.ready === null && document.querySelector('.card-slot[data-ready="true"]')) t.ready = now;
      if (t.sheet === null && document.querySelector('.vs-root[data-open="true"]')) t.sheet = now;
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true });
    document.addEventListener('DOMContentLoaded', () => {
      // what #app holds once the page is parsed: Part 48's static skeleton (the old page: nothing)
      t.parsed = { app: document.getElementById('app')?.children.length ?? 0, at: performance.now() };
      look();
    });
  })();`;

/**
 * The console fixture starts every browser context's clock at its own frozen date (so pages agree with the server's frozen clock).
 * Cloudflare's real Turnstile checks the device's time against its own and refuses a clock that is days off (error 200100), so a
 * context that solves the real widget puts its clock back on real time.
 */
export async function realClock(context: Any) {
  await context.clock.setSystemTime(Date.now());
  await context.clock.resume();
}
