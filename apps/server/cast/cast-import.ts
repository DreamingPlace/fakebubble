import { CAST_LIMITS, type CastKnowledge } from '../../../packages/contracts/web-cast.ts';
import type { CharacterTemplate, JsonValue } from '../../../packages/contracts/index.ts';
import { emptyCastDoc, freshCastId, normalizeCastDoc } from './cast-validation.ts';

/**
 * import-legacy (Part 24a): builds a DRAFT from what the published characters already carry in `authorCanon.settings`. Pure: it
 * reads templates and returns a document; character_templates (persona, authorCanon) is never touched. Whatever has no place in
 * the cast document goes into that character's `unmapped` note, so nothing is lost (the original also stays in authorCanon).
 *
 *  authorCanon.settings.…                      → cast
 *  selfIdentity.names, template.name           → identity.names (the template name first; over the cap → unmapped)
 *  aliases                                     → identity.aliases (attitude 'ok')
 *  basicInfo                                   → profile ("键：值" lines)
 *  speechStyle                                 → speech.catchphrases (short) / speech.samples (long)
 *  dialogueStyle                               → speech.samples
 *  dialogueExamples                            → speech.samples ("玩家：… / 角色：…")
 *  background                                  → experiences
 *  personalityLayers                           → personality
 *  fictionalPeople                             → people (kind 'person': names, one-liner)
 *  canonEvents                                 → stories (same event in several characters = one story); defaultKnowers become
 *                                                overrides ONLY where they differ from the default knowledge rule
 *  everything else (appearance*, interests, pets, fears, boundaries, audienceReception, fictionalLocations, backgroundLabels,
 *  unknown keys, and the overflow of a capped field)                                            → unmapped
 */
