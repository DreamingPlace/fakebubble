import type { Clock } from '../../../packages/contracts/index.ts';
import { CAST_LIMITS, type CastDoc } from '../../../packages/contracts/web-cast.ts';
import { issueSentence } from '../../../packages/contracts/web-cast-text.ts';
import { DetailedError, DomainError, ensure } from '../../../packages/domain/errors.ts';
import { once, requestHash } from '../admin/web-admin-actions.ts';
import { castTablesExist, characterLookup, mergeCastDraft, newCharacterId, readDraft } from '../cast/cast-store.ts';
import {
  canonicalCastJson,
  normalizeCastDoc,
  castEntryIds,
  freshCastId,
  validateCastDoc,
} from '../cast/cast-validation.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { mergeCast, type CastChange, type CastSubject } from './profile-cast-merge.ts';
import { mergeProfile, show, type Change } from './profile-merge.ts';
import {
  CODE_PATTERN,
  PROFILE_LIMITS,
  readTemplateFile,
  type ProfileProblem,
  type ReadProfile,
} from './profile-template.ts';
import type { WebCharacterProfile } from './web-character-catalog.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import {
  allCodes,
  checklistOf,
  codeOf,
  installProfileImport,
  profileImportInstalled,
  type CodeRow,
} from './web-profile-schema.ts';

/**
 * Part 24j: 导入角色资料. Preview and import share ONE planner, so what the preview shows is what the import does. The preview writes
 * nothing; the import is a single transaction (a draft revision per character, the code bindings, the checklist rows and the merge
 * into the cast draft) and never publishes, never touches catalog positions, voice approvals, materials, players or chats.
 */
export interface ProfileHooks {
  /** Every character with a draft or a live version: id, current 人设名称, revisions. */
  characters(): { id: string; name: string; draftRevision: number | null; liveVersion: number | null }[];
  /** The profile an edit would start from (the draft, else the live version with the next version number), or null. */
  base(id: string): WebCharacterProfile | null;
  /** The same validation a draft save runs; throws a DomainError. */
  normalize(profile: WebCharacterProfile): WebCharacterProfile;
  /** Writes one draft revision of an existing character; null when it would be byte-identical to the current one. */
  write(actor: Actor, id: string, next: WebCharacterProfile, now: number): number | null;
  /** The first draft of a brand-new character. */
  create(actor: Actor, next: WebCharacterProfile, now: number): void;
}
export type Actor = { memberId: string; sessionId: string };
export interface ImportContext {
  actor: Actor;
  mayCreate: boolean;
  mayEdit: (characterId: string) => boolean;
  mayCast: boolean;
}
type InFile = { name: string; text: string };
interface Planned {
  file: string;
  code: string;
  mode: 'new' | 'existing' | 'bind';
  characterId: string;
  read: ReadProfile;
  base: WebCharacterProfile | null;
  next: WebCharacterProfile;
  changes: Change[];
  castChanges: CastChange[];
  checklist: { key: string; text: string }[];
  draftRevision: number | null;
  liveVersion: number | null;
  codeRow: CodeRow | null;
  /** What the code row would say after the import (avatar file, voice id). */
  meta: { avatar: string | null; voice: string | null };
  checklistChanged: boolean;
}
export interface Basis {
  cast: number | null;
  characters: { code: string; id: string | null; draftRevision: number | null; liveVersion: number | null }[];
}

const files = (input: unknown): InFile[] => {
  ensure(Array.isArray(input) && input.length >= 1 && input.length <= PROFILE_LIMITS.files, 'INVALID_REQUEST');
  const names = new Set<string>();
  return input.map((item) => {
    ensure(item !== null && typeof item === 'object' && !Array.isArray(item), 'INVALID_REQUEST');
    const { name, text, ...extra } = item as Record<string, unknown>;
    ensure(
      Object.keys(extra).length === 0 &&
        typeof name === 'string' &&
        name.length >= 1 &&
        name.length <= 120 &&
        !/[\u0000-\u001f\u007f]/.test(name) &&
        typeof text === 'string' &&
        text.length <= PROFILE_LIMITS.fileChars + 1,
      'INVALID_REQUEST',
    );
    ensure(!names.has(name), 'INVALID_REQUEST');
    names.add(name);
    return { name, text };
  });
};

