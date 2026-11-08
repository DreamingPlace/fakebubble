/**
 * Part 24j: what the read templates do to the cast DRAFT (关系与故事). PURE: the current document and the imported characters in; the
 * merged document, a readable change list and located problems / warnings out. MERGED, never replaced:
 *  - only the imported characters' name cards (names, aliases with kind and attitude, one-liner), the directions A→B named by a
 *    relation block and, for each unordered pair {A, B}, ONE GROUP of exactly those two members are touched (Part 24m): named by the
 *    CP名 (else 「A与B」), its story is the pair's 相处方式及共同经历. An earlier import's story 「A与B」 (participants exactly [A, B])
 *    and meme (key = CP名, parties exactly [A, B]) for the pair are replaced by the group; no meme is made any more;
 *  - every other entry (other characters, people, other groups, stories, memes, ratings, world) is passed through untouched, so it stays
 *    byte-identical;
 *  - an entry the import already made is found again by what identifies it (text+kind, from+to, exact member pair) and
 *    keeps its id, so importing the same files twice writes nothing; new entries get ids from normalizeCastDoc;
 *  - ratings are never written.
 */
import {
  CAST_LIMITS,
  type CastAlias,
  type CastAliasAttitude,
  type CastAliasKind,
  type CastCharacter,
  type CastDirection,
  type CastDoc,
  type CastGroup,
  type CastGroupStory,
  type CastText,
} from '../../../packages/contracts/web-cast.ts';
import type { ProfileProblem, ReadProfile } from './profile-template.ts';
import { same, show, type Change } from './profile-merge.ts';

export interface CastSubject {
  characterId: string;
  read: ReadProfile;
}
export interface CastChange extends Change {
  /** The 人设名称 the entry is about. */
  who: string;
}
const KIND_ATTITUDE: Record<CastAliasKind, CastAliasAttitude> = {
  self: 'likes',
  other: 'likes',
  neutral: 'ok',
  insult: 'dislikes',
};
const KIND_LABEL: Record<CastAliasKind, string> = { self: '自称', other: '别名', neutral: '中性称呼', insult: '黑称' };
const KINDS: readonly CastAliasKind[] = ['self', 'other', 'neutral', 'insult'];
// Ids are assigned by normalizeCastDoc for entries that have none yet.
type NoId<T> = Omit<T, 'id'> & { id?: string };

/** `items` as cast text entries, keeping the id of an existing entry with the same text. */
const texts = (existing: readonly CastText[], items: readonly string[]): NoId<CastText>[] =>
  items.map((text) => {
    const found = existing.find((e) => e.text === text);
    return found ? found : { text };
  });

function blankCard(characterId: string, name: string): CastCharacter {
  return {
    characterId,
    identity: { oneLiner: '', names: [{ text: name } as CastText], aliases: [], selfConcept: '', prototype: null },
    profile: '',
    personality: '',
    speech: { catchphrases: [], samples: [], avoid: [] },
    experiences: [],
    performance: '',
    hidden: [],
    unmapped: '',
  };
}
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Details of a story as `（名侧）text` segments; text before the first mark is kept as the lead. */
export function splitSides(details: string, names: readonly string[]) {
  const sides = new Map<string, string>();
  const lead: string[] = [];
  let current: string | null = null;
  for (const line of details.split('\n')) {
    const name = names.find((n) => line.startsWith(`（${n}侧）`));
    if (name) {
      current = name;
      sides.set(name, line.slice(`（${name}侧）`.length));
    } else if (current !== null) sides.set(current, `${sides.get(current)}\n${line}`);
    else lead.push(line);
  }
  return { lead: lead.join('\n'), sides };
}

