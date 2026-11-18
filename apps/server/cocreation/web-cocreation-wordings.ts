import { createHash } from 'node:crypto';
import {
  COCREATION_THEME_IDS,
  COCREATION_WORDING_LIMITS,
  cocreationWordingOk,
  isThemeId,
  type CocreationThemeId,
} from '../../../packages/contracts/cocreation-wordings.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { consoleCharacterOrder } from '../characters/web-character-order.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { WordingDrafts } from './web-cocreation-wordings-gen.ts';

export type WordingEntry = {
  id: string;
  characterId: string;
  themeId: CocreationThemeId;
  text: string;
  enabled: boolean;
  source: 'manual' | 'generated';
};
interface Row {
  id: string;
  character_id: string;
  theme_id: CocreationThemeId;
  text: string;
  enabled: number;
  source: 'manual' | 'generated';
  request_id: string | null;
  request_hash: string | null;
}
const entry = (row: Row): WordingEntry => ({
  id: row.id,
  characterId: row.character_id,
  themeId: row.theme_id,
  text: row.text,
  enabled: row.enabled === 1,
  source: row.source,
});
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifierOk = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/**
 * Part 39b: the wording pool of every character's themes. Plain storage rules; who may call it (session, CSRF, Origin, permission) and the
 * audit line are the business object's. Nothing here calls a provider.
 */
