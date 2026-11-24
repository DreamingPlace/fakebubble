import { mergeFields } from './draft-merge.ts';
import type { CastDoc } from './web-cast.ts';

/**
 * Part 55: 关系与故事 saved against a draft that moved on (an adoption added a story, another administrator saved) is merged, not
 * refused: `base` is the draft as the page last read it, `mine` the page's edit, `theirs` the draft now. A FIELD is the world
 * background, one entry of a list (character, person, direction, group, story, inside joke), one story of a group, the group itself
 * without its stories, and one cell of the ratings grid. A field changed on one side only is taken from that side; the same field
 * changed on both sides differently is a conflict and is named (never merged). Order of a list follows `theirs`; entries only
 * `mine` has are appended. Pure.
 */
type Obj = Record<string, unknown>;
const LISTS = ['characters', 'people', 'directions', 'stories', 'memes'] as const;
const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const idOf = (list: (typeof LISTS)[number] | 'groups', entry: Obj) =>
  (list === 'characters' ? entry.characterId : entry.id) as string;
const SEP = '\u0001';

export type CastMerge = { ok: true; doc: CastDoc } | { ok: false; conflicts: string[] };

function fieldsOf(doc: CastDoc): Map<string, unknown> | null {
  const out = new Map<string, unknown>();
  out.set(['world', 'background'].join(SEP), doc.world?.background);
  for (const list of LISTS) {
    const seen = new Set<string>();
    for (const entry of (doc[list] ?? []) as unknown as Obj[]) {
      const id = idOf(list, entry);
      if (typeof id !== 'string' || id === '' || seen.has(id)) return null;
      seen.add(id);
      out.set([list, id].join(SEP), entry);
    }
  }
  const groupIds = new Set<string>();
  for (const group of (doc.groups ?? []) as unknown as Obj[]) {
    const id = group.id;
    if (typeof id !== 'string' || id === '' || groupIds.has(id)) return null;
    groupIds.add(id);
    const { stories, ...own } = group;
    out.set(['groups', id].join(SEP), own);
    const seen = new Set<string>();
    for (const story of (Array.isArray(stories) ? stories : []) as Obj[]) {
      if (typeof story.id !== 'string' || story.id === '' || seen.has(story.id)) return null;
      seen.add(story.id);
      out.set(['groups', id, 'stories', story.id].join(SEP), story);
    }
  }
  for (const [from, row] of Object.entries(doc.ratings ?? {}))
    for (const [to, value] of Object.entries(row)) out.set(['ratings', from, to].join(SEP), value);
  return out;
}

const nameOf = (doc: CastDoc, id: string) =>
  doc.characters.find((entry) => entry.characterId === id)?.identity?.names?.[0]?.text ?? '角色';
/** The sentence-ready name of a field. */
function labelOf(path: string, docs: CastDoc[]): string {
  const [kind, id, sub, sid] = path.split(SEP);
  const find = (list: 'people' | 'directions' | 'stories' | 'memes' | 'groups') =>
    docs.flatMap((doc) => (doc[list] ?? []) as unknown as Obj[]).find((entry) => entry.id === id);
  if (kind === 'world') return '世界背景';
  if (kind === 'characters')
    return `角色「${docs.map((doc) => nameOf(doc, id!)).find((name) => name !== '角色') ?? '角色'}」`;
  if (kind === 'people') return `人物「${String(find('people')?.name ?? '')}」`.replace('「」', '');
  if (kind === 'directions') return '说话方向';
  if (kind === 'memes') return '内部梗';
  if (kind === 'stories') return `故事「${String(find('stories')?.title ?? '')}」`;
  if (kind === 'groups') {
    const group = find('groups');
    const name = String(group?.name ?? '');
    if (sub === 'stories') {
      const story = docs
        .flatMap((doc) => (doc.groups ?? []).flatMap((g) => (g.stories ?? []) as unknown as Obj[]))
        .find((entry) => entry.id === sid);
      return `组合「${name}」的故事「${String(story?.title ?? '')}」`;
    }
    return `组合「${name}」`;
  }
  if (kind === 'ratings')
    return `评分（${docs.map((doc) => nameOf(doc, id!)).find((n) => n !== '角色') ?? '角色'}对${docs.map((doc) => nameOf(doc, sub!)).find((n) => n !== '角色') ?? '角色'}）`;
  return '其他内容';
}

export function mergeCastDocs(base: CastDoc, mine: CastDoc, theirs: CastDoc): CastMerge {
  const b = fieldsOf(base),
    m = fieldsOf(mine),
    t = fieldsOf(theirs);
  // An entry without an id of its own cannot be matched: say so as one conflict instead of guessing.
  if (!b || !m || !t) return { ok: false, conflicts: ['草稿的结构'] };
  const merged = mergeFields(b, m, t);
  if (merged.conflicts.length)
    return { ok: false, conflicts: [...new Set(merged.conflicts.map((path) => labelOf(path, [theirs, mine, base])))] };
  const next = structuredClone(theirs) as unknown as Obj & {
    world: Obj;
    ratings: Record<string, Record<string, number>>;
  };
  for (const path of merged.changedByMe) {
    const [kind, id, sub, sid] = path.split(SEP) as [string, string, string?, string?];
    const value = merged.values.get(path);
    if (kind === 'world') next.world = { ...next.world, background: value };
    else if ((LISTS as readonly string[]).includes(kind)) {
      const list = next[kind] as Obj[];
      const at = list.findIndex((entry) => idOf(kind as (typeof LISTS)[number], entry) === id);
      if (value === undefined) {
        if (at >= 0) list.splice(at, 1);
      } else if (at >= 0) list[at] = structuredClone(value) as Obj;
      else list.push(structuredClone(value) as Obj);
    } else if (kind === 'groups') {
      const groups = next.groups as Obj[];
      let at = groups.findIndex((entry) => entry.id === id);
      if (sub === 'stories') {
        if (at < 0) {
          if (value === undefined) continue;
          return { ok: false, conflicts: [labelOf(path, [theirs, mine, base])] };
        }
        const stories = (groups[at]!.stories ??= []) as Obj[];
        const found = stories.findIndex((entry) => entry.id === sid);
        if (value === undefined) {
          if (found >= 0) stories.splice(found, 1);
        } else if (found >= 0) stories[found] = structuredClone(value) as Obj;
        else stories.push(structuredClone(value) as Obj);
      } else if (value === undefined) {
        if (at >= 0) groups.splice(at, 1);
      } else if (at >= 0) groups[at] = { ...(structuredClone(value) as Obj), stories: groups[at]!.stories ?? [] };
      else {
        groups.push({ ...(structuredClone(value) as Obj), stories: [] });
        at = groups.length - 1;
      }
    } else if (kind === 'ratings') {
      const row = (next.ratings[id] ??= {});
      if (value === undefined) {
        delete row[sub!];
        if (Object.keys(row).length === 0) delete next.ratings[id];
      } else row[sub!] = value as number;
    }
  }
  return { ok: true, doc: next as unknown as CastDoc };
}
