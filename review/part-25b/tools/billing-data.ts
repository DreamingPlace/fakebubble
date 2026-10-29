import { parseBillingPage, type BillingPage } from '../../../packages/contracts/player-billing.ts';
const H = 3600_000, D = 24 * H;
/** A refill player's 消费记录: months by model and by character, replies (voice and not, a backup), a refund, a refill, bonus and grant. */
export function billingFixture(now = Date.now()): BillingPage {
  const page: BillingPage = {
    metered: true,
    balance: 470,
    quota: { total: 600, used: 130 },
    trial: null,
    month: {
      byModel: [
        { model: 'deepseek', points: 74, replies: 31 },
        { model: 'gemini', points: 60, replies: 12 },
        { model: 'xai', points: 50, replies: 8 },
      ],
      byCharacter: [
        { characterId: 'wei-guagua', points: 92, replies: 27 },
        { characterId: 'jojo', points: 61, replies: 16 },
        { characterId: 'chen-jimi', points: 31, replies: 8 },
      ],
    },
    items: [
      { kind: 'reply', at: now - 1 * H, characterId: 'wei-guagua', model: 'deepseek', voice: true, points: 12, free: false },
      { kind: 'reply', at: now - 3 * H, characterId: 'jojo', model: 'gemini', voice: false, points: 20, free: false },
      { kind: 'failed', at: now - 5 * H, characterId: 'chen-jimi', refunded: 10, free: false },
      { kind: 'daily_refill', at: now - 9 * H, points: 50 },
      { kind: 'reply', at: now - 1 * D, characterId: 'wei-guagua', model: 'deepseek', backupFor: 'xai', voice: true, points: 12, free: false },
      { kind: 'reply', at: now - 1 * D - 2 * H, characterId: 'chen-jimi', model: 'xai', voice: true, points: 27, free: false },
      { kind: 'grant', at: now - 3 * D, points: 100 },
      { kind: 'reply', at: now - 4 * D, characterId: 'jojo', model: 'deepseek', voice: false, points: 10, free: false },
      { kind: 'trial', at: now - 8 * D, characterId: 'jojo', model: 'deepseek' },
      { kind: 'bonus', at: now - 8 * D, points: 30 },
    ],
    page: 1,
    hasMore: false,
  };
  if (!parseBillingPage(JSON.parse(JSON.stringify(page)))) throw new Error('billing fixture does not satisfy the contract');
  return page;
}