export interface LegacySource {
  characterId: string;
  displayName: string;
  publicDescription: string;
  template: CharacterTemplate;
}
export interface LegacyReport {
  characters: number;
  people: number;
  stories: number;
  overrides: number;
  /** Characters whose unmapped note is not empty. */
  withUnmapped: number;
  /** Characters whose unmapped note itself hit its cap (the full original is still in authorCanon). */
  unmappedCut: number;
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;
const oneLine = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
const multiline = (value: string) => value.replace(CONTROL, ' ').trim();
const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : null;
const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Any JSON value as readable text: strings as they are, structures as compact "键：值" lines. */
function plain(value: unknown): string {
  const s = str(value);
  if (s !== null) return s;
  if (Array.isArray(value)) return value.map(plain).filter(Boolean).join('；');
  if (isObject(value))
    return Object.entries(value)
      .map(([key, child]) => `${key}：${plain(child)}`)
      .join('；');
  return '';
}
const BASIC_LABELS: Record<string, string> = {
  englishName: '英文名',
  birthDate: '生日',
  birthPlace: '出生地',
  affiliation: '所属',
  youngestInGeneration: '同辈最小',
  nationalityCulturalIdentity: '国籍与文化身份',
  grewUpIn: '成长地',
};
/** Keys of a fictionalPeople entry whose value reads as the one-liner by itself. */
const PERSON_TEXT_KEYS = new Set([
  'relation',
  'relationship',
  'description',
  'desc',
  'intro',
  'role',
  'note',
  'summary',
]);
const MAPPED = new Set([
  'selfIdentity',
  'aliases',
  'basicInfo',
  'speechStyle',
  'dialogueStyle',
  'dialogueExamples',
  'background',
  'personalityLayers',
  'fictionalPeople',
  'canonEvents',
]);

interface EventDraft {
  key: string;
  title: string;
  summary: string;
  details: string;
  period: { start: string; end: string };
  participants: Set<string>;
  knowers: Set<string>;
  owner: string;
}

export function buildLegacyCast(sources: readonly LegacySource[], fresh: () => string = freshCastId) {
  const L = CAST_LIMITS;
  const chat = sources.slice(0, L.chatCharacters);
  const ids = new Set(chat.map((s) => s.characterId));
  const doc = emptyCastDoc();
  const people: Array<{ key: string; person: { kind: 'person'; names: { text: string }[]; oneLiner: string } }> = [];
  const events = new Map<string, EventDraft>();
  const characters: Array<Record<string, unknown>> = [];
  const notes = new Map<string, string[]>();

  for (const source of chat) {
    const settings = (source.template.authorCanon?.settings ?? {}) as Record<string, JsonValue>;
    const note: string[] = [];
    notes.set(source.characterId, note);
    const keep = (label: string, value: string) => value.trim() && note.push(`【${label}】${multiline(value)}`);
    /** Text into a capped field: what fits stays, the rest goes to the note under `label`. */
    const fit = (label: string, value: string, max: number) => {
      const text = multiline(value);
      if (text.length <= max) return text;
      const cut = text.slice(0, max);
      keep(`${label}（超出部分）`, text.slice(max));
      return cut;
    };
    const short = (label: string, value: string, max: number): string | null => {
      const text = oneLine(value);
      if (!text) return null;
      if (text.length <= max) return text;
      keep(label, text);
      return null;
    };

    // identity
    const identity = isObject(settings.selfIdentity) ? settings.selfIdentity : {};
    const names: string[] = [];
    for (const raw of [source.template.name, ...asList(identity.names)]) {
      const text = str(raw);
      const name = text === null ? null : short('名字', text, L.name);
      if (name && !names.includes(name)) names.push(name);
    }
    if (names.length === 0)
      names.push(oneLine(source.template.name).slice(0, L.name) || source.characterId.slice(0, L.name));
    for (const extra of names.splice(L.names)) keep('名字（超出上限）', extra);
    const aliases: string[] = [];
    for (const raw of asList(settings.aliases)) {
      const text = str(raw);
      const alias = text === null ? null : short('别名', text, L.alias);
      if (alias && !aliases.includes(alias) && !names.includes(alias)) aliases.push(alias);
    }
    for (const extra of aliases.splice(L.aliases)) keep('别名（超出上限）', extra);
    for (const key of Object.keys(identity)) if (key !== 'names') keep(`selfIdentity.${key}`, plain(identity[key]));

    // profile
    const profile: string[] = [];
    if (isObject(settings.basicInfo))
      for (const [key, value] of Object.entries(settings.basicInfo)) {
        const text = plain(value);
        if (text) profile.push(`${BASIC_LABELS[key] ?? key}：${oneLine(text)}`);
      }
    else if (settings.basicInfo !== undefined) profile.push(plain(settings.basicInfo));

    // speech
    const catchphrases: string[] = [],
      samples: string[] = [];
    const sample = (label: string, text: string) => {
      const line = oneLine(text);
      if (!line) return;
      if (line.length <= L.sample && samples.length < L.samples) samples.push(line);
      else keep(label, line);
    };
    for (const item of asList(settings.speechStyle)) {
      const line = oneLine(plain(item));
      if (!line) continue;
      if (line.length <= L.catchphrase && catchphrases.length < L.catchphrases) catchphrases.push(line);
      else sample('speechStyle', line);
    }
    for (const item of asList(settings.dialogueStyle)) sample('dialogueStyle', plain(item));
    for (const item of asList(settings.dialogueExamples)) {
      if (isObject(item)) {
        const reply = asList(item.reply).map(plain).filter(Boolean).join(' / ');
        const where = str(item.situation);
        sample(
          'dialogueExamples',
          `${where ? `${where}｜` : ''}玩家：${plain(item.player)} / ${oneLine(source.template.name)}：${reply}`,
        );
      } else sample('dialogueExamples', plain(item));
    }

    // experiences
    const experiences: { title: string; text: string }[] = [];
    const experience = (title: string, text: string) => {
      const body = multiline(text);
      if (!body) return;
      const heading = oneLine(title).slice(0, L.experienceTitle);
      for (let at = 0; at < body.length; at += L.experienceText) {
        const chunk = body.slice(at, at + L.experienceText);
        if (experiences.length < L.experiences) experiences.push({ title: heading, text: chunk });
        else keep('背景（超出上限）', chunk);
      }
    };
    for (const item of asList(settings.background)) {
      if (isObject(item)) {
        const title = str(item.title) ?? str(item.label) ?? str(item.name) ?? str(item.period) ?? '';
        const { title: _t, label: _l, name: _n, ...rest } = item;
        const body = str(item.text) ?? str(item.description) ?? str(item.content) ?? plain(rest);
        experience(title, body);
      } else experience('背景', plain(item));
    }

    // personality
    const personality: string[] = [];
    if (isObject(settings.personalityLayers))
      for (const [key, value] of Object.entries(settings.personalityLayers))
        personality.push(`${key}：${oneLine(plain(value))}`);
    else
      for (const item of asList(settings.personalityLayers)) {
        if (isObject(item)) {
          const label = str(item.layer) ?? str(item.name) ?? str(item.label) ?? str(item.title);
          const { layer: _a, name: _b, label: _c, title: _d, ...rest } = item;
          const body = str(item.text) ?? str(item.description) ?? str(item.content) ?? plain(rest);
          personality.push(label ? `${label}：${oneLine(body)}` : oneLine(body));
        } else personality.push(oneLine(plain(item)));
      }

    // people around the character
    for (const item of asList(settings.fictionalPeople)) {
      const entry = isObject(item) ? item : { name: plain(item) };
      const name = short('人物', str(entry.name) ?? str(entry.names) ?? '', L.name);
      if (!name) continue;
      const { name: _n, names: _ns, ...rest } = entry;
      const text = oneLine(
        Object.entries(rest)
          .map(([key, value]) => (PERSON_TEXT_KEYS.has(key) ? plain(value) : `${key}：${plain(value)}`))
          .filter(Boolean)
          .join('，'),
      );
      const oneLiner = text.slice(0, L.oneLiner);
      if (text.length > L.oneLiner) keep(`人物 ${name}（超出部分）`, text.slice(L.oneLiner));
      const existing = people.find((p) => p.person.names[0]!.text === name && p.person.oneLiner === oneLiner);
      if (!existing && people.length < L.people)
        people.push({ key: source.characterId, person: { kind: 'person', names: [{ text: name }], oneLiner } });
      else if (!existing) keep('人物（超出上限）', `${name}：${text}`);
    }

    // canon events
    for (const item of asList(settings.canonEvents)) {
      if (!isObject(item)) {
        keep('canonEvents', plain(item));
        continue;
      }
      const {
        title: rawTitle,
        name: rawName,
        summary: rawSummary,
        description: rawDescription,
        text: rawText,
        date: rawDate,
        period: rawPeriod,
        participants: rawParticipants,
        defaultKnowers: rawKnowers,
        sourceKind: _k,
        truthScope: _s,
        id: _i,
        ...rest
      } = item;
      const title = oneLine(str(rawTitle) ?? str(rawName) ?? '事件');
      const body = multiline(str(rawSummary) ?? str(rawDescription) ?? str(rawText) ?? '');
      const dateText = oneLine(str(rawPeriod) ?? str(rawDate) ?? '');
      const dated = /^(\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?)$/.exec(dateText)?.[1];
      const extra = plain(rest);
      const summary = body.slice(0, L.storySummary);
      const details = multiline(
        [body.slice(L.storySummary), dated || !dateText ? '' : `时间：${dateText}`, extra].filter(Boolean).join('\n'),
      );
      const cutAt = L.storyDetails;
      const story: EventDraft = {
        key: JSON.stringify([title.slice(0, L.storyTitle), summary, dated ?? '']),
        title: title.slice(0, L.storyTitle) || '事件',
        summary,
        details: details.slice(0, cutAt),
        period: { start: dated ?? '', end: '' },
        participants: new Set(),
        knowers: new Set(),
        owner: source.characterId,
      };
      if (title.length > L.storyTitle) keep(`事件 ${story.title}（标题超出部分）`, title.slice(L.storyTitle));
      if (details.length > cutAt) keep(`事件 ${story.title}（细节超出部分）`, details.slice(cutAt));
      const merged = events.get(story.key) ?? story;
      events.set(story.key, merged);
      // Participants and knowers that are not characters of this cast cannot be kept as references: they go to the note.
      for (const id of asList(rawParticipants))
        if (typeof id === 'string' && ids.has(id)) merged.participants.add(id);
        else if (id !== undefined) keep(`事件 ${story.title} 的参与者`, plain(id));
      merged.participants.add(source.characterId);
      for (const id of asList(rawKnowers))
        if (typeof id === 'string' && ids.has(id)) merged.knowers.add(id);
        else if (id !== undefined) keep(`事件 ${story.title} 的知情者`, plain(id));
      merged.knowers.add(source.characterId);
    }

    // everything else
    for (const key of Object.keys(settings)) if (!MAPPED.has(key)) keep(key, plain(settings[key]));
    let oneLiner = '';
    if (source.publicDescription) {
      const description = oneLine(source.publicDescription);
      if (description.length <= L.oneLiner) oneLiner = description;
      else keep('publicDescription', description);
    }

    characters.push({
      characterId: source.characterId,
      identity: {
        oneLiner,
        names: names.map((text) => ({ text })),
        aliases: aliases.map((text) => ({ text, attitude: 'ok' })),
        selfConcept: '',
        prototype: null,
      },
      profile: fit('basicInfo', profile.join('\n'), L.profile),
      personality: fit('personalityLayers', personality.join('\n'), L.personality),
      speech: {
        catchphrases: catchphrases.map((text) => ({ text })),
        samples: samples.map((text) => ({ text })),
        avoid: [],
      },
      experiences,
      performance: '',
      hidden: [],
      unmapped: '',
    });
  }

  // stories: the participants are the characters named by the event (its owner at least); defaultKnowers become overrides only
  // where they differ from the default knowledge rule. No ratings exist in a fresh import, so that rule is: a participant lived
  // it, everybody else does not know it. Entries without an id get theirs from normalizeCastDoc.
  const kept = [...events.values()].slice(0, L.stories);
  for (const event of [...events.values()].slice(L.stories))
    notes.get(event.owner)?.push(`【事件（超出上限）】${event.title}：${event.summary}`);
  let overrides = 0;
  const stories = kept.map((event) => {
    const list: { characterId: string; level: CastKnowledge }[] = [];
    for (const { characterId } of characters as Array<{ characterId: string }>) {
      const byRule: CastKnowledge = event.participants.has(characterId) ? 'lived' : 'unknown';
      const knows = event.knowers.has(characterId);
      const wanted: CastKnowledge = event.participants.has(characterId)
        ? knows
          ? 'lived'
          : 'unknown'
        : knows
          ? 'heard'
          : 'unknown';
      if (wanted !== byRule) list.push({ characterId, level: wanted });
    }
    overrides += list.length;
    return {
      title: event.title,
      summary: event.summary,
      details: event.details,
      period: event.period,
      participants: [...event.participants],
      boundary: '',
      overrides: list,
    };
  });
  const raw = withNotes({ ...doc, characters, people: people.map(({ person }) => person), stories } as never, notes);
  const result = normalizeCastDoc(raw, { known: new Set(), fresh });
  const unmappedCut = result.characters.filter((c) => c.unmapped.endsWith(CUT_MARK)).length;
  return {
    doc: result,
    report: {
      characters: result.characters.length,
      people: result.people.length,
      stories: result.stories.length,
      overrides,
      withUnmapped: result.characters.filter((c) => c.unmapped !== '').length,
      unmappedCut,
    } satisfies LegacyReport,
  };
}

const CUT_MARK = '…（未完整保留，原文仍在角色设定中）';
function withNotes(doc: { characters: unknown } & Record<string, unknown>, notes: Map<string, string[]>) {
  const characters = (doc.characters as Array<{ characterId: string; unmapped: string }>).map((character) => {
    const joined = (notes.get(character.characterId) ?? []).join('\n');
    const unmapped =
      joined.length > CAST_LIMITS.unmapped
        ? joined.slice(0, CAST_LIMITS.unmapped - CUT_MARK.length) + CUT_MARK
        : joined;
    return { ...character, unmapped };
  });
  return { ...doc, characters };
}
