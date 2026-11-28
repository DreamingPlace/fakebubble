import { ensure } from '../../../packages/domain/errors.ts';
import { STATS_RANGES, type StatsRange } from '../../../packages/contracts/web-stats.ts';
import {
  MEME_SOURCE_LABELS,
  MEME_STATES,
  isMemeCategory,
  isMemeSource,
  type MemeListInput,
  type MemeSource,
} from '../../../packages/contracts/web-memes.ts';
import type { RehearsalRunDetail, RehearsalRunInfo } from '../../../packages/contracts/web-rehearsal.ts';
import { readCosts, readPlayerStats, readSpend } from '../admin/web-stats-admin.ts';
import { listMemes } from '../memes/web-meme-library.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { statsExtrasExist, statsTablesExist } from '../stats/web-stats.ts';
import { MASKED_CODE } from '../invites/web-invite-export.ts';
import { characterFacts } from '../review/web-chat-review.ts';
import { utc8Time } from './web-export-conversations.ts';
import type { Cell, Sheet } from './web-export-file.ts';

/**
 * Part 57: the smaller exports. Each builder lists its columns; none reads a table's identity columns (a player, a principal, a world,
 * an invite code's text or digest, an email). Counts, names, enums, money and times only.
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;
const tableExists = (store: Reader, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
const usd = (micros: number | null) => (micros === null ? null : Number((micros / 1_000_000).toFixed(6)));
const time = (at: number | null) => (at === null ? '' : utc8Time(at));

// ---- 总览 / 消耗表: per day and per hour --------------------------------------------------------------------------------------
export function parseStatsRange(value: unknown): StatsRange {
  ensure(STATS_RANGES.includes(value as StatsRange), 'INVALID_REQUEST');
  return value as StatsRange;
}
const HOURLY_METRIC = {
  reply_published: '回复（成功）',
  reply_failed: '回复（失败）',
  reply_unknown: '回复（未知）',
  chat_users: '聊天人数',
} as const;
const USER_TYPE_LABEL = {
  test: '测试组',
  unlimited: '不限额',
  daily_refill: '每天补充',
  registered: '注册玩家',
  guest: '访客',
} as const;

export function statsSheets(store: Reader, now: number, range: StatsRange): Sheet[] {
  ensure(statsTablesExist(store), 'STATS_UNAVAILABLE');
  const players = readPlayerStats(store, now, range);
  const costs = readCosts(store, now, range);
  const sheets: Sheet[] = [
    {
      name: '每日统计',
      file: 'daily',
      header: [
        '日期（UTC）',
        '新注册',
        '新访客',
        '活跃（注册）',
        '活跃（访客）',
        '聊天人数（注册）',
        '聊天人数（访客）',
        '回复（成功）',
        '回复（失败）',
        '回复（未知）',
        '语音回复',
        '删除账号',
        '不活跃清理',
        '试用到期清理',
      ],
      rows: players.days.map((d) => [
        d.day,
        d.signups,
        d.newGuests,
        d.activeRegistered,
        d.activeGuests,
        d.chatRegistered,
        d.chatGuests,
        d.repliesPublished,
        d.repliesFailed,
        d.repliesUnknown,
        d.voiceReplies,
        d.deletedAccounts,
        d.inactivePurged,
        d.expiredPurged,
      ]),
    },
    {
      name: '按角色',
      file: 'by-character',
      header: ['角色', '回复（成功）', '回复（失败）', '回复（未知）', '语音回复'],
      rows: players.byCharacter.map((c) => [c.name, c.published, c.failed, c.unknown, c.voice]),
    },
    {
      name: '按模型',
      file: 'by-model',
      header: ['模型', '回复（成功）', '回复（失败）', '回复（未知）', '语音回复'],
      rows: players.byModel.map((m) => [
        m.model === '' ? '未选择模型' : m.model,
        m.published,
        m.failed,
        m.unknown,
        m.voice,
      ]),
    },
  ];
  // The hourly and per-type sheets are always there (empty before the counters of migration 130 ran), so a sheet's place never moves.
  const from = new Date(now - range * 86_400_000).toISOString().slice(0, 13);
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (id === '') return '全部';
    let name = names.get(id);
    if (name === undefined) names.set(id, (name = characterFacts(store, id).label));
    return name;
  };
  sheets.push({
    name: '每小时',
    file: 'hourly',
    header: ['小时（UTC）', '指标', '角色', '数值'],
    rows: statsExtrasExist(store)
      ? store
          .all<{ hour: string; metric: keyof typeof HOURLY_METRIC; character_id: string; value: number }>(
            'SELECT hour,metric,character_id,value FROM web_stats_hourly WHERE hour>=? ORDER BY hour DESC,metric,character_id',
            from,
          )
          .map((r): Cell[] => [
            r.hour.replace('T', ' ') + ':00',
            HOURLY_METRIC[r.metric] ?? '',
            nameOf(r.character_id),
            r.value,
          ])
      : [],
  });
  sheets.push(
    {
      name: '每日消耗',
      file: 'costs-daily',
      header: ['日期（UTC）', '成功回复', '列表价（美元）', '每条回复（美元）', '消耗积分'],
      rows: costs.daily.map((d) => [
        d.day,
        d.publishedReplies,
        usd(d.listCostMicros),
        usd(d.costPerReplyMicros),
        d.pointsSpent,
      ]),
    },
    {
      name: '消耗明细',
      file: 'costs',
      header: [
        '日期（UTC）',
        '供应商',
        '模型',
        '阶段',
        '调用次数',
        '输入令牌',
        '缓存命中令牌',
        '输出令牌',
        '字节（语音）',
        '列表价（美元）',
        '账本扣款（美元）',
        '回复',
      ],
      rows: costs.rows.map((r) => [
        r.day,
        r.provider,
        r.model,
        r.phase,
        r.calls,
        r.inputTokens,
        r.cachedInputTokens,
        r.outputTokens,
        r.bytes,
        usd(r.listCostMicros),
        usd(r.ledgerChargedMicros),
        r.replies,
      ]),
    },
  );
  const rows: Cell[][] = [];
  if (statsExtrasExist(store)) {
    const spend = readSpend(store, now, range);
    for (const day of spend.days) {
      if (day.types === null) rows.push([day.day, '', '', null, null]);
      else {
        for (const t of day.types)
          rows.push([day.day, USER_TYPE_LABEL[t.userType], '文字 / 语音', usd(t.textMicros), usd(t.voiceMicros)]);
        rows.push([day.day, '未分类', '文字 / 语音', usd(day.unclassifiedMicros), null]);
      }
    }
  }
  sheets.push({
    name: '按玩家类型',
    file: 'spend-by-type',
    header: ['日期（UTC）', '玩家类型', '拆分', '文字（美元）', '语音（美元）'],
    rows,
  });
  return sheets;
}

// ---- 网络梗 ---------------------------------------------------------------------------------------------------------------------
export function parseMemeFilters(input: unknown): Omit<MemeListInput, 'page'> {
  ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
  const body = input as Record<string, unknown>;
  const query = body.query ?? '';
  ensure(typeof query === 'string' && [...query].length <= 100, 'INVALID_REQUEST');
  const year = body.year ?? null;
  ensure(
    year === null || (Number.isSafeInteger(year) && (year as number) > 1990 && (year as number) < 2100),
    'INVALID_REQUEST',
  );
  const tag = body.tag ?? null;
  ensure(tag === null || (typeof tag === 'string' && [...tag].length <= 40), 'INVALID_REQUEST');
  const state = body.state ?? 'all';
  ensure((MEME_STATES as readonly unknown[]).includes(state), 'INVALID_REQUEST');
  // Part 37c-1b: the page's category and source filters (absent = none).
  const category = body.category ?? null;
  ensure(category === null || isMemeCategory(category), 'INVALID_REQUEST');
  const source = body.source ?? null;
  ensure(source === null || isMemeSource(source), 'INVALID_REQUEST');
  return {
    query,
    year: year as number | null,
    tag: tag as string | null,
    state: state as MemeListInput['state'],
    category: category as string | null,
    source: source as MemeSource | null,
  };
}
export function memeSheets(store: Reader, filters: Omit<MemeListInput, 'page'>): Sheet[] {
  const rows: Cell[][] = [];
  for (let page = 1; ; page++) {
    const view = listMemes(store, { ...filters, page });
    for (const entry of view.entries)
      rows.push([
        entry.term,
        entry.meaning,
        entry.year,
        entry.tags.join('、'),
        entry.enabled ? '已开启' : '已关闭',
        entry.defaultOff ? '是' : '否',
        entry.category,
        MEME_SOURCE_LABELS[entry.source],
        entry.deleted ? '是' : '否',
      ]);
    if (page >= view.pages) break;
  }
  // Part 37c-1b: 分类, 来源 (自带 / 手动 / 上传, later 梗雷达 / 玩家聊天) and 已删除 are appended; the columns before them keep their place.
  return [
    { name: '网络梗', header: ['词', '释义', '年份', '标签', '状态', '默认关闭', '分类', '来源', '已删除'], rows },
  ];
}

// ---- 邀请与额度 -------------------------------------------------------------------------------------------------------------------
const TIER_LABEL = { unlimited: '不限额', daily_refill: '每天补充' } as const;
/** Batches, their codes (ALWAYS masked: the text of a code never leaves in an export) and the allowances. No player number, no id. */
export function inviteSheets(store: Reader, now: number): Sheet[] {
  ensure(tableExists(store, 'web_invite_batches'), 'NOT_FOUND');
  const batches = store.all<{
    id: string;
    name: string;
    tier: keyof typeof TIER_LABEL;
    daily_amount: number | null;
    total_cap: number | null;
    duration_days: number | null;
    created_at: number;
    codes: number;
    redeemed: number;
    revoked: number;
    holders: number;
  }>(
    `SELECT b.id,b.name,b.tier,b.daily_amount,b.total_cap,b.duration_days,b.created_at,
      (SELECT count(*) FROM web_invite_codes c WHERE c.batch_id=b.id) codes,
      (SELECT count(*) FROM web_invite_codes c WHERE c.batch_id=b.id AND c.redeemed_count=1) redeemed,
      (SELECT count(*) FROM web_invite_codes c WHERE c.batch_id=b.id AND (c.status='revoked' OR EXISTS
        (SELECT 1 FROM web_entitlements e WHERE e.invite_id=c.id AND e.revoked_at IS NOT NULL))) revoked,
      (SELECT count(*) FROM web_entitlements e WHERE e.batch_id=b.id AND e.revoked_at IS NULL AND e.starts_at<=?
        AND (e.expires_at IS NULL OR e.expires_at>?)) holders
    FROM web_invite_batches b ORDER BY b.created_at DESC,b.id DESC`,
    now,
    now,
  );
  const codes = store.all<{
    batch: string;
    serial: number;
    state: string;
    redeemed_at: number | null;
    expires_at: number | null;
  }>(
    `SELECT b.name batch,
      row_number() OVER (PARTITION BY c.batch_id ORDER BY c.created_at,c.rowid) serial,
      CASE WHEN c.redeemed_count=1 THEN (CASE WHEN e.revoked_at IS NOT NULL THEN 'ended' ELSE 'redeemed' END)
        WHEN c.status='revoked' THEN 'revoked' ELSE 'unused' END state,
      e.starts_at redeemed_at,e.expires_at
    FROM web_invite_codes c JOIN web_invite_batches b ON b.id=c.batch_id LEFT JOIN web_entitlements e ON e.invite_id=c.id
    ORDER BY b.created_at DESC,b.id DESC,serial`,
  );
  const stateLabel = (s: string) => (s === 'unused' ? '未使用' : s === 'redeemed' ? '已兑换' : '已撤销');
  const allowances = tableExists(store, 'web_entitlements')
    ? store.all<{
        source: string;
        batch: string | null;
        kind: keyof typeof TIER_LABEL;
        daily_amount: number | null;
        total_cap: number | null;
        starts_at: number;
        expires_at: number | null;
        revoked_at: number | null;
      }>(
        `SELECT e.source,(SELECT b.name FROM web_invite_batches b WHERE b.id=e.batch_id) batch,e.kind,e.daily_amount,e.total_cap,
          e.starts_at,e.expires_at,e.revoked_at FROM web_entitlements e ORDER BY e.starts_at DESC,e.rowid DESC`,
      )
    : [];
  return [
    {
      name: '批次',
      file: 'batches',
      header: [
        '批次',
        '类型',
        '每天补充',
        '上限',
        '有效天数',
        '创建时间（UTC+8）',
        '邀请码数',
        '已兑换',
        '已撤销',
        '现有持有人',
      ],
      rows: batches.map((b) => [
        b.name,
        TIER_LABEL[b.tier],
        b.daily_amount,
        b.total_cap,
        b.duration_days,
        time(b.created_at),
        b.codes,
        b.redeemed,
        b.revoked,
        b.holders,
      ]),
    },
    {
      name: '邀请码',
      file: 'codes',
      header: ['批次', '序号', '邀请码', '状态', '兑换时间（UTC+8）', '额度到期（UTC+8）'],
      rows: codes.map((c) => [
        c.batch,
        c.serial,
        MASKED_CODE,
        stateLabel(c.state),
        time(c.redeemed_at),
        c.redeemed_at === null ? '' : c.expires_at === null ? '无期限' : time(c.expires_at),
      ]),
    },
    {
      name: '额度',
      file: 'allowances',
      header: ['来源', '批次', '类型', '每天补充', '上限', '开始（UTC+8）', '到期（UTC+8）', '状态'],
      rows: allowances.map((a) => [
        a.source === 'invite' ? '邀请码' : '管理员',
        a.batch ?? '',
        TIER_LABEL[a.kind],
        a.daily_amount,
        a.total_cap,
        time(a.starts_at),
        a.expires_at === null ? '无期限' : time(a.expires_at),
        a.revoked_at !== null ? '已撤销' : a.expires_at !== null && a.expires_at <= now ? '已到期' : '有效',
      ]),
    },
  ];
}

