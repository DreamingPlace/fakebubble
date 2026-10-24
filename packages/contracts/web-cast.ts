/**
 * The cast (Part 24a): one versioned document for the shared world - characters, relationships, groups, stories and memes - and the
 * per-character view the prompt receives. Types and limits only; apps/server/cast/ validates and compiles.
 *
 * Every editable entry carries a stable, server-generated `id` (kept across edits; later overrides and the console refer to it).
 * A chat character is keyed by its character_templates id (`characterId`); a person who is not a chat character is a `people` entry.
 */
export const CAST_SCHEMA = 1;

/** Per-field caps (JavaScript string length) and counts. The document as a whole is capped by CAST_DOC_MAX. */
export const CAST_LIMITS = Object.freeze({
  /** doc_json (and so a draft or a publication) never exceeds this many characters. */
  docMax: 300_000,
  /** Compiled view of ONE character, JSON.stringify length (see compileCastView for what is dropped when it is over). */
  viewMax: 24_000,
  chatCharacters: 15,
  people: 40,
  groups: 6,
  stories: 60,
  memes: 30,
  groupStories: 8,
  worldBackground: 1_000,
  idLength: 128,
  // identity
  oneLiner: 40,
  names: 3,
  peopleNames: 2,
  name: 12,
  aliases: 3,
  alias: 12,
  selfConcept: 240,
  prototypeText: 150,
  // sections of a chat character
  profile: 800,
  personality: 800,
  performance: 600,
  unmapped: 6_000,
  catchphrases: 5,
  catchphrase: 30,
  samples: 5,
  sample: 100,
  avoid: 5,
  avoidText: 50,
  experiences: 4,
  experienceTitle: 24,
  experienceText: 280,
  hidden: 5,
  hiddenText: 120,
  // relationships
  address: 16,
  treatment: 100,
  // groups and stories
  groupName: 20,
  groupBackground: 120,
  groupMembers: 15,
  storyTitle: 30,
  storySummary: 200,
  storyDetails: 500,
  storyBoundary: 100,
  storyPeriod: 20,
  storyParticipants: 20,
  storyOverrides: 15,
  // memes
  memeKey: 24,
  memeParties: 8,
  memeMeaning: 120,
  memeTrigger: 100,
  memeProhibited: 100,
});

/** Request body limit of cast/save: a 300,000-character document is at most 900,000 bytes of UTF-8, plus the envelope. */
export const CAST_BODY_LIMIT = 1_000_000;

export type CastAliasAttitude = 'likes' | 'ok' | 'dislikes';
export const CAST_ALIAS_ATTITUDES: readonly CastAliasAttitude[] = ['likes', 'ok', 'dislikes'];
/** 亲历 / 听说 / 不知道. */
export type CastKnowledge = 'lived' | 'heard' | 'unknown';
export const CAST_KNOWLEDGE: readonly CastKnowledge[] = ['lived', 'heard', 'unknown'];
/** How the prompt (and the console) spells each level. */
export const CAST_KNOWLEDGE_LABEL: Readonly<Record<CastKnowledge, string>> = Object.freeze({
  lived: '亲历',
  heard: '听说',
  unknown: '不知道',
});