export function mergeCast(
  current: CastDoc,
  subjects: readonly CastSubject[],
  /** code (lower-cased) → character id, for characters that already have a code (any, in or out of this import). */
  codes: ReadonlyMap<string, string>,
): { doc: CastDoc; changes: CastChange[]; problems: ProfileProblem[]; warnings: ProfileProblem[] } {
  const doc = structuredClone(current) as CastDoc;
  const changes: CastChange[] = [];
  const problems: ProfileProblem[] = [];
  const warnings: ProfileProblem[] = [];
  const bySubject = new Map(subjects.map((s) => [s.read.code.toLowerCase(), s]));
  const nameOf = (characterId: string) => {
    const subject = subjects.find((s) => s.characterId === characterId);
    return (
      subject?.read.name ?? doc.characters.find((c) => c.characterId === characterId)?.identity.names[0]?.text ?? ''
    );
  };
  const log = (who: string, field: string, before: unknown, after: unknown) => {
    if (!same(before, after)) changes.push({ who, field, old: show(before), new: show(after) });
  };

  // ---- name cards ----
  for (const { characterId, read } of subjects) {
    let card = doc.characters.find((c) => c.characterId === characterId);
    const was = card ? structuredClone(card) : null;
    if (!card) {
      card = blankCard(characterId, read.name);
      doc.characters.push(card);
    }
    const names = [
      ...texts(card.identity.names, [read.name]),
      ...card.identity.names.filter((n) => n.text !== read.name),
    ].slice(0, CAST_LIMITS.names) as CastText[];
    card.identity.names = names;
    if (read.cardOneLiner !== '') card.identity.oneLiner = read.cardOneLiner;
    const files: Record<CastAliasKind, string[]> = {
      self: read.selfNames,
      other: read.aliases,
      neutral: read.neutralNames,
      insult: read.insultNames,
    };
    if (KINDS.some((kind) => files[kind].length)) {
      const aliases: NoId<CastAlias>[] = [];
      for (const kind of KINDS) {
        const kept = card.identity.aliases.filter((a) => a.kind === kind);
        if (!files[kind].length) aliases.push(...kept);
        else
          for (const text of files[kind]) {
            const found = kept.find((a) => a.text === text);
            aliases.push(found ?? { text, kind, attitude: KIND_ATTITUDE[kind] });
          }
      }
      card.identity.aliases = aliases as CastAlias[];
    }
    const label = (c: CastCharacter | null) =>
      c
        ? [
            c.identity.names.map((n) => n.text).join('、'),
            c.identity.oneLiner,
            c.identity.aliases.map((a) => `${KIND_LABEL[a.kind]}「${a.text}」`).join(''),
          ]
            .filter((part) => part !== '')
            .join(' · ')
        : '';
    log(read.name, '名片', label(was), label(card));
    if (card.identity.names.length > CAST_LIMITS.names) card.identity.names.length = CAST_LIMITS.names;
  }

  // ---- relation blocks: directions, and the sides of each pair ----
  type Side = { subject: CastSubject; targetId: string; relation: ReadProfile['relations'][number] };
  const pairs = new Map<string, { a: string; b: string; sides: Side[] }>();
  const resolve = (codeKey: string) =>
    bySubject.get(codeKey)?.characterId ??
    (() => {
      const id = codes.get(codeKey);
      return id !== undefined && doc.characters.some((c) => c.characterId === id) ? id : undefined;
    })();
  for (const subject of subjects) {
    for (const relation of subject.read.relations) {
      const targetId = resolve(relation.code.toLowerCase());
      const here = `7 人物关系 · 关系 ${relation.block}`;
      if (!targetId) {
        warnings.push({
          code: 'PROFILE_RELATION_UNRESOLVED',
          file: subject.read.file,
          section: here,
          field: '对方角色代码',
          item: relation.block,
          text: `代码 ${relation.code} 对不上任何角色，这一块没有写入`,
        });
        continue;
      }
      const key = [subject.characterId, targetId].sort().join('|');
      const entry = pairs.get(key) ?? { a: subject.characterId, b: targetId, sides: [] };
      entry.sides.push({ subject, targetId, relation });
      pairs.set(key, entry);

      // direction A→B
      if (relation.addresses.length || relation.attitude !== '') {
        let direction: NoId<CastDirection> | undefined = doc.directions.find(
          (d) => d.from === subject.characterId && d.to === targetId,
        );
        const was = direction ? structuredClone(direction) : null;
        if (!direction) {
          direction = { from: subject.characterId, to: targetId, addresses: [], treatment: '' };
          doc.directions.push(direction as CastDirection);
        }
        if (relation.addresses.length)
          direction.addresses = texts(direction.addresses, relation.addresses) as CastText[];
        if (relation.attitude !== '') direction.treatment = relation.attitude;
        const to = nameOf(targetId);
        const line = (d: NoId<CastDirection>) =>
          [d.addresses.map((a) => `「${a.text}」`).join(''), d.treatment].filter((part) => part !== '').join(' · ');
        log(subject.read.name, `称呼与相处 → ${to}`, was ? line(was) : '', line(direction));
      }
    }
  }

  // ---- one group per unordered pair (Part 24m) ----
  for (const { a, b, sides } of pairs.values()) {
    // The first side is the one with the smaller 角色代码 (case-insensitive), so the order never depends on the file order.
    const codeOf = (id: string) =>
      subjects.find((s) => s.characterId === id)?.read.code ?? [...codes].find(([, v]) => v === id)?.[0] ?? id;
    const [first, second] = [a, b].sort((x, y) => (codeOf(x).toLowerCase() < codeOf(y).toLowerCase() ? -1 : 1)) as [
      string,
      string,
    ];
    const firstName = nameOf(first),
      secondName = nameOf(second);
    const side = (id: string) => sides.find((s) => s.subject.characterId === id);
    const text = (id: string) => side(id)?.relation.shared ?? '';
    const title = `${firstName}与${secondName}`;
    const participants = [first, second];
    const here = (s: Side) => `7 人物关系 · 关系 ${s.relation.block}`;

    const cps = [...new Set(sides.map((s) => s.relation.cp).filter((cp) => cp !== ''))];
    if (cps.length > 1) {
      for (const s of sides)
        problems.push({
          code: 'PROFILE_CP_MISMATCH',
          file: s.subject.read.file,
          section: here(s),
          field: 'CP名',
          item: s.relation.block,
          text: `与对方文件里的 CP名 不一致（「${cps.join('」「')}」）`,
        });
      continue;
    }
    const cp = cps[0] ?? '';
    const limit = (field: string, value: string, max: number, name: string) => {
      if (value.length > max) {
        const owner = sides[0]!.subject.read;
        problems.push({
          code: 'PROFILE_TOO_LONG',
          file: owner.file,
          section: `关系与故事 · ${title}`,
          field,
          item: null,
          text: `${name}超过 ${max} 字（${value.length}）`,
        });
      }
    };

    // The group of exactly this pair. A new one is named by the CP名, else 「A与B」; an existing one keeps its name unless a CP名 is given.
    let group: NoId<CastGroup> | undefined = doc.groups.find(
      (g) => g.members.length === participants.length && sameSet(g.members, participants),
    );
    const was = group ? structuredClone(group) : null;
    if (!group) {
      group = { name: cp !== '' ? cp : title, members: participants, background: '', stories: [] };
      doc.groups.push(group as CastGroup);
    } else if (cp !== '') group.name = cp;
    limit('CP名', group.name, CAST_LIMITS.groupName, '组合名');

    if (text(first) !== '' || text(second) !== '') {
      let story: NoId<CastGroupStory> | undefined = group.stories.find((s) => s.title === title);
      const { lead, sides: have } = splitSides(story?.details ?? '', [firstName, secondName]);
      if (text(first) !== '') have.set(firstName, text(first));
      if (text(second) !== '') have.set(secondName, text(second));
      const details = [
        ...(lead === '' ? [] : [lead]),
        ...[firstName, secondName].filter((n) => have.has(n)).map((n) => `（${n}侧）${have.get(n)}`),
      ].join('\n');
      const summary = text(first) !== '' ? text(first) : story && story.summary !== '' ? story.summary : text(second);
      if (!story) {
        story = { title, summary, details, period: { start: '', end: '' }, boundary: '' };
        group.stories.push(story as CastGroupStory);
      } else {
        story.summary = summary;
        story.details = details;
      }
      limit('标题', title, CAST_LIMITS.storyTitle, '故事标题');
      limit('相处方式及共同经历', details, CAST_LIMITS.storyDetails, '两侧合并后的详情');
      // What an earlier import wrote for this pair as a story of the cast is replaced by the group's story: the story titled
      // 「A与B」 whose participants are exactly [A, B]. Nothing else is touched.
      const old = doc.stories.findIndex((s) => s.title === title && sameSet(s.participants, participants));
      if (old >= 0) {
        const gone = doc.stories.splice(old, 1)[0]!;
        log(firstName, `故事「${title}」`, `${gone.summary}｜${gone.details}`, '（已并入组合）');
      }
    }
    // The meme an earlier import made for the CP名: keyed by it, with exactly this pair as its parties. No meme is made any more.
    if (cp !== '') {
      const old = doc.memes.findIndex(
        (m) => m.key === cp && m.parties.length === 2 && sameSet(m.parties, participants),
      );
      if (old >= 0) {
        const gone = doc.memes.splice(old, 1)[0]!;
        log(firstName, `梗「${cp}」`, `${gone.key}｜${gone.meaning}`, '（已并入组合）');
      }
    }
    const line = (g: NoId<CastGroup> | null) =>
      g
        ? `${g.name}｜${g.members.map(nameOf).join('、')}｜${g.stories.map((s) => `${s.summary}｜${s.details}`).join('；')}`
        : '';
    log(firstName, `组合「${group.name}」`, line(was), line(group));
  }
  return { doc, changes, problems, warnings };
}
