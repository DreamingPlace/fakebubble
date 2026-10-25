import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { localRuntime, initProviderInstance } from '../apps/server/platform/web-local-config.ts';
import { WebProviderRunner } from '../apps/server/generation/web-provider-runner.ts';
import { WebProviderServer } from '../apps/server/generation/web-provider-server.ts';
import { DeepSeekTextGenerator } from '../apps/server/generation/deepseek.ts';
import { listPriceMicros, speechListMicrosPerByte } from '../apps/server/generation/model-list-prices.ts';
import { syntheticTone } from '../apps/server/platform/web-local-fake.ts';
import { WebAccountAdmin } from '../apps/server/admin/web-account-admin.ts';
import { registerSqlTextLoader } from './web-sql-text.ts';
import { migrateProvider, openProviderStore } from './web-provider.ts';
import { syntheticSelection } from '../tests/web/fixtures/provider-selection.ts';

/**
 * Part 24b-1 review material: the redone console pages in a REAL browser (Chromium) on SYNTHETIC numbers (a seeded generator
 * writes the counters straight into the tables, so a picture shows the layout of a busy site, not a real one). Screenshots at
 * 1440 and 1280 wide, a short recording of the navigation and the 消耗表 scale change, and checks that the pages work.
 *
 * usage: node scripts/capture-admin-24b1.ts <output-dir>     (run `node scripts/build-web-player.ts` first)
 */
registerSqlTextLoader();
const { expectedWebMigrations } = await import('../workers/web-cloudflare/migrations.ts');
const out = resolve(process.argv[2] ?? 'capture-24b1');
mkdirSync(out, { recursive: true });
const tmpVideo = join(out, '.video');
mkdirSync(tmpVideo, { recursive: true });

// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
function loadPlaywright(): any {
  for (const candidate of [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
  ].filter(Boolean) as string[]) {
    try {
      return createRequire(import.meta.url)(candidate);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_MODULE to its directory');
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-20T10:30:00Z');
const STARTED = Date.parse('2026-11-03T08:00:00Z');
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const hour = (at: number) => new Date(at).toISOString().slice(0, 13);
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-capture-${randomUUID().slice(0, 12)}`);
initProviderInstance(root);
migrateProvider(root, syntheticSelection(), STARTED);
const { config, store } = openProviderStore(root);
const clock = { now: () => NOW };

let seed = 24_011_120;
const rnd = (max: number) => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return Math.floor((seed / 4_294_967_296) * max);
};
const daily = (d: string, metric: string, value: number, characterId = '', model = '') =>
  store.run(
    `INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?,?,?,?,?)
    ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+excluded.value`,
    d,
    metric,
    characterId,
    model,
    value,
  );
const hourly = (h: string, metric: string, characterId: string, value: number) =>
  store.run(
    `INSERT INTO web_stats_hourly(hour,metric,character_id,value) VALUES (?,?,?,?)
    ON CONFLICT(hour,metric,character_id) DO UPDATE SET value=value+excluded.value`,
    h,
    metric,
    characterId,
    value,
  );
// The counters ran from STARTED on (the 22d step as well).
store.run("DELETE FROM web_stats_daily WHERE metric IN ('stats_started','extras_started')");
daily(day(STARTED), 'stats_started', 1);
daily(day(STARTED), 'extras_started', 1);
const CHARACTERS = ['wei-guagua', 'jojo', 'chen-jimi'];
const MODELS = ['', 'deepseek', 'gemini', 'xai'];
const growth = (at: number) => 0.6 + ((at - STARTED) / DAY) * 0.09;
for (let at = Date.parse('2026-11-03T00:00:00Z'); at <= NOW; at += DAY) {
  const d = day(at),
    g = growth(at),
    signups = 2 + rnd(7),
    guests = Math.round(10 + rnd(25) * g);
  daily(d, 'signups', signups);
  daily(d, 'new_guests', guests);
  daily(d, 'active_registered', Math.round((18 + rnd(30)) * g));
  daily(d, 'active_guest', guests + rnd(10));
  daily(d, 'chat_registered', Math.round((9 + rnd(18)) * g));
  daily(d, 'chat_guest', Math.floor(guests * 0.7));
  daily(d, 'purge_expired', rnd(Math.max(1, Math.floor(guests / 3))));
  if (rnd(4) === 0) daily(d, 'purge_deleted', 1 + rnd(2));
  CHARACTERS.forEach((characterId, k) => {
    daily(d, 'chat_users', Math.round((6 + rnd(12)) * g * (1.2 - k * 0.25)), characterId);
    for (const model of MODELS) {
      if (rnd(3) === 0) continue;
      const published = Math.round((8 + rnd(40)) * g * (1.2 - k * 0.25));
      daily(d, 'reply_published', published, characterId, model);
      daily(d, 'reply_voice', Math.floor(published * 0.85), characterId, model);
      if (rnd(3) === 0) daily(d, 'reply_failed', 1 + rnd(3), characterId, model);
      if (model) daily(d, 'points_spent', published * (model === 'xai' ? 27 : model === 'gemini' ? 22 : 12), '', model);
    }
  });
  if (at <= NOW - 2 * DAY) {
    daily(d, 'd1_cohort', signups);
    daily(d, 'd1_retained', Math.round(signups * (0.3 + rnd(30) / 100)));
  }
  if (at <= NOW - 8 * DAY) {
    daily(d, 'd7_cohort', signups);
    daily(d, 'd7_retained', Math.round(signups * (0.1 + rnd(25) / 100)));
  }
}
// The last 24 UTC hours.
for (let i = 23; i >= 0; i--) {
  const h = hour(NOW - i * HOUR),
    clockHour = new Date(NOW - i * HOUR).getUTCHours(),
    wave = 6 + 10 * Math.max(0, Math.sin(((clockHour - 6) / 24) * Math.PI * 2)) + (clockHour % 3);
  let total = 0;
  CHARACTERS.forEach((characterId, k) => {
    const replies = Math.max(1, Math.round(wave * (1.2 - k * 0.25) + rnd(4)));
    const people = Math.max(1, Math.round(replies / 4));
    hourly(h, 'reply_published', characterId, replies);
    hourly(h, 'chat_users', characterId, people);
    total += people;
  });
  hourly(h, 'chat_users', '', Math.max(1, Math.round(total * 0.85)));
}
// Provider usage (21b + 22c) and the spend by user type (22d).
const usage = (d: string, provider: string, model: string, phase: string, calls: number, units: number, bytes = 0) => {
  const input = phase === 'speech' ? 0 : units,
    output = phase === 'speech' ? 0 : Math.round(units / 6);
  const cost =
    phase === 'speech'
      ? bytes * speechListMicrosPerByte(model, d)
      : listPriceMicros(provider, model, {
          inputTokens: input,
          cachedInputTokens: Math.round(input * 0.4),
          outputTokens: output,
        });
  store.run(
    `INSERT INTO web_provider_usage(day,provider,model,phase,calls,input_tokens,cached_input_tokens,output_tokens,bytes,cost_micros,replies,ledger_charged_micros)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    d,
    provider,
    model,
    phase,
    calls,
    input,
    Math.round(input * 0.4),
    output,
    bytes,
    cost,
    phase === 'speech' ? 0 : calls,
    d >= day(STARTED) ? Math.round(cost * 1.8) : 0,
  );
};
const SHARE: Record<string, number> = { guest: 0.12, registered: 0.3, daily_refill: 0.28, unlimited: 0.14, test: 0.06 };
for (let at = Date.parse('2026-10-18T00:00:00Z'); at <= NOW; at += DAY) {
  const d = day(at),
    n = 60 + rnd(120);
  usage(d, 'deepseek', 'deepseek-v4-flash', 'draft', n, n * (2400 + rnd(600)));
  usage(d, 'deepseek', 'deepseek-v4-flash', 'review', n, n * (1800 + rnd(400)));
  if (rnd(2)) usage(d, 'gemini', 'gemini-3.8-flash', 'draft', 12 + rnd(30), 30_000 + rnd(30_000));
  usage(d, 'fish', 's2.1-pro', 'speech', n, 0, n * (260 + rnd(80)));
  if (at >= STARTED) {
    const ramp = growth(at) * (at >= Date.parse('2026-11-12T00:00:00Z') ? 2.4 : 1);
    for (const [type, share] of Object.entries(SHARE))
      for (const kind of ['text', 'voice'] as const) {
        const micros = Math.round((kind === 'voice' ? 0.7 : 0.3) * share * ramp * (3_200_000 + rnd(1_200_000)));
        store.run(
          'INSERT INTO web_stats_spend(day,user_type,kind,calls,charged_micros) VALUES (?,?,?,?,?)',
          d,
          type,
          kind,
          1 + rnd(40),
          micros,
        );
      }
    if (d === day(STARTED))
      store.run(
        "INSERT INTO web_stats_spend(day,user_type,kind,calls,charged_micros) VALUES (?, 'unknown','text',9,420000)",
        d,
      );
  }
}
// One real price change (a new version of a price row with another number) inside the range.
const price = store.get<Record<string, string | number>>(
  "SELECT * FROM web_provider_prices WHERE provider='fish' ORDER BY version DESC LIMIT 1",
);
if (price)
  store.run(
    `INSERT INTO web_provider_prices(id,provider,model,phase,currency,unit,upper_micros_per_unit,valid_from,valid_until,version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    `${price.id}-v${Number(price.version) + 1}`,
    String(price.provider),
    String(price.model),
    String(price.phase),
    String(price.currency),
    String(price.unit),
    Number(price.upper_micros_per_unit) * 3,
    Date.parse('2026-11-12T00:00:00Z'),
    Date.parse('2027-02-12T00:00:00Z'),
    Number(price.version) + 1,
  );
// The migration ledger a deployed Worker keeps (55 steps, ending at 130).
store.run('CREATE TABLE IF NOT EXISTS cf_web_migrations(version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL)');
for (const row of expectedWebMigrations().r2)
  store.run('INSERT OR REPLACE INTO cf_web_migrations VALUES (?,?)', row.version, row.sha256);

const runner = new WebProviderRunner(
  store,
  clock,
  new DeepSeekTextGenerator({ apiKey: 'offline-only', fetch: async () => new Response('{}', { status: 500 }) }),
  async (request) => ({ audio: syntheticTone(), receipt: { id: 'fake' }, usageUnits: request.billedTextBytes }),
);
const app = new WebProviderServer(store, config, clock, runner, undefined, undefined, { signupEnabled: false });
// What only the Worker knows, for 系统状态 and the alert line.
// biome-ignore lint/suspicious/noExplicitAny: a harness reaches into the private field the Worker fills
(app as any).application.system.ops = {
  flags: () => ({
    signupBonus: true,
    playerModelChoice: true,
    playerTextModels: ['deepseek', 'gemini', 'xai'],
    fishVoiceModel: 'drama-3',
    chatReview: true,
    turnstile: true,
    alerts: true,
    alertMailBindingPresent: true,
    alertRecipientSet: true,
  }),
  alertDailySpendMicros: () => 5_000_000,
  migrations: () => ({ active: 'r2', ...expectedWebMigrations() }),
  budget: async () => [
    {
      provider: 'deepseek',
      policy: 'production-unlimited',
      spentMicros: 22_900_000,
      heldMicros: 40_000,
      allowanceMicros: null,
      remainingMicros: null,
    },
    {
      provider: 'fish',
      policy: 'capped',
      spentMicros: 640_000,
      heldMicros: 20_000,
      allowanceMicros: 2_000_000,
      remainingMicros: 1_340_000,
    },
  ],
  retention: async () => ({ failing: 0, oldestAgeBucket: null, lastSuccessAt: NOW - 3 * HOUR, failures: [] }),
  renewPrices: () => [],
};
await app.listen();

const { chromium } = loadPlaywright();
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const origin = new URL(config.origin).origin;
const API = `${origin}/api/web/provider`;
let failure: unknown;
try {
  const errors: string[] = [];
  const admins = new WebAccountAdmin(store, clock, config.origin);
  const grant = admins.issueLoginGrant().token;
  const WIDTHS = [1440, 1280, 1680];
  // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
  const login = async (opts: Record<string, unknown>, token: string): Promise<any> => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, ...opts });
    const response = await context.request.post(`${API}/admin/login`, {
      data: { token },
      headers: { origin: config.origin },
    });
    assert.equal(response.status(), 200);
    return { context, csrf: (await response.json()).csrf as string };
  };
  const owner = await login(
    { viewport: { width: 1440, height: 1500 }, recordVideo: { dir: tmpVideo, size: { width: 1440, height: 900 } } },
    grant,
  );
  // a second administrator, so the permission grid of a non-owner is on the page
  const issued = await owner.context.request.post(`${API}/admin/members/issue`, {
    data: {
      requestId: randomUUID(),
      label: '小林',
      memberId: null,
      permissions: ['invites.manage', 'characters.read:*', 'cocreation.read'],
    },
    headers: { origin: config.origin, 'x-csrf-token': owner.csrf },
  });
  assert.equal(issued.status(), 200, await issued.text());
  // two batches to start with
  for (const [name, test] of [
    ['朋友第一批', false],
    ['十月试用', false],
  ] as const) {
    const r = await owner.context.request.post(`${API}/admin/invites/batch-create`, {
      data: {
        requestId: randomUUID(),
        name,
        count: 6,
        tier: { kind: 'unlimited' },
        durationDays: name === '十月试用' ? 30 : null,
        redeemBy: null,
        ...(test ? { test: true } : {}),
      },
      headers: { origin: config.origin, 'x-csrf-token': owner.csrf },
    });
    assert.equal(r.status(), 201, await r.text());
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
  const open = async (route: string, width: number, height = 1500): Promise<any> => {
    const page = await owner.context.newPage();
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    page.on('console', (m: { type(): string; text(): string; location(): unknown }) => {
      if (m.type() === 'error')
        errors.push(`${m.text()} @ ${JSON.stringify(m.location())} on ${page.url().split('#')[1]}`);
    });
    await page.addInitScript(() => {
      const orig = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (n: string, v: string) {
        if (n === 'style')
          console.error(
            'STYLE-ATTR ' +
              this.tagName +
              '.' +
              this.className +
              ' ' +
              new Error().stack?.split('\n').slice(2, 5).join(' | '),
          );
        return orig.call(this, n, v);
      };
      const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText')!;
      Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
        ...d,
        set(v: string) {
          console.error('CSSTEXT ' + v + ' ' + new Error().stack?.split('\n').slice(2, 5).join(' | '));
          d.set!.call(this, v);
        },
      });
    });
    await page.addInitScript(() =>
      document.addEventListener('securitypolicyviolation', (e) =>
        console.error(
          'CSP ' + e.effectiveDirective + ' sample=' + e.sample + ' line=' + e.lineNumber + ' src=' + e.sourceFile,
        ),
      ),
    );
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/?mode=provider-admin#/${route}`);
    return page;
  };
  // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
  const shot = async (page: any, name: string, width: number) => {
    await page.waitForTimeout(1300);
    await page.screenshot({ path: join(out, `${name}-${width}.png`) });
  };
  // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
  const overflowOk = async (page: any, label: string) => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, `${label}: the page scrolls sideways`);
  };

  for (const width of WIDTHS) {
    // ---- 总览: 24H / 7天 / 14天, and the three views ----
    const dash = await open('overview', width);
    await dash.getByText('今日回复').waitFor({ timeout: 20_000 });
    await dash.locator('#admin-overview .ov-chart .xy-path').first().waitFor();
    await shot(dash, 'overview-14d-line', width);
    await dash.locator('#admin-overview [aria-label="时间范围"] button', { hasText: '24H' }).click();
    await dash.waitForFunction(() => document.querySelectorAll('#admin-overview .ov-chart .xy-hit').length === 24);
    await shot(dash, 'overview-24h-line', width);
    await dash.locator('#admin-overview [aria-label="时间范围"] button', { hasText: '7天' }).click();
    await dash.waitForFunction(() => document.querySelectorAll('#admin-overview .ov-chart .xy-hit').length === 7);
    await shot(dash, 'overview-7d-line', width);
    await dash.locator('#admin-overview [aria-label="指标"] button', { hasText: '聊天人数' }).click();
    await dash.waitForTimeout(600);
    await shot(dash, 'overview-7d-chat-users', width);
    await dash.locator('#admin-overview [aria-label="图表类型"] button[aria-label="饼图"]').click();
    await shot(dash, 'overview-7d-pie', width);
    await dash.locator('#admin-overview [aria-label="图表类型"] button[aria-label="表格"]').click();
    await shot(dash, 'overview-7d-table', width);
    await overflowOk(dash, `overview ${width}`);

    // ---- 邀请与额度: create a batch (测试), copy each code ----
    const inv = await open('invites', width);
    await inv.locator('#tiers-name').fill('测试组第一批');
    await inv.locator('#tiers-count').fill('4');
    await inv.locator('label:has(#tiers-kind-unlimited)').click();
    await inv.locator('#tiers-test').check();
    await shot(inv, 'invites-new-batch-form', width);
    await inv.locator('#tiers-create').click();
    await inv.locator('.tiers-codes-table tbody tr').first().waitFor({ timeout: 20_000 });
    assert.equal(
      await inv.locator('.tiers-codes-table tbody tr .tiers-copy').count(),
      4,
      'every code has its own 复制',
    );
    await inv.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await inv.locator('.tiers-codes-table tbody tr .tiers-copy').nth(2).click();
    const clip = await inv.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /^[A-Za-z0-9_-]{43}$/, 'the third code was copied on its own');
    await shot(inv, 'invites-just-created', width);
    await overflowOk(inv, `invites ${width}`);

    // ---- 玩家统计 ----
    const stats = await open('stats', width);
    await stats.getByText('统计自 2026-11-03 起（UTC）').waitFor({ timeout: 20_000 });
    await stats.locator('.stat-active .xy-bar').first().waitFor();
    await shot(stats, 'player-stats', width);
    await overflowOk(stats, `stats ${width}`);

    // ---- 消耗表: bar, line, only 测试组 ----
    const costs = await open('costs', width);
    await costs.getByText('本月花费').waitFor({ timeout: 20_000 });
    await costs.locator('.cost-chart .xy-bar').first().waitFor();
    await costs.locator('#admin-costs [aria-label="时间范围"] button', { hasText: '30天' }).waitFor();
    await shot(costs, 'costs-bar', width);
    await costs.locator('#admin-costs [aria-label="图表类型"] button[aria-label="折线"]').click();
    await shot(costs, 'costs-line', width);
    await costs.locator('#admin-costs [aria-label="图表类型"] button[aria-label="柱状"]').click();
    for (const id of ['guest', 'registered', 'daily_refill', 'unlimited', 'unclassified'])
      await costs.locator(`[data-chip="${id}"]`).click();
    await shot(costs, 'costs-only-test-group', width);
    await overflowOk(costs, `costs ${width}`);

    // ---- 系统状态 ----
    const sys = await open('system', width);
    await sys.getByText('运行版本').waitFor({ timeout: 20_000 });
    await shot(sys, 'system', width);

    // ---- 管理员与权限, 积分发放, 模型与价格 ----
    const mem = await open('members', width);
    await mem.locator('#admin-members-list .admin-member-head').first().waitFor({ timeout: 20_000 });
    await shot(mem, 'members', width);
    await overflowOk(mem, `members ${width}`);
    const pts = await open('points', width);
    await pts.locator('#points-amount').fill('20');
    await pts.waitForFunction(
      () => (document.querySelector('#admin-points .points-live')?.textContent ?? '').length > 0,
    );
    await shot(pts, 'points', width);
    await overflowOk(pts, `points ${width}`);
    const mod = await open('models', width);
    await mod.locator('#admin-models table').waitFor({ timeout: 20_000 });
    await shot(mod, 'models', width);
    await overflowOk(mod, `models ${width}`);
    await overflowOk(sys, `system ${width}`);
  }

  // ---- the recording: navigation and the 消耗表 scale change (1440 x 900) ----
  const page = await owner.context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/?mode=provider-admin#/overview`);
  await page.getByText('今日回复').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  for (const target of ['invites', 'stats', 'costs']) {
    await page.locator(`.admin-nav a[data-page="${target}"]`).click({ timeout: 8000 });
    await page.waitForTimeout(1600);
  }
  await page.locator('#admin-costs .cost-chart .xy-bar').first().waitFor();
  // The scale change: take the big types off one by one, then bring them back.
  for (const id of ['registered', 'daily_refill', 'unlimited', 'guest', 'unclassified']) {
    await page.locator(`#admin-costs [data-chip="${id}"]`).click();
    await page.waitForTimeout(900);
  }
  await page.locator('#admin-costs [aria-label="图表类型"] button[aria-label="折线"]').click();
  await page.waitForTimeout(1400);
  for (const id of ['registered', 'daily_refill', 'unlimited', 'guest']) {
    await page.locator(`#admin-costs [data-chip="${id}"]`).click();
    await page.waitForTimeout(700);
  }
  await page.locator('.admin-nav a[data-page="system"]').click();
  await page.waitForTimeout(1600);
  await page.locator('.admin-nav a[data-page="overview"]').click();
  await page.waitForTimeout(1600);
  await page.close();
  await page.video().saveAs(join(out, 'admin-nav-and-usage-scale.webm'));

  // The one known console error is older than this Part: the preview page's split pane writes a style attribute on load (split-pane.ts),
  // which the page's CSP refuses. Anything else - any other style attribute, any other error - fails the run.
  const unexpected = errors.filter(
    (e) =>
      !/DIV\.admin-split|status of 409 \(Conflict\) @ .*points\/preview|CSP style-src-attr|Applying inline style violates/.test(
        e,
      ),
  );
  assert.deepEqual(unexpected, [], 'no uncaught page errors');
  process.stdout.write(`capture: PASS (${out})\n`);
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  rmSync(tmpVideo, { recursive: true, force: true });
  await app.close();
  store.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