export interface CastText {
  id: string;
  text: string;
}
export interface CastAlias extends CastText {
  /** How the character feels about being called this. */
  attitude: CastAliasAttitude;
}
export interface CastExperience {
  id: string;
  title: string;
  text: string;
}
/** `start` / `end` are '' or YYYY, YYYY-MM or YYYY-MM-DD. A story with no start sorts as the oldest. */
export interface CastPeriod {
  start: string;
  end: string;
}
export interface CastCharacter {
  /** The character_templates id. */
  characterId: string;
  identity: {
    oneLiner: string;
    names: CastText[];
    aliases: CastAlias[];
    selfConcept: string;
    /** A `people` entry of kind 'prototype' this character is modelled on, and what is and is not taken from it. */
    prototype: { personId: string; inherited: string; notInherited: string } | null;
  };
  profile: string;
  personality: string;
  speech: { catchphrases: CastText[]; samples: CastText[]; avoid: CastText[] };
  experiences: CastExperience[];
  /** 演绎说明: how to play the character. Never shown to anyone else's prompt. */
  performance: string;
  /** Settings the character knows but never states directly. Never shown to anyone else's prompt. */
  hidden: CastText[];
  /** What import-legacy could not map (kept so nothing is lost). Not part of the compiled view. */
  unmapped: string;
}
export interface CastPerson {
  id: string;
  kind: 'person' | 'prototype';
  names: CastText[];
  oneLiner: string;
}
/** How `from` treats `to` (称呼: what from calls to; 相处: how from behaves with to). */
export interface CastDirection {
  id: string;
  from: string;
  to: string;
  address: string;
  treatment: string;
}
export interface CastGroupStory {
  id: string;
  title: string;
  summary: string;
  details: string;
  period: CastPeriod;
  boundary: string;
}
export interface CastGroup {
  id: string;
  name: string;
  /** Chat character ids. */
  members: string[];
  /** 组合背景. */
  background: string;
  stories: CastGroupStory[];
}
export interface CastOverride {
  id: string;
  characterId: string;
  level: CastKnowledge;
}
export interface CastStory {
  id: string;
  title: string;
  summary: string;
  details: string;
  period: CastPeriod;
  /** Chat character ids and people ids. */
  participants: string[];
  /** 叙述边界: what the character may and may not do with this story. */
  boundary: string;
  overrides: CastOverride[];
}
export interface CastMeme {
  id: string;
  key: string;
  /** Chat character ids and people ids. */
  parties: string[];
  meaning: string;
  trigger: string;
  prohibited: string;
}
export interface CastDoc {
  schema: typeof CAST_SCHEMA;
  world: { background: string };
  characters: CastCharacter[];
  people: CastPerson[];
  /** ratings[A][B] = how A feels about B (row → column), 0-5 in steps of 0.5. A missing entry is "not set", which is not 0. */
  ratings: Record<string, Record<string, number>>;
  directions: CastDirection[];
  groups: CastGroup[];
  stories: CastStory[];
  memes: CastMeme[];
}

export interface CastIssue {
  /** Machine code, e.g. CAST_DUPLICATE_ID. */
  code: string;
  /** Where, spelled with ids and indexes only - never with content. */
  path: string;
}
export interface CastValidation {
  errors: CastIssue[];
  warnings: CastIssue[];
}

/** What the prompt carries for one character (request.cast.view). Spelled for the model: Chinese values for the levels. */
export interface CastCard {
  name: string;
  names: string[];
  aliases: string[];
  oneLiner: string;
}
export interface CastViewStory {
  title: string;
  level: '亲历' | '听说';
  /** True when an override (not the default rule) decided the level. */
  fromOverride: boolean;
  period: CastPeriod;
  participants: string[];
  narrationBoundary: string;
  summary: string;
  /** Only a story the character lived carries details; one he heard of is the summary alone. */
  details?: string;
}
export interface CastView {
  world: { background: string };
  self: {
    name: string;
    oneLiner: string;
    names: string[];
    aliases: { text: string; attitude: CastAliasAttitude }[];
    selfConcept: string;
    prototype: { name: string; inherited: string; notInherited: string } | null;
    profile: string;
    personality: string;
    speech: { catchphrases: string[]; samples: string[]; avoid: string[] };
    experiences: { title: string; text: string }[];
    performance: string;
    hiddenSettings: { rule: string; items: string[] };
  };
  others: CastCard[];
  relations: { to: string; rating?: number; address?: string; treatment?: string }[];
  groups: {
    name: string;
    members: string[];
    background: string;
    stories: (Omit<CastViewStory, 'level' | 'fromOverride' | 'participants'> & { level: '亲历' })[];
  }[];
  stories: CastViewStory[];
  memes: { key: string; parties: string[]; meaning: string; trigger: string; prohibited: string }[];
}
/** The frozen/transported form: the view plus the publication it came from. */
export interface CastRequestContext {
  version: number;
  digest: string;
  /** castPromptHash(): the two cast prompt files this view is read with. */
  promptHash: string;
  view: CastView;
}
