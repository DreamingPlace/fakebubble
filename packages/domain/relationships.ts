import type { RelationshipEventCandidate, RelationshipEventKind } from '../contracts/relationships.ts';
import { RELATIONSHIP_EVENT_KINDS } from '../contracts/relationships.ts';
import { ensure } from './errors.ts';

export const RELATIONSHIP_POLICY = Object.freeze({
  version: 1,
  dailyPositive: 3,
  dailyNegative: 2,
  trustMinimum: -20,
  trustMaximum: 40,
  familiarityMaximum: 40,
});
export const RELATIONSHIP_POINTS: Record<RelationshipEventKind, { trust: number; familiarity: number }> = {
  support: { trust: 1, familiarity: 0 },
  boundary_respected: { trust: 2, familiarity: 0 },
  promise_kept: { trust: 2, familiarity: 0 },
  shared_experience: { trust: 0, familiarity: 1 },
  trust_damage: { trust: -1, familiarity: 0 },
  repair: { trust: 1, familiarity: 0 },
};
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    'INVALID_RELATIONSHIP_EVENT',
  );
}
function text(value: unknown, max: number): asserts value is string {
  ensure(
    typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\u0000-\u001f]/u.test(value),
    'INVALID_RELATIONSHIP_EVENT',
  );
}
export function relationshipCandidates(value: unknown): RelationshipEventCandidate[] {
  ensure(Array.isArray(value) && value.length <= 2, 'INVALID_RELATIONSHIP_EVENT');
  return value.map((item) => {
    object(item, ['kind', 'key', 'anchor', 'evidence', 'responseQuote', 'summary', 'basis', 'repairsEventId']);
    ensure(
      RELATIONSHIP_EVENT_KINDS.includes(item.kind as RelationshipEventKind) &&
        ['in_chat', 'player_report'].includes(String(item.basis)),
      'INVALID_RELATIONSHIP_EVENT',
    );
    text(item.key, 64);
    ensure(/^[\p{L}\p{N} _.-]+$/u.test(item.key), 'INVALID_RELATIONSHIP_EVENT');
    ensure(
      Array.isArray(item.evidence) && item.evidence.length >= 1 && item.evidence.length <= 4,
      'INVALID_RELATIONSHIP_EVENT',
    );
    for (const proof of [item.anchor, ...item.evidence]) {
      object(proof, ['messageId', 'quote']);
      text(proof.messageId, 128);
      text(proof.quote, 240);
    }
    text(item.responseQuote, 160);
    text(item.summary, 200);
    if (item.kind === 'repair') text(item.repairsEventId, 128);
    else ensure(item.repairsEventId === null, 'INVALID_RELATIONSHIP_EVENT');
    return structuredClone(item) as unknown as RelationshipEventCandidate;
  });
}
export function relationshipFingerprintText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}
export function isTrivialRelationshipInput(value: string) {
  return /^(嗯+|哦+|好+|好的|好吧|行|在吗|你好|早安|晚安|谢谢|加油|对不起|抱歉|我尊重你|我很尊重你|哈哈+|嘿嘿+)+$/u.test(
    relationshipFingerprintText(value),
  );
}
