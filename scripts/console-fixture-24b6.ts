import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { localRuntime, initProviderInstance } from '../apps/server/platform/web-local-config.ts';
import { WebProviderOffline } from '../apps/server/generation/web-provider-offline.ts';
import { WebCharacterPreviewRunner } from '../apps/server/characters/web-character-preview-runner.ts';
import { WebProviderRunner } from '../apps/server/generation/web-provider-runner.ts';
import { WebProviderServer } from '../apps/server/generation/web-provider-server.ts';
import { DeepSeekTextGenerator } from '../apps/server/generation/deepseek.ts';
import { listPriceMicros, speechListMicrosPerByte } from '../apps/server/generation/model-list-prices.ts';
import { syntheticTone } from '../apps/server/platform/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../apps/server/conversation/web-vertical-publisher.ts';
import { WebAccountAdmin } from '../apps/server/admin/web-account-admin.ts';
import { WEB_PROVIDER_WELCOME } from '../config/web-v1.ts';
import { migrateProvider, openProviderStore } from './web-provider.ts';
import { syntheticSelection } from '../tests/web/fixtures/provider-selection.ts';
import { SAMPLE_NAMES, sampleCastRaw, sampleId } from '../tests/web/fixtures/cast-sample.ts';
import { characterProfileHash } from '../apps/server/characters/web-character-catalog.ts';