// ---- 广播 ----------------------------------------------------------------------------------------------------------------------
const BROADCAST_STATE = { scheduled: '已定时', sending: '发送中', sent: '已发送', cancelled: '已取消' } as const;
export function broadcastSheets(list: {
  broadcasts: readonly {
    state: keyof typeof BROADCAST_STATE;
    sendAt: number;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    characters: readonly { name: string }[];
    recipients: number;
    delivered: number;
    percent: number;
  }[];
}): Sheet[] {
  return [
    {
      name: '广播记录',
      header: [
        '状态',
        '创建时间（UTC+8）',
        '计划发送（UTC+8）',
        '开始（UTC+8）',
        '完成（UTC+8）',
        '角色',
        '收件人数',
        '已送达',
        '进度（%）',
      ],
      rows: list.broadcasts.map((b) => [
        BROADCAST_STATE[b.state] ?? '',
        time(b.createdAt),
        time(b.sendAt),
        time(b.startedAt),
        time(b.finishedAt),
        b.characters.map((c) => c.name).join('、'),
        b.recipients,
        b.delivered,
        b.percent,
      ]),
    },
  ];
}

// ---- 分享链接 ------------------------------------------------------------------------------------------------------------------
export function shareSheets(stats: { created: number; opened: number; expired: number; active: number }): Sheet[] {
  return [
    {
      name: '分享链接',
      header: ['指标', '数量'],
      rows: [
        ['已创建', stats.created],
        ['已打开', stats.opened],
        ['已过期', stats.expired],
        ['仍有效', stats.active],
      ],
    },
  ];
}

