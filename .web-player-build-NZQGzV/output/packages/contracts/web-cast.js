/**
 * The cast (Part 24a): one versioned document for the shared world - characters, relationships, groups, stories and memes - and the
 * per-character view the prompt receives. Types and limits only; apps/server/cast/ validates and compiles.
 *
 * Every editable entry carries a stable, server-generated `id` (kept across edits; later overrides and the console refer to it).
 * A chat character is keyed by its character_templates id (`characterId`); a person who is not a chat character is a `people` entry.
 */
export const CAST_SCHEMA = 2;
/** The previous document schema. Read (in memory, losslessly) and never written; see apps/server/cast/cast-upgrade.ts. */
export const CAST_LEGACY_SCHEMA = 1;
/**
 * LENGTH CONVENTION. Every text limit of the cast is JavaScript string length, i.e. UTF-16 code units: one 汉字 = 1, one ASCII letter
 * = 1, one emoji outside the BMP = 2, a combining mark = 1. Spaces inside an item are part of it ("Mary Jane" is 9) and are never
 * split on or collapsed. Leading / trailing whitespace, line breaks and control characters in an alias or an address are REJECTED
 * with a located error, never trimmed. `castLength` and `castItemProblem` are the one implementation of this, used by the server
 * validator and the admin editor alike (docs/CAST_FILE.md says the same in words). Part 24l: an identity alias (any kind) holds up to
 * CAST_LIMITS.alias = 25 units; an address (称呼) item stays at CAST_LIMITS.address = 16.
 */
export const castLength = (value) => value.length;
// C0 and C1 controls (this includes tab, CR, LF, NEL) and the Unicode line / paragraph separators.
const ITEM_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const ITEM_EDGE_SPACE = /^\s|\s$/u;
export function castItemProblem(value, max) {
    if (value.length === 0)
        return 'empty';
    if (ITEM_CONTROL.test(value))
        return 'control';
    if (ITEM_EDGE_SPACE.test(value))
        return 'space';
    return castLength(value) > max ? 'long' : null;
}
/** The issue code of each item problem (the server validator and the admin editor report the same code, so the same sentence). */
export const CAST_ITEM_CODE = Object.freeze({
    empty: 'CAST_ITEM_EMPTY',
    control: 'CAST_ITEM_CONTROL',
    space: 'CAST_ITEM_EDGE_SPACE',
    long: 'CAST_ITEM_TOO_LONG',
});
/** Per-field caps (JavaScript string length, see above) and counts. The document as a whole is capped by CAST_DOC_MAX. */
export const CAST_LIMITS = Object.freeze({
    /** doc_json (and so a draft or a publication) never exceeds this many characters. */
    docMax: 300_000,
    /** Compiled view of ONE character, JSON.stringify length (see compileCastView for what is dropped when it is over). */
    viewMax: 24_000,
    chatCharacters: 15,
    people: 40,
    groups: 120,
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
    aliases: 12,
    alias: 25,
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
    /** 称呼: forms of address for one direction, in order. */
    addresses: 6,
    address: 16,
    treatment: 100,
    /** Document totals. 180 is 15 characters x 12 aliases, so it only binds if the character cap is ever raised; 1,200 binds. */
    aliasesTotal: 180,
    addressesTotal: 1_200,
    // groups and stories
    groupName: 30,
    groupBackground: 120,
    groupMembers: 15,
    storyTitle: 30,
    storySummary: 600,
    storyDetails: 2_000,
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
export const CAST_ALIAS_ATTITUDES = ['likes', 'ok', 'dislikes'];
export const CAST_ALIAS_ATTITUDE_LABEL = Object.freeze({
    likes: '喜欢',
    ok: '可以',
    dislikes: '不喜欢',
});
export const CAST_ALIAS_KINDS = ['self', 'other', 'neutral', 'insult'];
export const CAST_ALIAS_KIND_LABEL = Object.freeze({
    self: '自称',
    other: '别名',
    neutral: '中性称呼',
    insult: '黑称',
});
export const CAST_KNOWLEDGE = ['lived', 'heard', 'unknown'];
/** How the prompt (and the console) spells each level. */
export const CAST_KNOWLEDGE_LABEL = Object.freeze({
    lived: '亲历',
    heard: '听说',
    unknown: '不知道',
});
/** The rule printed in a compiled view next to the names a character must not be called by. */
export const CAST_DO_NOT_CALL_RULE = '不要主动这样叫';
/**
 * The cast file (Part 24b-5): the cast document plus a header, for bulk filling offline and for backups. A character that does not
 * exist yet is keyed `new:<name>` (everywhere it is referred to); only such a character may carry a `workbench` block, which seeds
 * the draft character created for it. apps/server/cast/cast-file.ts reads and validates it; scripts/cast-file.ts is the local check.
 */
export const CAST_FILE_FORMAT = 'burbur-cast';
export const CAST_FILE_VERSION = 1;
export const CAST_FILE_NEW_PREFIX = 'new:';
/** Caps of the `workbench` block (角色工作台 keeps its own, larger ones; a file seeds only a short summary). */
export const CAST_FILE_LIMITS = Object.freeze({ newKey: 40, displayName: 12, persona: 300, welcome: 200 });