export class WebProfileImport {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly hooks: ProfileHooks;
  constructor(store: BusinessStore, clock: Clock, hooks: ProfileHooks) {
    this.store = store;
    this.clock = clock;
    this.hooks = hooks;
    installProfileImport(store);
  }

  /** ---- the planner (reads only) ---- */
  private plan(inputs: InFile[], ctx: ImportContext) {
    const problems: ProfileProblem[] = [];
    const warnings: ProfileProblem[] = [];
    const reads: ReadProfile[] = [];
    for (const file of inputs) {
      const { profile, problems: found } = readTemplateFile(file.name, file.text);
      problems.push(...found);
      if (profile) reads.push(profile);
    }
    // The same code in two files.
    const seen = new Map<string, ReadProfile>();
    for (const read of reads) {
      const first = seen.get(read.code.toLowerCase());
      if (first)
        problems.push({
          code: 'PROFILE_CODE_DUPLICATE',
          file: read.file,
          section: '1 基本信息',
          field: '角色代码',
          item: null,
          text: `和文件 ${first.file} 的角色代码相同`,
        });
      else seen.set(read.code.toLowerCase(), read);
    }
    const known = this.hooks.characters();
    const codes = allCodes(this.store);
    const byCode = new Map(codes.map((row) => [row.code_key, row]));
    const withCode = new Set(codes.map((row) => row.character_id));
    const claimed = new Map<string, ReadProfile>();
    const planned: Planned[] = [];
    const taken = new Set<string>();
    const castOn = castTablesExist(this.store);
    const draft = castOn ? readDraft(this.store) : null;

    for (const read of reads) {
      const at = (code: string, text: string, field: string | null = '角色代码') =>
        problems.push({ code, file: read.file, section: '1 基本信息', field, item: null, text });
      let mode: Planned['mode'] = 'new';
      let id = '';
      const row = byCode.get(read.code.toLowerCase());
      if (row) {
        mode = 'existing';
        id = row.character_id;
      } else {
        const same = known.filter((c) => !withCode.has(c.id) && c.name === read.name);
        if (same.length > 1)
          at(
            'PROFILE_NAME_AMBIGUOUS',
            `有 ${same.length} 个还没有代码的角色叫「${read.name}」，无法判断绑定哪一个`,
            '人设名称',
          );
        else if (same.length === 1) {
          const other = claimed.get(same[0]!.id);
          if (other) at('PROFILE_NAME_AMBIGUOUS', `角色「${read.name}」已被文件 ${other.file} 绑定`, '人设名称');
          else {
            claimed.set(same[0]!.id, read);
            mode = 'bind';
            id = same[0]!.id;
          }
        }
      }
      if (mode === 'new') {
        id = newCharacterId(this.store, taken);
      } else if (webCharacterDeleted(this.store, id)) {
        at('PROFILE_CHARACTER_DELETED', '这个角色已被删除', '角色代码');
        continue;
      }
      const info = known.find((c) => c.id === id);
      const base = mode === 'new' ? null : this.hooks.base(id);
      if (mode !== 'new' && !base) {
        at('PROFILE_CHARACTER_UNREADABLE', '找不到这个角色的资料');
        continue;
      }
      if (mode === 'new' ? !ctx.mayCreate : !ctx.mayEdit(id))
        at('ADMIN_PERMISSION_REQUIRED', mode === 'new' ? '没有新建角色的权限' : '没有编辑这个角色的权限', null);
      const merged = mergeProfile(id, base, read);
      problems.push(...merged.problems);
      let next = merged.next;
      try {
        next = this.hooks.normalize(merged.next);
      } catch (error) {
        if (!merged.problems.length) {
          const code = error instanceof DomainError ? error.code : 'PROFILE_INVALID';
          at('PROFILE_INVALID', `资料没有通过工作台的校验（${code}）`, null);
        }
      }
      const metaBefore = row ?? null;
      const meta = {
        avatar: read.avatarFile !== '' ? read.avatarFile : (metaBefore?.avatar_file ?? null),
        voice: read.voiceId !== '' ? read.voiceId : (metaBefore?.voice_reference_id ?? null),
      };
      const changes = [...merged.changes];
      if (mode !== 'existing') changes.unshift({ field: '角色代码', old: '', new: read.code });
      if (read.avatarFile !== '' && meta.avatar !== (metaBefore?.avatar_file ?? null))
        changes.push({ field: '头像文件', old: show(metaBefore?.avatar_file), new: read.avatarFile });
      if (read.voiceId !== '' && meta.voice !== (metaBefore?.voice_reference_id ?? null))
        changes.push({
          field: '音色模型 ID（声音页预填）',
          old: show(metaBefore?.voice_reference_id),
          new: read.voiceId,
        });
      const before = mode === 'new' ? [] : checklistOf(this.store, id);
      const checklistChanged =
        before.map((c) => c.key).join('\n') !== read.checklist.map((c) => c.key).join('\n') ||
        before.some((c, i) => c.text !== read.checklist[i]?.text);
      planned.push({
        file: read.file,
        code: row?.code ?? read.code,
        mode,
        characterId: id,
        read,
        base,
        next,
        changes,
        castChanges: [],
        checklist: read.checklist,
        draftRevision: info?.draftRevision ?? null,
        liveVersion: info?.liveVersion ?? null,
        codeRow: row ?? null,
        meta,
        checklistChanged,
      });
    }

    // ---- the cast draft (merged) ----
    let castDoc: CastDoc | null = null;
    let castChanges: CastChange[] = [];
    let castChanged = false;
    if (!castOn) {
      if (planned.length)
        warnings.push({
          code: 'PROFILE_CAST_UNAVAILABLE',
          file: planned[0]!.file,
          section: null,
          field: null,
          item: null,
          text: '此环境没有关系与故事，名片和关系没有写入',
        });
    } else if (planned.length && problems.length === 0) {
      if (!ctx.mayCast)
        for (const p of planned)
          problems.push({
            code: 'ADMIN_PERMISSION_REQUIRED',
            file: p.file,
            section: null,
            field: null,
            item: null,
            text: '没有编辑关系与故事（cast.edit）的权限',
          });
      const subjects: CastSubject[] = planned.map((p) => ({ characterId: p.characterId, read: p.read }));
      const codeMap = new Map(codes.map((row) => [row.code_key, row.character_id]));
      const merged = mergeCast(draft!.doc, subjects, codeMap);
      problems.push(...merged.problems);
      warnings.push(...merged.warnings);
      castChanges = merged.changes;
      if (merged.doc.characters.length > CAST_LIMITS.chatCharacters)
        problems.push({
          code: 'PROFILE_CAST_FULL',
          file: planned[0]!.file,
          section: '关系与故事',
          field: null,
          item: null,
          text: `关系与故事最多 ${CAST_LIMITS.chatCharacters} 个聊天角色，这次导入会超出（${merged.doc.characters.length}）`,
        });
      else
        try {
          const normalized = normalizeCastDoc(merged.doc, { known: castEntryIds(draft!.doc), fresh: freshCastId });
          const lookup = characterLookup(this.store);
          const newIds = new Set(planned.filter((p) => p.mode === 'new').map((p) => p.characterId));
          const validation = validateCastDoc(normalized, 'draft', {
            exists: (id) => newIds.has(id) || lookup.exists(id),
            deleted: lookup.deleted,
          });
          for (const issue of validation.errors)
            problems.push({
              code: 'PROFILE_CAST_INVALID',
              file: planned[0]!.file,
              section: '关系与故事',
              field: null,
              item: null,
              text: issueSentence(normalized, issue.code, issue.path).text,
            });
          castChanged = canonicalCastJson(normalized) !== canonicalCastJson(draft!.doc);
          castDoc = normalized;
        } catch (error) {
          const detail =
            error instanceof DetailedError
              ? (error.detail.issues as { code: string; path: string }[] | undefined)
              : undefined;
          problems.push({
            code: 'PROFILE_CAST_INVALID',
            file: planned[0]!.file,
            section: '关系与故事',
            field: null,
            item: null,
            text: detail?.[0]
              ? issueSentence(draft!.doc, detail[0].code, detail[0].path).text
              : '合并后的关系与故事不符合要求',
          });
        }
      for (const p of planned) p.castChanges = castChanges.filter((c) => c.who === p.read.name);
    }
    const basis: Basis = {
      cast: draft?.revision ?? null,
      characters: planned
        .map((p) => ({
          code: p.read.code.toLowerCase(),
          id: p.mode === 'new' ? null : p.characterId,
          draftRevision: p.draftRevision,
          liveVersion: p.liveVersion,
        }))
        .sort((a, b) => (a.code < b.code ? -1 : 1)),
    };
    return { problems, warnings, planned, basis, castDoc, castChanges, castChanged, codes };
  }