// ---- 多轮预演 ------------------------------------------------------------------------------------------------------------------
const RUN_STATUS = { running: '进行中', done: '已完成', failed: '失败' } as const;
export function rehearsalSheets(runs: readonly { info: RehearsalRunInfo; detail: RehearsalRunDetail }[]): Sheet[] {
  const runRows: Cell[][] = [],
    lineRows: Cell[][] = [],
    scoreRows: Cell[][] = [];
  runs.forEach(({ info, detail }, at) => {
    const label = `${time(info.createdAt)} ${info.scriptName}`;
    runRows.push([
      at + 1,
      time(info.createdAt),
      info.scriptName,
      detail.columns.map((c) => c.label).join('、'),
      info.turns,
      info.withCast ? '是' : '否',
      RUN_STATUS[info.status],
      usd(info.estimatedMicros),
      usd(info.chargedMicros),
    ]);
    for (const column of detail.columns) {
      detail.turns.forEach((turn, index) => {
        const cell = column.cells[index];
        lineRows.push([
          at + 1,
          label,
          column.label,
          index + 1,
          turn.text,
          turn.role === 'hint' ? '提示' : turn.role === 'negative' ? '反例' : '',
          cell?.bubbles ? cell.bubbles.join('\n') : '',
          cell?.state ?? '',
          cell?.errorCode ?? '',
        ]);
      });
      const c = column.counts;
      scoreRows.push([
        at + 1,
        label,
        column.label,
        c.replies,
        c.answeredAll,
        c.unaskedAdvice,
        c.endsWithQuestion,
        c.avgChars,
        c.avgBubbles,
        c.customerService,
        c.repeated,
        c.unconfirmed,
        c.failed,
        column.style.sharedOwn,
        column.style.startedTopic,
        column.style.showedEmotion,
        column.netMemes?.matched ?? null,
        column.netMemes?.given ?? null,
      ]);
    }
  });
  return [
    {
      name: '预演轮次',
      file: 'runs',
      header: ['序号', '时间（UTC+8）', '脚本', '列', '轮数', '带关系与故事', '状态', '预估（美元）', '实际（美元）'],
      rows: runRows,
    },
    {
      name: '对话',
      file: 'lines',
      header: ['序号', '预演', '列', '第几轮', '玩家说（脚本）', '类型', '回复', '状态', '错误代码'],
      rows: lineRows,
    },
    {
      name: '评分',
      file: 'scores',
      header: [
        '序号',
        '预演',
        '列',
        '回复数',
        '每条都答',
        '未被问的建议',
        '以问句结尾',
        '平均字数',
        '平均气泡数',
        '客服腔',
        '重复',
        '未确认',
        '失败',
        '说了自己的事',
        '主动起话题',
        '情绪起伏',
        '命中的梗',
        '给出释义',
      ],
      rows: scoreRows,
    },
  ];
}
