import type { CastDoc } from '../../../../../../packages/contracts/web-cast.ts';
import { nameOf } from './cast-model.ts';

/**
 * Part 24b-7: what one stored cast version holds, set against the live one, in words (never an id): the characters' name cards,
 * the directions, the groups, the stories and the memes that were added, removed or changed. Pure; nothing is read or written.
 */
export type CastPart = '角色' | '方向' | '组合' | '故事' | '梗';
export type CastRow = { kind: 'added' | 'removed' | 'changed' | 'same'; label: string; note: string };
export type CastDiff = { part: CastPart; rows: CastRow[] }[];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const join = (names: string[]) => (names.length ? names.join('、') : '—');

type Item = { key: string; label: string; note: string; value: unknown };
/** The things of one part of a document, each with a stable key (an id, or a pair), a readable label and a one-line note. */
function items(doc: CastDoc, part: CastPart): Item[] {
  const name = (id: string) => nameOf(doc, id);
  switch (part) {
    case '角色':
      return doc.characters.map((c) => ({
        key: c.characterId,
        label: c.identity.names[0]?.text || '（未命名）',
        note: c.identity.oneLiner,
        value: c,
      }));
    case '方向':
      return doc.directions.map((d) => ({
        key: `${d.from}\n${d.to}`,
        label: `${name(d.from)} → ${name(d.to)}`,
        note: d.addresses.length ? `称呼 ${join(d.addresses.map((a) => a.text))}` : d.treatment,
        value: d,
      }));
    case '组合':
      return doc.groups.map((g) => ({
        key: g.id,
        label: g.name || '（未命名）',
        note: join(g.members.map(name)),
        value: g,
      }));
    case '故事':
      return doc.stories.map((s) => ({
        key: s.id,
        label: s.title || '（未命名）',
        note: join(s.participants.map(name)),
        value: s,
      }));
    case '梗':
      return doc.memes.map((m) => ({
        key: m.id,
        label: m.key || '（未命名）',
        note: join(m.parties.map(name)),
        value: m,
      }));
  }
}

/** `doc` is the version shown; `live` the live one (null: nothing to compare with, every row is plain content). */
export function castDiff(doc: CastDoc, live: CastDoc | null): CastDiff {
  const parts: CastPart[] = ['角色', '方向', '组合', '故事', '梗'];
  return parts.map((part) => {
    const mine = items(doc, part);
    if (!live) return { part, rows: mine.map((i) => ({ kind: 'same' as const, label: i.label, note: i.note })) };
    const theirs = new Map(items(live, part).map((i) => [i.key, i]));
    const rows: CastRow[] = [];
    // This version AGAINST live: what only this version has is 新增, what only live has is 删除 (going back would drop it).
    for (const i of mine) {
      const now = theirs.get(i.key);
      if (!now) rows.push({ kind: 'added', label: i.label, note: i.note });
      else if (!same(now.value, i.value)) rows.push({ kind: 'changed', label: i.label, note: i.note });
      else rows.push({ kind: 'same', label: i.label, note: i.note });
    }
    const here = new Set(mine.map((i) => i.key));
    for (const i of theirs.values()) if (!here.has(i.key)) rows.push({ kind: 'removed', label: i.label, note: i.note });
    return { part, rows };
  });
}
export const worldChanged = (doc: CastDoc, live: CastDoc | null) =>
  !!live && doc.world.background !== live.world.background;
