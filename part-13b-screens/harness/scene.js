// Synthetic fixtures only: no network, no real provider, no player data. Mounts the REAL page modules with fake ports.
const scene = new URLSearchParams(location.search).get('scene');
const root = document.getElementById('app');
const NOW = Date.UTC(2026, 9, 11, 9, 30);
const stage = (charged, wall, state = 'known', outcome = 'succeeded') => ({
  state, outcome, model: 'deepseek-v4-flash', reservedMicros: 9000, chargedMicros: state === 'known' ? charged : null,
  heldMicros: state === 'known' ? 0 : 9000, wallMs: wall,
});
const b = (text, expression = 'neutral') => ({ text, expression });
const final = (bubbles, over = {}) => ({
  bubbles, mode: 'casual', endsSession: false, reviewChanged: false,
  coverage: [{ messageId: 'm1', status: 'answered' }], topics: [], factOps: [], ...over,
});
const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
let n = 0;
const mk = (runId, ordinal, input, f, over = {}) => ({
  previewId: `${runId}-p${ordinal}`, characterId: 'wei-guagua', draftRevision: 5, profileHash: hash,
  status: 'succeeded', errorCode: null, input, createdAt: NOW - 3_600_000 + ordinal * 40_000, finishedAt: NOW - 3_500_000 + ordinal * 40_000,
  runId, ordinal, note: null, simulatedTime: null, settlement: 'settled_known',
  cost: { draft: stage(310, 2100 + ordinal * 130), review: stage(190, 1400 + ordinal * 90), chargedMicros: 500, heldMicros: 0 },
  latency: { draftMs: 2100 + ordinal * 130, reviewMs: 1400 + ordinal * 90 }, final: f, ...over,
});
const inputs = ['早安，今天有空聊聊吗', '你是不是AI？', '明天几点见面？', '我今天好难过', '帮我写一篇800字的作文', '晚上吃什么好', '你最喜欢什么颜色', '睡不着，陪我一会'];
const runA = 'run-a1b2c3d4', runB = 'run-e5f60718';
const A = [
  mk(runA, 1, inputs[0], final([b('早呀', 'upbeat'), b('刚醒，窗外还灰蒙蒙的', 'soft'), b('你怎么这么早？', 'upbeat')], { reviewChanged: true }), { simulatedTime: { time: '05:50', timeZone: 'Asia/Singapore' } }),
  mk(runA, 2, inputs[1], null, {
    status: 'failed', errorCode: 'INVALID_REVIEW_COVERAGE',
    cost: { draft: stage(310, 2200), review: stage(205, 1500, 'known', 'failed'), chargedMicros: 515, heldMicros: 0 },
  }),
  mk(runA, 3, inputs[2], final([b('十点吧', 'neutral'), b('我睡醒再去楼下买杯咖啡', 'soft')], { coverage: [{ messageId: 'm1', status: 'answered' }] })),
  mk(runA, 4, inputs[3], final([b('怎么了？', 'soft'), b('先别急着说，我在', 'soft'), b('想说的时候慢慢讲', 'soft')], { reviewChanged: true })),
  mk(runA, 5, inputs[4], final([b('作文就不替你写啦', 'hesitant'), b('不过可以陪你想想开头怎么起', 'upbeat')], { reviewChanged: true, coverage: [{ messageId: 'm1', status: 'answered' }] })),
  mk(runA, 6, inputs[5], final([b('火锅？', 'upbeat'), b('天凉了正好', 'soft')], { coverage: [{ messageId: 'm1', status: 'later' }] })),
  mk(runA, 7, inputs[6], null, {
    status: 'failed', errorCode: 'PREVIEW_CALL_UNKNOWN', settlement: 'held_unknown',
    cost: { draft: stage(0, null, 'unknown', null), review: null, chargedMicros: 0, heldMicros: 9000 }, latency: { draftMs: null, reviewMs: null },
  }),
  mk(runA, 8, inputs[7], final([b('嗯，我陪你', 'soft'), b('不用说话也行', 'soft')])),
];
const B = inputs.map((t, i) => mk(runB, i + 1, t,
  i === 1 ? null : final([b(['午后好', '这个点我刚吃完饭', '你呢？'][i % 3], 'upbeat'), b('下午的光线特别好', 'soft')], { reviewChanged: i % 2 === 0 }),
  i === 1 ? { status: 'failed', errorCode: 'INVALID_TOPICS', cost: { draft: stage(300, 2000), review: stage(198, 1400, 'known', 'failed'), chargedMicros: 498, heldMicros: 0 } } : { simulatedTime: { time: '15:00', timeZone: 'Asia/Singapore' } }));
