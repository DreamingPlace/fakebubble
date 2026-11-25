import { COCREATION_FIELD_LABELS, cocreationCard } from '../../../packages/contracts/cocreation-cards.ts';
import { hasCocreationPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import { utc8Time } from '../export/web-export-conversations.ts';
import type { Cell, Sheet } from '../export/web-export-file.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { characterFacts, nicknamesOfWorld, redactNicknames } from '../review/web-chat-review.ts';
import { cocreationTablesExist } from './web-cocreation-purge.ts';
import { relationTablesExist } from './web-cocreation-relations-schema.ts';
import { wordingTablesExist } from './web-cocreation-wordings-schema.ts';

/**
 * Part 57: 共创收件箱 as a table, one row per answer of a note. The player is the inbox's own anonymous code (玩家#xxxx, a keyed hash
 * of the principal): no id, no email, no nickname, no invite code, no IP. The administrators' private note text is not exported.
 */
type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
const STATUS = { new: '新', processed: '已处理', archived: '已归档' } as const;
const KIND = { character: '角色', memo: '备忘', pair: '关系' } as const;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export const COCREATION_HEADER = [
  '时间（UTC+8）',
  '玩家代号',
  '类型',
  '角色',
  '关系中的其他角色',
  '卡片',
  '题目 / 措辞',
  '内容',
  '状态',
  '星标',
  '是否采纳',
  '采纳时间（UTC+8）',
  '积分（已发放）',
] as const;

export function cocreationSheets(
  store: BusinessStore,
  admin: WebAccountAdmin,
  pseudonym: (principalId: string) => string,
  auth: Auth,
  filters: Record<string, unknown>,
): Sheet[] {
  ensure(cocreationTablesExist(store), 'COCREATION_UNAVAILABLE');
  const actor = admin.authorize(auth.cookie, auth.csrf, auth.origin),
    member = admin.session(auth.cookie).member;
  ensure(
    actor.role === 'owner' || hasCocreationPermission(member.permissions, 'cocreation.read'),
    'ADMIN_PERMISSION_REQUIRED',
  );
  const { characterId = null, status = null, starred = null, query = null } = filters;
  ensure(characterId === null || id(characterId), 'INVALID_REQUEST');
  ensure(status === null || (typeof status === 'string' && status in STATUS), 'INVALID_REQUEST');
  ensure(starred === null || starred === true, 'INVALID_REQUEST');
  ensure(
    query === null || (typeof query === 'string' && query.trim() !== '' && [...query].length <= 100),
    'INVALID_REQUEST',
  );

  const kinds = !!store.get("SELECT 1 FROM pragma_table_info('web_cocreation_submissions') WHERE name='kind'");
  const where: string[] = [],
    args: (string | number)[] = [];
  if (characterId !== null) {
    const members = relationTablesExist(store);
    where.push(
      kinds
        ? members
          ? '(s.character_id=? OR s.partner_id=? OR EXISTS (SELECT 1 FROM web_cocreation_members m WHERE m.submission_id=s.id AND m.character_id=?))'
          : '(s.character_id=? OR s.partner_id=?)'
        : 's.character_id=?',
    );
    args.push(characterId as string);
    if (kinds) args.push(characterId as string);
    if (kinds && members) args.push(characterId as string);
  }
  if (status !== null) {
    where.push('s.status=?');
    args.push(status as string);
  }
  if (starred === true) where.push('s.starred=1');
  if (query !== null) {
    const like = `%${(query as string).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`EXISTS (SELECT 1 FROM web_cocreation_answers a WHERE a.submission_id=s.id AND (CASE a.kind WHEN 'text'
      THEN json_extract(a.text_json,'$') ELSE json_extract(a.text_json,'$.player')||' '||json_extract(a.text_json,'$.replies') END) LIKE ? ESCAPE '\\')`);
    args.push(like);
  }
  const wordings = wordingTablesExist(store);
  const paid = !!store.get("SELECT 1 FROM pragma_table_info('web_cocreation_answers') WHERE name='paid_points'");
  const rows = store.all<{
    created_at: number;
    principal_id: string;
    world_id: string | null;
    character_id: string;
    status: keyof typeof STATUS;
    starred: number;
    kind: keyof typeof KIND | null;
    partner_id: string | null;
    card_id: string;
    target_field: keyof typeof COCREATION_FIELD_LABELS;
    answer_kind: 'text' | 'dialogue';
    text_json: string;
    adopted_at: number | null;
    wording: string | null;
    paid_points: number;
  }>(
    `SELECT s.created_at,s.principal_id,(SELECT p.world_id FROM web_principals p WHERE p.id=s.principal_id) world_id,s.character_id,s.status,s.starred,${kinds ? 's.kind,s.partner_id' : 'NULL kind,NULL partner_id'},
      a.card_id,a.target_field,a.kind answer_kind,a.text_json,a.adopted_at,
      ${wordings ? 'w.wording' : 'NULL'} wording,${paid ? 'a.paid_points' : '0'} paid_points
    FROM web_cocreation_submissions s JOIN web_cocreation_answers a ON a.submission_id=s.id
    ${wordings ? 'LEFT JOIN web_cocreation_answer_wordings w ON w.submission_id=a.submission_id AND w.ordinal=a.ordinal' : ''}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.created_at DESC,s.id DESC,a.ordinal`,
    ...args,
  );
  const names = new Map<string, string>();
  const nameOf = (characterIdValue: string | null) => {
    if (!characterIdValue) return '';
    let name = names.get(characterIdValue);
    if (name === undefined) names.set(characterIdValue, (name = characterFacts(store, characterIdValue).label));
    return name;
  };
  // The player's own names (current and past) are replaced, as on the review page.
  const nicknames = new Map<string, string[]>();
  const namesOf = (worldId: string | null) => {
    if (worldId === null) return [];
    let names = nicknames.get(worldId);
    if (!names) nicknames.set(worldId, (names = nicknamesOfWorld(store, worldId)));
    return names;
  };
  const out: Cell[][] = rows.map((row) => {
    let text = '';
    try {
      const value = JSON.parse(row.text_json) as string | { player: string; replies: string[] };
      text = typeof value === 'string' ? value : `${value.player}\n${value.replies.join('\n')}`;
    } catch {
      // an answer that is not JSON has no text to show
    }
    const card = cocreationCard(row.card_id);
    return [
      utc8Time(row.created_at),
      pseudonym(row.principal_id),
      KIND[row.kind ?? 'character'],
      nameOf(row.character_id),
      nameOf(row.partner_id),
      card ? card.prompt.replaceAll('{name}', nameOf(row.character_id)) : COCREATION_FIELD_LABELS[row.target_field],
      row.wording ?? '',
      redactNicknames(text, namesOf(row.world_id)),
      STATUS[row.status],
      row.starred === 1 ? '是' : '否',
      row.adopted_at === null ? '否' : '是',
      row.adopted_at === null ? '' : utc8Time(row.adopted_at),
      row.paid_points,
    ];
  });
  return [{ name: '共创收件箱', header: COCREATION_HEADER, rows: out }];
}