  /** Reads the permission gate first; the caller has already refused a session that can do none of these. */
  preview(ctx: ImportContext, input: unknown) {
    const body = input as { files?: unknown };
    ensure(body !== null && typeof body === 'object' && Object.keys(body).join() === 'files', 'INVALID_REQUEST');
    const plan = this.plan(files(body.files), ctx);
    const unchanged =
      plan.problems.length === 0 &&
      plan.planned.every((p) => p.mode === 'existing' && p.changes.length === 0 && !p.checklistChanged) &&
      !plan.castChanged;
    return {
      ok: plan.problems.length === 0,
      unchanged,
      basis: plan.basis,
      characters: plan.planned.map((p) => ({
        file: p.file,
        code: p.code,
        mode: p.mode,
        name: p.read.name,
        changes: p.changes,
        castChanges: p.castChanges.map(({ who: _who, ...rest }) => rest),
        checklist: p.checklist,
        unchanged: p.mode === 'existing' && p.changes.length === 0 && !p.checklistChanged && p.castChanges.length === 0,
      })),
      castChangeCount: plan.castChanges.length,
      problems: plan.problems,
      warnings: plan.warnings,
    };
  }

  /** The import: ONE transaction, idempotent per request id, optimistic on the previewed revisions. */
  apply(ctx: ImportContext, input: unknown) {
    const body = input as Record<string, unknown>;
    ensure(
      body !== null && typeof body === 'object' && Object.keys(body).sort().join() === 'basis,files,requestId',
      'INVALID_REQUEST',
    );
    const list = files(body.files);
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return once(
      this.store,
      now,
      {
        requestId: body.requestId,
        action: 'profile-import',
        hash: requestHash({ files: list, basis: body.basis }),
        adminId: ctx.actor.memberId,
      },
      () => {
        const plan = this.plan(list, ctx);
        if (plan.problems.length) throw new DetailedError('PROFILE_IMPORT_INVALID', { problems: plan.problems });
        // Someone edited a draft (or the cast) since the preview: nothing is written; preview again.
        if (JSON.stringify(plan.basis) !== JSON.stringify(body.basis)) throw new DomainError('PROFILE_IMPORT_CONFLICT');
        const results: { code: string; mode: Planned['mode']; changed: boolean; revision: number | null }[] = [];
        for (const p of plan.planned) {
          let revision: number | null = null;
          if (p.mode === 'new') {
            this.hooks.create(ctx.actor, p.next, now);
            revision = 1;
          } else if (p.changes.some((c) => !['角色代码', '头像文件', '音色模型 ID（声音页预填）'].includes(c.field)))
            revision = this.hooks.write(ctx.actor, p.characterId, p.next, now);
          if (p.mode !== 'existing') {
            this.store.run(
              'INSERT INTO web_profile_codes(character_id,code,code_key,avatar_file,voice_reference_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
              p.characterId,
              p.read.code,
              p.read.code.toLowerCase(),
              p.meta.avatar,
              p.meta.voice,
              now,
              now,
            );
          } else if (p.meta.avatar !== p.codeRow?.avatar_file || p.meta.voice !== p.codeRow?.voice_reference_id)
            this.store.run(
              'UPDATE web_profile_codes SET avatar_file=?,voice_reference_id=?,updated_at=? WHERE character_id=?',
              p.meta.avatar,
              p.meta.voice,
              now,
              p.characterId,
            );
          if (p.mode === 'new' || p.checklistChanged) this.syncChecklist(p.characterId, p.checklist, now);
          results.push({ code: p.code, mode: p.mode, changed: p.changes.length > 0 || p.checklistChanged, revision });
        }
        let castRevision: number | null = null;
        if (plan.castChanged && plan.basis.cast !== null) {
          const subjects: CastSubject[] = plan.planned.map((p) => ({ characterId: p.characterId, read: p.read }));
          const codeMap = new Map(allCodes(this.store).map((row) => [row.code_key, row.character_id]));
          const saved = mergeCastDraft(
            this.store,
            now,
            plan.basis.cast,
            (doc) => mergeCast(doc, subjects, codeMap).doc,
          );
          castRevision = saved?.revision ?? null;
        }
        this.store.run(
          'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
          ctx.actor.memberId,
          results.every((r) => !r.changed) && castRevision === null ? 'profile-import-unchanged' : 'profile-imported',
          `files=${list.length};new=${results.filter((r) => r.mode === 'new').length};bound=${results.filter((r) => r.mode === 'bind').length}`,
          now,
        );
        return {
          unchanged: results.every((r) => !r.changed) && castRevision === null,
          characters: results,
          castRevision,
        };
      },
    );
  }

