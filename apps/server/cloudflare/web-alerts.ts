import type { Clock } from '../../../packages/contracts/index.ts';
import type { WebAlertConfig } from '../../../config/web-public.ts';
import { PROVIDER_PRICES } from '../generation/web-provider-configuration.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Owner alerts (Part 17, flag ALERTS_ENABLED, default off). The business object's hourly alarm evaluates a handful of
 * conditions and sends at most ONE plain-Chinese mail per alert type per 6 hours, plus one short digest per UTC day.
 *
 * What a mail may contain: counts, percentages and amounts of money. Never a player's message, an email address, an id,
 * a token or an error text. A mail that fails to send is never retried in a loop: its slot is claimed (persisted)
 * BEFORE the send, so the next attempt for the same type is 6 hours later at the earliest and a crashed or failed send
 * cannot repeat inside the window. The hourly gate is claimed the same way, so an alarm that runs 30 s apart does the
 * work once an hour.
 *
 * State (last check, last send per type, error buckets, the unknown-attempt high-water mark) lives in the Durable
 * Object's key-value storage, not in SQL: no migration, and nothing here is player data.
 */
export const ALERT_TYPES = [
  'errors',
  'daily-spend',
  'unknown-attempt',
  'budget-cap',
  'email-cap',
  'validation-rate',
  'price-expiry',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const HOUR_MS = 3_600_000;
export const ALERT_COOLDOWN_MS = 6 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const PRICE_WARNING_MS = 7 * DAY_MS;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const BUCKET_MS = 600_000; // errors are counted in 10-minute buckets; "the last hour" is the last 6 buckets

export interface AlertState {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  /** Every entry whose key starts with the prefix. */
  list(prefix: string): Promise<Map<string, unknown>>;
  delete(keys: string[]): Promise<void>;
}
export interface AlertMailer {
  send(message: { subject: string; text: string }): Promise<void>;
}
export interface AlertBudgetRow {
  provider: string;
  allowanceMicros: number | null;
  spentMicros: number;
  heldMicros: number;
}
export interface WebAlertsDeps {
  store: Pick<BusinessStore, 'get' | 'all'>;
  clock: Clock;
  config: WebAlertConfig;
  mail: AlertMailer;
  state: AlertState;
  /** The shared budget summary; a throw skips only the budget alert. */
  budget: () => Promise<AlertBudgetRow[]>;
  /** PLAYER_EMAIL_DAILY_CAP, or null when player signup is off. */
  emailDailyCap: number | null;
  /** Called with a coarse event name only (never content) when something could not be evaluated or sent. */
  report?: (event: string) => void;
}

/** In-memory state: tests, and the local server which has no Durable Object. */
export function memoryAlertState(): AlertState & { dump(): Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, value),
    list: async (prefix) => new Map([...map].filter(([key]) => key.startsWith(prefix))),
    delete: async (keys) => void keys.forEach((key) => map.delete(key)),
    dump: () => map,
  };
}
/** A Durable Object's key-value storage, namespaced under "alerts:". */
export function durableAlertState(storage: {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  list(options: { prefix: string }): Promise<Map<string, unknown>>;
  delete(keys: string[]): Promise<number>;
}): AlertState {
  const ns = (key: string) => `alerts:${key}`;
  return {
    get: (key) => storage.get(ns(key)),
    put: (key, value) => storage.put(ns(key), value),
    list: async (prefix) => {
      const found = await storage.list({ prefix: ns(prefix) });
      return new Map([...found].map(([key, value]) => [key.slice('alerts:'.length), value]));
    },
    delete: async (keys) => void (keys.length && (await storage.delete(keys.map(ns)))),
  };
}