export class WordingPool {
  private readonly store: BusinessStore;
  private readonly now: () => number;
  private readonly nextId: () => string;
  constructor(store: BusinessStore, now: () => number, nextId: () => string) {
    this.store = store;
    this.now = now;
    this.nextId = nextId;
  }
  /** A live character the pool can be about (in the catalog and not deleted). */
  characterOk(characterId: unknown): characterId is string {
    return (
      identifierOk(characterId) &&
      !!this.store.get('SELECT 1 FROM web_character_catalog WHERE character_id=?', characterId) &&
      !webCharacterDeleted(this.store, characterId)
    );
  }
  /** The enabled wordings of one character per theme, for the player's sheet: text only, no ids and no switched-off entry. */
  enabled(characterId: string): Record<CocreationThemeId, string[]> {
    const out = Object.fromEntries(COCREATION_THEME_IDS.map((id) => [id, [] as string[]])) as Record<
      CocreationThemeId,
      string[]
    >;
    for (const row of this.store.all<{ theme_id: CocreationThemeId; text: string }>(
      'SELECT theme_id,text FROM web_cocreation_wordings WHERE character_id=? AND enabled=1 ORDER BY created_at,id',
      characterId,
    ))
      out[row.theme_id]?.push(row.text);
    return out;
  }
  /** Every entry of every live character (the console's 「题目」), with the characters in console order. */
  all() {
    const order = consoleCharacterOrder(this.store).filter((id) => this.characterOk(id));
    const rank = new Map(order.map((id, at) => [id, at] as const));
    const entries = this.store
      .all<Row>('SELECT * FROM web_cocreation_wordings ORDER BY created_at,id')
      .filter((row) => rank.has(row.character_id))
      .map(entry);
    return { order, entries };
  }
  forCharacter(characterId: string) {
    return this.store
      .all<Row>('SELECT * FROM web_cocreation_wordings WHERE character_id=? ORDER BY created_at,id', characterId)
      .map(entry);
  }
  private count(characterId: string, themeId: string) {
    return (
      this.store.get<{ n: number }>(
        'SELECT count(*) n FROM web_cocreation_wordings WHERE character_id=? AND theme_id=?',
        characterId,
        themeId,
      )?.n ?? 0
    );
  }
  private row(id: unknown) {
    ensure(identifierOk(id), 'INVALID_REQUEST');
    const row = this.store.get<Row>('SELECT * FROM web_cocreation_wordings WHERE id=?', id);
    ensure(row, 'NOT_FOUND');
    return row;
  }
  /** Add one wording. Idempotent per request id: the same content returns the same entry, other content is IDEMPOTENCY_CONFLICT. */
  add(input: { characterId: unknown; themeId: unknown; text: unknown; enabled: unknown; requestId: unknown }) {
    ensure(
      identifierOk(input.requestId) &&
        isThemeId(input.themeId) &&
        cocreationWordingOk(input.text) &&
        typeof input.enabled === 'boolean',
      'INVALID_REQUEST',
    );
    const themeId = input.themeId as CocreationThemeId,
      text = input.text as string,
      enabled = input.enabled as boolean,
      requestId = input.requestId as string;
    return this.store.transaction(() => {
      ensure(this.characterOk(input.characterId), 'NOT_FOUND');
      const characterId = input.characterId as string,
        hash = sha(['wording', characterId, themeId, text, enabled]);
      const prior = this.store.get<Row>('SELECT * FROM web_cocreation_wordings WHERE request_id=?', requestId);
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return entry(prior);
      }
      ensure(this.count(characterId, themeId) < COCREATION_WORDING_LIMITS.perTheme, 'COCREATION_WORDINGS_FULL');
      const now = this.now();
      const id = this.nextId();
      this.store.run(
        `INSERT INTO web_cocreation_wordings(id,character_id,theme_id,text,enabled,source,request_id,request_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,'manual',?,?,?,?)`,
        id,
        characterId,
        themeId,
        text,
        enabled ? 1 : 0,
        requestId,
        hash,
        now,
        now,
      );
      return entry(this.row(id));
    });
  }
  /** Replace the text (setting the same text again changes nothing). */
  edit(id: unknown, text: unknown) {
    ensure(cocreationWordingOk(text), 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const row = this.row(id);
      if (row.text !== text)
        this.store.run('UPDATE web_cocreation_wordings SET text=?,updated_at=? WHERE id=?', text, this.now(), row.id);
      return entry(this.row(row.id));
    });
  }
  setEnabled(id: unknown, enabled: unknown) {
    ensure(typeof enabled === 'boolean', 'INVALID_REQUEST');
    return this.store.transaction(() => {
      const row = this.row(id);
      if ((row.enabled === 1) !== enabled)
        this.store.run(
          'UPDATE web_cocreation_wordings SET enabled=?,updated_at=? WHERE id=?',
          enabled ? 1 : 0,
          this.now(),
          row.id,
        );
      return entry(this.row(row.id));
    });
  }
  /** Delete one wording; deleting what is already gone is the same answer. */
  remove(id: unknown) {
    ensure(identifierOk(id), 'INVALID_REQUEST');
    this.store.run('DELETE FROM web_cocreation_wordings WHERE id=?', id);
    return { id, deleted: true as const };
  }
  /** Land generated drafts: switched OFF, skipping what the character already has, within the cap. Returns how many were added. */
  landDrafts(characterId: string, requestId: string, drafts: WordingDrafts) {
    const now = this.now();
    let added = 0;
    for (const themeId of COCREATION_THEME_IDS) {
      const have = new Set(
        this.store
          .all<{ text: string }>(
            'SELECT text FROM web_cocreation_wordings WHERE character_id=? AND theme_id=?',
            characterId,
            themeId,
          )
          .map((row) => row.text),
      );
      let room = COCREATION_WORDING_LIMITS.perTheme - have.size;
      drafts[themeId].forEach((text, at) => {
        if (room <= 0 || have.has(text)) return;
        const id = this.nextId();
        this.store.run(
          `INSERT INTO web_cocreation_wordings(id,character_id,theme_id,text,enabled,source,request_id,request_hash,created_at,updated_at)
          VALUES (?,?,?,?,0,'generated',?,?,?,?)`,
          id,
          characterId,
          themeId,
          text,
          `${requestId}#${themeId}#${at}`,
          sha(['generated', characterId, themeId, text]),
          now,
          now,
        );
        have.add(text);
        room -= 1;
        added += 1;
      });
    }
    return added;
  }
}