  private syncChecklist(characterId: string, items: { key: string; text: string }[], now: number) {
    const before = new Map(checklistOf(this.store, characterId).map((row) => [row.key, row]));
    for (const row of before.values())
      if (!items.some((i) => i.key === row.key))
        this.store.run('DELETE FROM web_profile_checklist WHERE character_id=? AND item_key=?', characterId, row.key);
    for (const item of items) {
      const had = before.get(item.key);
      if (!had)
        this.store.run(
          "INSERT INTO web_profile_checklist(character_id,item_key,item_text,state,created_at) VALUES (?,?,?,'open',?)",
          characterId,
          item.key,
          item.text,
          now,
        );
      else if (had.text !== item.text)
        this.store.run(
          'UPDATE web_profile_checklist SET item_text=? WHERE character_id=? AND item_key=?',
          item.text,
          characterId,
          item.key,
        );
    }
  }

  // ---- the small per-character calls of 身份与展示 ----
  meta(characterId: string) {
    const row = codeOf(this.store, characterId);
    return {
      available: true as const,
      code: row?.code ?? null,
      avatarFile: row?.avatar_file ?? null,
      voiceReferenceId: row?.voice_reference_id ?? null,
      checklist: checklistOf(this.store, characterId),
    };
  }
  /** Set or change the 角色代码 by hand (character edit). Unique case-insensitively; no other character's code is read out. */
  saveCode(characterId: string, input: unknown) {
    const body = input as Record<string, unknown>;
    ensure(body !== null && typeof body === 'object' && Object.keys(body).join() === 'code', 'INVALID_REQUEST');
    ensure(typeof body.code === 'string' && CODE_PATTERN.test(body.code), 'INVALID_PROFILE_CODE');
    const code = body.code;
    const now = this.clock.now();
    return this.store.transaction(() => {
      ensure(!webCharacterDeleted(this.store, characterId), 'CHARACTER_DELETED');
      ensure(
        this.hooks.characters().some((c) => c.id === characterId),
        'NOT_FOUND',
      );
      const clash = this.store.get<{ character_id: string }>(
        'SELECT character_id FROM web_profile_codes WHERE code_key=?',
        code.toLowerCase(),
      );
      ensure(!clash || clash.character_id === characterId, 'PROFILE_CODE_TAKEN');
      this.store.run(
        `INSERT INTO web_profile_codes(character_id,code,code_key,avatar_file,voice_reference_id,created_at,updated_at)
         VALUES (?,?,?,NULL,NULL,?,?)
         ON CONFLICT(character_id) DO UPDATE SET code=excluded.code,code_key=excluded.code_key,updated_at=excluded.updated_at`,
        characterId,
        code,
        code.toLowerCase(),
        now,
        now,
      );
      return this.meta(characterId);
    });
  }
  dismiss(characterId: string, input: unknown) {
    const body = input as Record<string, unknown>;
    ensure(body !== null && typeof body === 'object' && Object.keys(body).join() === 'key', 'INVALID_REQUEST');
    ensure(typeof body.key === 'string' && body.key.length >= 1 && body.key.length <= 200, 'INVALID_REQUEST');
    ensure(profileImportInstalled(this.store), 'NOT_FOUND');
    const changed = this.store.run(
      "UPDATE web_profile_checklist SET state='dismissed' WHERE character_id=? AND item_key=?",
      characterId,
      body.key,
    );
    ensure(changed.changes === 1, 'NOT_FOUND');
    return this.meta(characterId);
  }
}