/**
 * Part 24b-6: the synthetic site the V3 console is looked at on (the browser audit and the screenshots). A real migrated
 * provider-local instance whose clock stands on 2026-11-20: fifteen characters (three of the instance's own, twelve live), a full
 * cast saved as the draft, nine co-creation notes, four invite batches, and a busy history of player counters and consumption.
 * Everything is SYNTHETIC ("[示例]" style); nothing reaches a provider.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
export function loadPlaywright(): any {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/node-tools/node_modules/playwright',
    '/opt/node22/lib/node_modules/playwright',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return createRequire(import.meta.url)(candidate);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_MODULE to its directory');
}

export const OWN = ['wei-guagua', 'jojo', 'chen-jimi'] as const;
const TINTS = ['#E8561E', '#2F7DE1', '#7C4DDB', '#F2A33A', '#3FA776', '#E4568F', '#2BA6C7', '#8E6BD0', '#D98B3A', '#6CAB4B', '#D96A6A', '#4F74D9'];
const DAY = 86_400_000;
export const NOW = Date.parse('2026-11-20T10:00:00Z');
const STARTED = Date.parse('2026-11-03T08:00:00Z');
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export async function startConsoleFixture() {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `provider-console-${randomUUID().slice(0, 12)}`);
  initProviderInstance(root);
  migrateProvider(root, syntheticSelection(), STARTED);
  const { config, store } = openProviderStore(root);
  const clock = { now: () => NOW };
  // Points and model choice are on (the Models and Points pages, daily-refill batches).
  Object.assign(store, { publicFreeTier: true, playerModelChoice: ['deepseek', 'gemini', 'xai'] });
  const ledger = new WebProviderOffline(store, clock);
  for (const characterId of OWN) {
    const voiceVersion = `${characterId}-fish:v1`;
    ledger.registerApprovedFooter({ characterId, voiceVersion, body: SYNTHETIC_TRIAL_FOOTER, wav: syntheticTone(), approved: true });
    ledger.registerWelcome({ characterId, voiceVersion, body: WEB_PROVIDER_WELCOME[characterId].text, wav: syntheticTone() });
  }
  const offlineText = new DeepSeekTextGenerator({ apiKey: 'offline-only', fetch: async () => new Response('{}', { status: 500 }) });
  const runner = new WebProviderRunner(store, clock, offlineText, async (request) => ({
    audio: syntheticTone(),
    receipt: { id: 'fake' },
    usageUnits: request.billedTextBytes,
  }));
  const previews = new WebCharacterPreviewRunner(store, clock, offlineText, { reserve() {}, settle() {} });
  const app = new WebProviderServer(store, config, clock, runner, undefined, previews, { signupEnabled: false });

  // ---- twelve more live characters (c04 … c15), written straight into the catalog tables as a publication would ----
  const template0 = JSON.parse(store.get<{ config_json: string }>("SELECT config_json FROM character_templates WHERE id='jojo'")!.config_json);
  Array.from({ length: 12 }, (_, i) => sampleId(i + 3)).forEach((id, i) => {
    const name = SAMPLE_NAMES[Number(id.slice(1)) - 1]!;
    const template = { ...structuredClone(template0), id, name, version: 1, persona: `${name}是一个虚构的高中生。` };
    delete template.voice;
    const profile = {
      template,
      presentation: { displayName: name, publicDescription: '', welcome: { text: `${name}：来啦？`, version: 'welcome-v1' }, color: TINTS[i]! },
    };
    const text = JSON.stringify(template);
    store.run('INSERT INTO character_templates VALUES (?,?,?)', id, 1, text);
    store.run('INSERT INTO character_template_versions VALUES (?,?,?,NULL)', id, 1, text);
    store.run('INSERT INTO web_character_versions VALUES (?,?,?,?,NULL)', id, 1, JSON.stringify(profile), characterProfileHash(profile));
    store.run('INSERT INTO web_character_catalog VALUES (?,?,?)', id, 1, i + 3);
  });

  // ---- synthetic history: player counters and consumption (a seeded generator, so a re-run draws the same picture) ----
  let seed = 22_011_120;
  const rnd = (max: number) => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return Math.floor((seed / 4_294_967_296) * max);
  };
  const put = (d: string, metric: string, value: number, characterId = '', model = '') =>
    store.run(
      `INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?,?,?,?,?)
      ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+excluded.value`,
      d, metric, characterId, model, value,
    );
  const MODELS = ['', 'deepseek', 'gemini', 'xai'];
  for (let at = Date.parse('2026-11-03T00:00:00Z'); at <= NOW; at += DAY) {
    const d = day(at), signups = 2 + rnd(7), guests = 10 + rnd(25);
    put(d, 'signups', signups); put(d, 'new_guests', guests);
    put(d, 'active_registered', 18 + rnd(30)); put(d, 'active_guest', guests + rnd(10));
    put(d, 'chat_registered', 9 + rnd(18)); put(d, 'chat_guest', Math.floor(guests * 0.7));
    put(d, 'purge_expired', rnd(Math.max(1, Math.floor(guests / 3))));
    for (const characterId of OWN)
      for (const model of MODELS) {
        if (rnd(3) === 0) continue;
        const published = 8 + rnd(40);
        put(d, 'reply_published', published, characterId, model);
        put(d, 'reply_voice', Math.floor(published * 0.85), characterId, model);
        if (rnd(3) === 0) put(d, 'reply_failed', 1 + rnd(3), characterId, model);
        if (model) put(d, 'points_spent', published * (model === 'xai' ? 27 : model === 'gemini' ? 22 : 12), '', model);
      }
    if (at <= NOW - 2 * DAY) { put(d, 'd1_cohort', signups); put(d, 'd1_retained', Math.round(signups * (0.3 + rnd(30) / 100))); }
    if (at <= NOW - 8 * DAY) { put(d, 'd7_cohort', signups); put(d, 'd7_retained', Math.round(signups * (0.1 + rnd(25) / 100))); }
  }
  const usage = (d: string, provider: string, model: string, phase: string, calls: number, units: number, bytes = 0) => {
    const input = phase === 'speech' ? 0 : units, output = phase === 'speech' ? 0 : Math.round(units / 6);
    const cost = phase === 'speech' ? bytes * speechListMicrosPerByte(model, d) : listPriceMicros(provider, model, { inputTokens: input, cachedInputTokens: Math.round(input * 0.4), outputTokens: output });
    store.run(
      `INSERT INTO web_provider_usage(day,provider,model,phase,calls,input_tokens,cached_input_tokens,output_tokens,bytes,cost_micros,replies,ledger_charged_micros)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      d, provider, model, phase, calls, input, Math.round(input * 0.4), output, bytes, cost, phase === 'speech' ? 0 : calls, d >= day(STARTED) ? Math.round(cost * 1.8) : 0,
    );
  };
  for (let at = Date.parse('2026-10-18T00:00:00Z'); at <= NOW; at += DAY) {
    const d = day(at), n = 60 + rnd(120);
    usage(d, 'deepseek', 'deepseek-v4-flash', 'draft', n, n * (2400 + rnd(600)));
    usage(d, 'deepseek', 'deepseek-v4-flash', 'review', n, n * (1800 + rnd(400)));
    if (rnd(2)) usage(d, 'gemini', 'gemini-3.8-flash', 'draft', 12 + rnd(30), 30_000 + rnd(30_000));
    if (rnd(2)) usage(d, 'xai', 'grok-4.7', 'draft', 8 + rnd(25), 25_000 + rnd(30_000));
    usage(d, 'fish', 's2.1-pro', 'speech', n, 0, n * (260 + rnd(80)));
    if (rnd(2)) usage(d, 'fish', 'drama-3', 'speech', 10 + rnd(30), 0, (10 + rnd(30)) * 280);
  }

  await app.listen();
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  const origin = new URL(config.origin).origin;
  const API = `${origin}/api/web/provider`;
  const admins = new WebAccountAdmin(store, clock, config.origin);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const loginResponse = await context.request.post(`${API}/admin/login`, { data: { token: admins.issueLoginGrant().token }, headers: { origin: config.origin } });
  assert.equal(loginResponse.status(), 200);
  const csrf = (await loginResponse.json()).csrf as string;
  const post = async (path: string, data: unknown, ok = true) => {
    const response = await context.request.post(`${API}/admin/${path}`, { data, headers: { origin: config.origin, 'x-csrf-token': csrf } });
    if (ok) assert.ok([200, 201].includes(response.status()), `${path}: ${await response.text()}`);
    return response;
  };

  // ---- jojo gets a saved draft (two sections differ from the published profile) ----
  const detail = await (await post('characters/jojo/detail', {})).json();
  const next = structuredClone(detail.published.profile);
  next.template.version = detail.published.version + 1;
  next.template.persona += ' 说话更慢一点。';
  next.presentation.welcome.text += '（新）';
  await post('characters/jojo/save', { expectedRevision: null, profile: next });

  // ---- the full cast, as the draft ----
  const castDoc = JSON.parse(JSON.stringify(sampleCastRaw()).replace(/"(c\d\d)"/g, (_, id: string) => `"${Number(id.slice(1)) <= 3 ? OWN[Number(id.slice(1)) - 1] : id}"`));
  const draftNow = await (await post('cast/draft', {})).json();
  await post('cast/save', { requestId: randomUUID(), expectedRevision: draftNow.revision, doc: castDoc });

  // ---- a player's first visit creates the principal the synthetic notes belong to; nine notes ----
  const player = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 } });
  const home = await player.newPage();
  await home.goto(`${origin}/?mode=provider`);
  await home.locator('button:visible').first().waitFor({ timeout: 20_000 });
  await home.waitForTimeout(1200);
  const principal = store.get<{ id: string }>('SELECT id FROM web_principals ORDER BY rowid LIMIT 1')!.id;
  await player.close();
  const notes = [
    ['jojo', 'persona', 'text', '"这把是我 carry 的，你承认吧。"说完又补一句"你也还行"。这一段故意写得很长很长，用来看卡片的文字会不会渐隐而卡片不会变高，也看一行里会不会装不下。', 'new', 1],
    ['jojo', 'speechStyle', 'text', '"网卡了。"然后马上开下一把。', 'new', 0],
    ['jojo', 'dialogueExamples', 'dialogue', { player: '我再玩十分钟', replies: ['十分钟？你上次说十分钟玩到三点。睡。'] }, 'processed', 0],
    ['wei-guagua', 'persona', 'text', '装作很凶地问你吃饭没，问完就开始碎碎念。', 'new', 1],
    ['chen-jimi', 'free', 'text', '这句太像客服了，不像他会说的话。', 'archived', 0],
    ['wei-guagua', 'speechStyle', 'text', '口头禅可以加一个"我跟你讲"。', 'new', 0],
    ['jojo', 'interests', 'text', '他小时候在网吧长大，现在还爱打游戏。', 'new', 0],
    ['chen-jimi', 'persona', 'text', '嘴硬心软，被夸的时候会转移话题。', 'processed', 1],
    ['jojo', 'free', 'text', '遇到不懂的梗别装懂。', 'new', 0],
  ] as const;
  notes.forEach(([characterId, field, kind, body, status, star], index) => {
    const id = `note-${index + 1}`;
    store.run(
      `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,status,starred) VALUES (?,?,?,?,?,?,?,?)`,
      id, characterId, principal, `req-${index}`, 'a'.repeat(64), NOW - (index + 1) * 3_600_000, status, star,
    );
    store.run(
      `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,?,?,?,?,?)`,
      id, 0, 'free-1', field, kind, JSON.stringify(body),
    );
  });

  // ---- four invite batches ----
  const batches = [
    { name: '十月朋友', count: 30, tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 }, durationDays: null },
    { name: '测试组 · 第二批', count: 10, tier: { kind: 'unlimited' }, durationDays: 30, test: true },
    { name: '共创者', count: 5, tier: { kind: 'daily_refill', dailyAmount: 80, cap: 2000 }, durationDays: null },
    { name: '早鸟', count: 8, tier: { kind: 'unlimited' }, durationDays: null },
  ];
  for (const batch of batches) await post('invites/batch-create', { requestId: randomUUID(), redeemBy: null, ...batch });

  return {
    origin, API, store, config, clock, browser, context, csrf, post, admins, root,
    /** Leaves one note (the "one remaining card" case) or restores nothing else; returns the notes kept. */
    keepOneNote() {
      store.run("DELETE FROM web_cocreation_answers WHERE submission_id<>'note-1'");
      store.run("DELETE FROM web_cocreation_submissions WHERE id<>'note-1'");
    },
    async close() {
      await browser.close();
      await app.close?.();
    },
  };
}
