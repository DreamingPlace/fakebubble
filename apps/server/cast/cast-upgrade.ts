import { createHash } from 'node:crypto';
import { CAST_LEGACY_SCHEMA, CAST_SCHEMA } from '../../../packages/contracts/web-cast.ts';

/**
 * Schema 1 → 2 (Part 24i), IN MEMORY and lossless. A stored draft or publication is never rewritten by a read; the next save writes
 * schema 2. Rules:
 *  - `directions[].address` (one string) becomes `addresses` with exactly one item holding the same text - even if it contains "/",
 *    "、" or spaces (historical text is never split). An empty address becomes [].
 *  - `identity.aliases[]` gain `kind: 'other'`; text and attitude are unchanged.
 *  - every existing id is kept. The new address item gets an id derived from its direction's id, so reading the same stored document
 *    twice gives the same ids (`deriveIds`); a cast FILE has no stored ids to be stable against, so its items get none and the importer
 *    assigns them (or reuses the draft's when the content is unchanged).
 * Anything that is not the expected shape is left exactly as it is: normalizeCastDoc then refuses it with a path.
 */
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const isLegacyCastDoc = (raw: unknown): boolean => isObj(raw) && raw.schema === CAST_LEGACY_SCHEMA;

const derivedId = (directionId: string) =>
  `e_${createHash('sha256').update(`address:${directionId}`).digest('hex').slice(0, 20)}`;

export function upgradeCastDoc(raw: unknown, options: { deriveIds: boolean }): unknown {
  if (!isLegacyCastDoc(raw)) return raw;
  const doc = structuredClone(raw) as Obj;
  doc.schema = CAST_SCHEMA;
  if (Array.isArray(doc.characters))
    for (const character of doc.characters) {
      if (!isObj(character) || !isObj(character.identity) || !Array.isArray(character.identity.aliases)) continue;
      character.identity.aliases = character.identity.aliases.map((alias: unknown) =>
        isObj(alias) && !('kind' in alias) ? reorder({ ...alias, kind: 'other' }) : alias,
      );
    }
  if (Array.isArray(doc.directions))
    doc.directions = doc.directions.map((direction: unknown) => {
      if (!isObj(direction) || !('address' in direction) || 'addresses' in direction) return direction;
      const { address, ...rest } = direction;
      if (typeof address !== 'string') return direction;
      const item: Obj = { text: address };
      if (options.deriveIds && typeof rest.id === 'string') item.id = derivedId(rest.id);
      return reorder({ ...rest, addresses: address === '' ? [] : [item] }, [
        'id',
        'from',
        'to',
        'addresses',
        'treatment',
      ]);
    });
  return doc;
}

/** Key order is irrelevant to validation; only here so an upgraded entry reads like a schema 2 one. */
function reorder(value: Obj, order: readonly string[] = ['id', 'text', 'kind', 'attitude']): Obj {
  const out: Obj = {};
  for (const key of order) if (key in value) out[key] = value[key];
  for (const key of Object.keys(value)) if (!(key in out)) out[key] = value[key];
  return out;
}