const money = (micros: number) => (micros / 1_000_000).toFixed(2);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export class WebAlerts {
  private readonly d: WebAlertsDeps;
  constructor(deps: WebAlertsDeps) {
    this.d = deps;
    this.nextAt = deps.clock.now() + HOUR_MS;
  }

  /** Count one business 5xx / exception. Cheap: one KV read and one write. */
  async recordError() {
    const bucket = Math.floor(this.d.clock.now() / BUCKET_MS);
    const key = `err:${bucket}`;
    const current = number(await this.d.state.get(key)) ?? 0;
    await this.d.state.put(key, current + 1);
  }
  private async errorsLastHour(now: number) {
    const first = Math.floor(now / BUCKET_MS) - 5;
    let total = 0;
    for (const [key, value] of await this.d.state.list('err:')) {
      const bucket = Number(key.slice(4));
      if (bucket >= first) total += number(value) ?? 0;
    }
    return total;
  }

  private nextAt: number;
  /** When the alarm should wake next for alerting: an hour after the last check (an hour from construction at first). */
  nextDue(): number {
    return this.nextAt;
  }

  private has(table: string) {
    return !!this.d.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
  }
  private count(sql: string, ...args: (string | number)[]) {
    return this.d.store.get<{ n: number }>(sql, ...args)?.n ?? 0;
  }
  /** Settled provider spend (micros) since a moment: text/speech attempts plus embeddings. */
  private spendSince(since: number) {
    let total = 0;
    if (this.has('web_provider_attempts'))
      total += this.count(
        "SELECT COALESCE(SUM(charged_micros),0) n FROM web_provider_attempts WHERE state='known' AND settled_at>=?",
        since,
      );
    if (this.has('web_embed_attempts'))
      total += this.count(
        "SELECT COALESCE(SUM(charged_micros),0) n FROM web_embed_attempts WHERE state='known' AND settled_at>=?",
        since,
      );
    return total;
  }
  /** The earliest "latest valid_until" over the prices the current code uses; null before any price is stored. */
  private earliestPriceExpiry(): number | null {
    if (!this.has('web_provider_prices')) return null;
    let earliest: number | null = null;
    for (const price of PROVIDER_PRICES) {
      const row = this.d.store.get<{ latest: number | null }>(
        'SELECT MAX(valid_until) latest FROM web_provider_prices WHERE provider=? AND model=? AND phase=?',
        price.provider,
        price.model,
        price.phase,
      );
      if (row?.latest != null && (earliest === null || row.latest < earliest)) earliest = row.latest;
    }
    return earliest;
  }
  private unknownCounts() {
    const one = (table: string, column: string) =>
      this.has(table) ? this.count(`SELECT count(*) n FROM ${table} WHERE ${column}='unknown'`) : 0;
    const provider = one('web_provider_attempts', 'state'),
      external = one('web_external_attempts', 'dispatch_state'),
      embed = one('web_embed_attempts', 'state');
    return { provider, external, embed, total: provider + external + embed };
  }

  /**
   * One pass. Returns which alert mails were sent (for tests and logs). Safe to call as often as the alarm fires: the
   * hour gate is claimed first, so it does real work once per hour.
   */
  async check(): Promise<{ ran: boolean; sent: string[] }> {
    const now = this.d.clock.now();
    const last = number(await this.d.state.get('check:last'));
    if (last !== null && now - last < HOUR_MS && now >= last) {
      this.nextAt = last + HOUR_MS;
      return { ran: false, sent: [] };
    }
    this.nextAt = now + HOUR_MS;
    await this.d.state.put('check:last', now);
    const sent: string[] = [];
    const c = this.d.config;
    const day = new Date(now).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);

    const attempt = async (
      type: AlertType,
      evaluate: () => Promise<{ text: string; commit?: () => Promise<void> } | null>,
    ) => {
      try {
        const alert = await evaluate();
        if (!alert) return;
        if (await this.claim(`sent:${type}`, now, ALERT_COOLDOWN_MS)) {
          await alert.commit?.();
          if (await this.deliver(`FAKE 泡泡 告警 · ${label[type]}`, alert.text)) sent.push(type);
        }
      } catch {
        this.d.report?.(`alert_evaluate_failed:${type}`);
      }
    };
    const label: Record<AlertType, string> = {
      errors: '服务错误偏多',
      'daily-spend': '今日花费偏高',
      'unknown-attempt': '出现结果未知的调用',
      'budget-cap': '预算接近上限',
      'email-cap': '验证邮件已达当日上限',
      'validation-rate': '回复失败率偏高',
      'price-expiry': '供应商价格即将到期',
    };

    await attempt('errors', async () => {
      const n = await this.errorsLastHour(now);
      return n >= c.errorsPerHour
        ? {
            text: `最近一小时服务端出现 ${n} 次错误或异常（阈值 ${c.errorsPerHour} 次）。请查看 Worker 日志，必要时先关闭公开入口。`,
          }
        : null;
    });
    await attempt('daily-spend', async () => {
      const spent = this.spendSince(dayStart);
      return spent >= c.dailySpendMicros
        ? {
            text: `今天（UTC ${day}）已结算的供应商花费约 ${money(spent)}，已超过阈值 ${money(c.dailySpendMicros)}（币种以预算设置为准）。`,
          }
        : null;
    });
    await attempt('unknown-attempt', async () => {
      const unknown = this.unknownCounts();
      const seen = number(await this.d.state.get('unknown:count')) ?? 0;
      return unknown.total > seen
        ? {
            text: `出现新的“结果未知”的外部调用，目前累计：文字/语音 ${unknown.provider} 条，外部 ${unknown.external} 条，向量 ${unknown.embed} 条。这类调用不会自动重试，也不会自动释放预算，请在管理页核对。`,
            commit: () => this.d.state.put('unknown:count', unknown.total),
          }
        : null;
    });
    await attempt('budget-cap', async () => {
      const rows = await this.d.budget();
      const capped = rows.filter((row) => row.allowanceMicros !== null);
      const cap = capped.reduce((sum, row) => sum + row.allowanceMicros!, 0);
      if (!capped.length || cap <= 0) return null;
      const used = capped.reduce((sum, row) => sum + row.spentMicros + row.heldMicros, 0);
      const percent = Math.floor((used * 100) / cap);
      return percent >= c.budgetPercent
        ? {
            text: `累计花费（含占用）已达预算上限的 ${percent}%（阈值 ${c.budgetPercent}%）：约 ${money(used)} / ${money(cap)}。预算用完后新的回复会被拒绝。`,
          }
        : null;
    });
    await attempt('email-cap', async () => {
      if (this.d.emailDailyCap === null || !this.has('web_player_email_daily')) return null;
      const sends = this.count('SELECT COALESCE(SUM(sends),0) n FROM web_player_email_daily WHERE day=?', day);
      return sends >= this.d.emailDailyCap
        ? {
            text: `今天（UTC ${day}）发出的玩家验证邮件已达上限 ${this.d.emailDailyCap} 封，新的注册和找回密码会被拒绝，次日 UTC 零点恢复。`,
          }
        : null;
    });
    await attempt('validation-rate', async () => {
      const since = now - HOUR_MS;
      const published = this.count(
        "SELECT count(*) n FROM web_operations WHERE status='published' AND created_at>=?",
        since,
      );
      const failed = this.count("SELECT count(*) n FROM web_operations WHERE status='failed' AND created_at>=?", since);
      const total = published + failed;
      if (total < c.validationMinSamples) return null;
      const percent = Math.floor((failed * 100) / total);
      return percent >= c.validationFailPercent
        ? {
            text: `最近一小时有 ${failed}/${total} 条回复没能生成（失败率 ${percent}%，阈值 ${c.validationFailPercent}%）。常见原因是模型输出没通过校验或供应商异常。`,
          }
        : null;
    });

    await attempt('price-expiry', async () => {
      const earliest = this.earliestPriceExpiry();
      return earliest !== null && earliest - now < PRICE_WARNING_MS
        ? {
            text:
              earliest <= now
                ? `有供应商价格已过期（UTC ${isoDay(earliest)}），新的回复会因缺少价格而失败。请在临时开启 OPERATOR_ENABLED=true 后运行 renew-prices。`
                : `有供应商价格将在 ${Math.max(1, Math.ceil((earliest - now) / DAY_MS))} 天内到期（UTC ${isoDay(earliest)}）。到期后新的回复会因缺少价格而失败。请在临时开启 OPERATOR_ENABLED=true 后运行 renew-prices。`,
          }
        : null;
    });

    // The daily digest: once per UTC day, at or after the configured hour.
    if (new Date(now).getUTCHours() >= c.digestHourUtc) {
      try {
        if (await this.claim(`digest:${day}`, now, 24 * HOUR_MS)) {
          const since = now - 24 * HOUR_MS;
          const replies = this.count(
            "SELECT count(*) n FROM web_operations WHERE status='published' AND created_at>=?",
            since,
          );
          const failures = this.count(
            "SELECT count(*) n FROM web_operations WHERE status='failed' AND created_at>=?",
            since,
          );
          const signups = this.has('web_player_logins')
            ? this.count('SELECT count(*) n FROM web_player_logins WHERE created_at>=?', since)
            : 0;
          const unknown = this.unknownCounts().total;
          const errors = await this.errorsLastHour(now);
          const expiry = this.earliestPriceExpiry();
          const text = `FAKE 泡泡 日报（最近 24 小时）\n回复：${replies} 条\n新注册：${signups} 人\n供应商花费：约 ${money(this.spendSince(since))}\n失败回复：${failures} 条\n结果未知的调用（累计）：${unknown} 条\n最近一小时服务端错误：${errors} 次${expiry === null ? '' : `\n最早的价格到期：UTC ${isoDay(expiry)}`}`;
          if (await this.deliver('FAKE 泡泡 日报', text)) sent.push('digest');
        }
      } catch {
        this.d.report?.('alert_digest_failed');
      }
    }
    await this.prune(now);
    return { ran: true, sent };
  }

  /** True when this key had no send in the cooldown; records the claim first so a failed send is not retried. */
  private async claim(key: string, now: number, cooldownMs: number) {
    const previous = number(await this.d.state.get(key));
    if (previous !== null && now - previous < cooldownMs && now >= previous) return false;
    await this.d.state.put(key, now);
    return true;
  }
  private async deliver(subject: string, text: string) {
    try {
      await this.d.mail.send({ subject, text });
      return true;
    } catch {
      // Never retried here: the claim above holds the slot. Only a coarse event name is reported, never the error text.
      this.d.report?.('alert_mail_failed');
      return false;
    }
  }
  private async prune(now: number) {
    const keep = Math.floor(now / BUCKET_MS) - 12;
    const old = [...(await this.d.state.list('err:'))].map(([key]) => key).filter((key) => Number(key.slice(4)) < keep);
    const digests = [...(await this.d.state.list('digest:'))]
      .map(([key]) => key)
      .filter((key) => Date.parse(`${key.slice(7)}T00:00:00.000Z`) < now - 3 * 24 * HOUR_MS);
    await this.d.state.delete([...old, ...digests]);
  }
}