const summary = (id, label, rows, createdAt, sim) => ({
  runId: id, characterId: 'wei-guagua', label, draftRevision: 5, profileHash: hash, relationship: 'friend',
  simulatedTime: sim, timeZone: 'Asia/Singapore', evalSet: { id: 'set-1', version: 3 }, itemCount: rows.length, createdBy: 'm1', createdAt,
  counts: { queued: 0, generating: 0, succeeded: rows.filter((r) => r.status === 'succeeded').length, failed: rows.filter((r) => r.status === 'failed').length },
});
const runs = [
  { run: summary(runB, '改人设后 · 下午三点', B, NOW - 1_800_000, { time: '15:00', timeZone: 'Asia/Singapore' }), previews: B },
  { run: summary(runA, '改人设前 · 清晨', A, NOW - 7_200_000, { time: '05:50', timeZone: 'Asia/Singapore' }), previews: A },
];
const sets = [{
  id: 'set-1', name: '16 例基线', version: 3, updatedBy: 'm1', updatedAt: NOW - 86_400_000,
  items: [...inputs, '你会生气吗 || 应该先问原因', '我想你了 || 不要过度热情', '推荐一首歌', '今天几号', '你在干嘛 || 带出当前时段', '我失恋了', '周末去哪玩', '你多大了 || 不透露不属于设定的信息'].map((t) => {
    const [text, note] = t.split(' || ');
    return { text, note: note ?? null };
  }),
}];
const detailFor = (p) => ({
  ...p,
  draft: p.final ? { mode: 'casual', bubbles: p.ordinal === 1 ? [b('早呀', 'upbeat'), b('刚醒', 'soft'), b('你怎么这么早呀？', 'upbeat')] : p.final.bubbles } : { mode: 'casual', bubbles: [b('我不是AI，我是真的人', 'neutral')] },
  review: p.final ? {
    decision: 'accept', replacementBubbles: p.final.reviewChanged ? p.final.bubbles : [],
    coverage: { m1: { status: p.final.coverage[0].status, supportQuote: p.final.bubbles[0].text, missingInformation: '' } }, topics: [], factOps: [],
  } : null,
  rejected: p.status === 'failed' && p.settlement === 'settled_known' ? [{
    phase: 'review', errorCode: p.errorCode, rawBytes: 412, truncated: false,
    rawOutput: JSON.stringify({ decision: 'accept', replacementBubbles: [], coverage: { m1: { status: 'answered', supportQuote: '我是真人，不是什么AI', missingInformation: '' } }, topics: [], factOps: [] }, null, 2),
  }] : [],
  ids: { previewId: p.previewId, runId: p.runId, budgetIds: [{ phase: 'draft', budgetId: `["inst","admin-preview","${p.previewId}","draft"]` }, { phase: 'review', budgetId: `["inst","admin-preview","${p.previewId}","review"]` }], providerRequestIds: [{ phase: 'draft', requestId: 'req-8f21c0a1' }] },
});
const previews = {
  list: async () => ({ runs: runs.map((r) => ({ ...r.run, counts: r.run.counts })), singles: [mk(null, null, '单条：你好呀', final([b('你好呀', 'upbeat')]), { runId: null, ordinal: null, previewId: 'solo-1' })] }),
  run: async (_c, id) => runs.find((r) => r.run.runId === id),
  detail: async (_c, id) => detailFor([...A, ...B, mk(null, null, '单条：你好呀', final([b('你好呀', 'upbeat')]), { runId: null, ordinal: null, previewId: 'solo-1' })].find((p) => p.previewId === id)),
  status: async () => ({ previews: [], active: 0 }),
  startRun: async () => ({ runId: 'x', replayed: false }),
  startSingle: async () => mk(null, null, 'x', final([b('x')])),
  evalSets: async () => sets, saveEvalSet: async (i) => ({ ...sets[0], ...i, version: 4 }), deleteEvalSet: async () => {},
};
const draft = { characterId: 'wei-guagua', revision: 5, baseVersion: 2, contentHash: hash, savedAt: NOW, profile: { template: { id: 'wei-guagua', schedule: { timeZone: 'Asia/Singapore', days: {} } }, presentation: { displayName: '瓜瓜' } } };
const characters = {
  list: async () => ({ characters: [
    { characterId: 'wei-guagua', displayName: '瓜瓜', publishedVersion: 2, draftRevision: 5 },
    { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 4, draftRevision: null },
    { characterId: 'chen-jimi', displayName: '陈基米', publishedVersion: 1, draftRevision: 2 },
  ], deletions: [] }),
  detail: async (id) => ({ characterId: id, published: null, draft: { ...draft, characterId: id }, previews: [], previewAvailable: true }),
};

if (scene.startsWith('admin')) {
  const { startAccountAdminPage } = await import('/apps/player-web/src/features/admin/account-admin-page.js');
  const session = { csrf: 'c', expiresAt: NOW + 3_600_000, emailDeliveryAvailable: true,
    member: { id: 'm1', label: '主管理员', role: 'owner', email: 'owner@example.com', permissions: [], createdAt: 1 } };
  const never = async () => { throw new Error('unused in screenshots'); };
  startAccountAdminPage(root, {
    restore: async () => session, emailLogin: never, login: never, logout: async () => {}, bindStart: never, bindFinish: never,
    resetStart: never, resetFinish: never, members: async () => [], issueMember: never, setPermissions: never, revokeCredential: never,
    issue: never, revokeInvite: never, inviteRecords: async () => ({ records: [] }), characters, previews,
  });
} else {
  const { startPrototype } = await import('/apps/player-web/src/features/prototype/preview.js');
  const { LiveBinding } = await import('/apps/player-web/src/features/prototype/provider-binding.js');
  const { syntheticProviderBootstrap, parseWebProviderBootstrap } = await import('/packages/contracts/web-provider.js');
  const boot = syntheticProviderBootstrap();
  boot.fixture = false;
  for (const c of boot.characters) c.availability = { state: 'available', personaVersion: 1 };
  boot.access.remainingReplies = scene === 'player-trial-used' ? 0 : 3;
  boot.access.canSend = scene !== 'player-trial-used';
  const account = scene === 'player-signed-in'
    ? { signupEnabled: true, signedIn: true, kind: 'guest', hasLogin: true, emailMasked: 'a***@example.com', nickname: '阿泡', canBind: false }
    : { signupEnabled: true, signedIn: false };
  const view = parseWebProviderBootstrap(boot);
  const api = new Proxy({ bootstrap: async () => view, account: async () => account, history: async () => ({ messages: [] }) }, {
    get: (t, k) => (k in t ? t[k] : async () => ({})),
  });
  startPrototype(root, await LiveBinding.connect(api));
}
document.body.dataset.ready = '1';
