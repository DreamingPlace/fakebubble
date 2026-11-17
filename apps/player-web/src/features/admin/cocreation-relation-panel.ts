/**
 * Part 39: the inbox detail of a relation note (two to eight characters). Members in the console's order, a pair's two ratings and its
 * reason, the story as an edit box, and the four actions: 整理 (optional, one paid call that only fills the box), 采纳 (writes the
 * STORY into the cast 草稿; never the ratings grid, never published), 不采纳, 不计入. Every player string goes through textContent.
 */
import {
  RELATION_ADOPT_ERROR_TEXT,
  RELATION_STAR_LABELS,
  RELATION_TEXT_MAX,
} from '../../../../../packages/contracts/cocreation-relations.ts';
import { CAST_LIMITS } from '../../../../../packages/contracts/web-cast.ts';
import type { CocreationRelationsClient, RelationDetail } from '../../services/cocreation-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { dot } from './cast/cast-ui.ts';
import { sentenceOf } from './ui/error-line.ts';
import { growBox } from './ui/grow-box.ts';
import { hoverValue } from './ui/hover-value.ts';
import { paidButton } from './ui/paid-button.ts';
import { statusBadge } from './ui/status-badge.ts';

export type RelationPanelDeps = {
  api: Pick<CocreationRelationsClient, 'adopt' | 'reject' | 'exclude' | 'tidy'>;
  nameOf: (id: string) => string;
  colour: (id: string) => string;
  canManage: () => boolean;
  canEditCast: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  /** The note changed (decision / 不计入): the list card follows. */
  changed: (patch: { decision?: 'adopted' | 'rejected' | null; excluded?: boolean }) => void;
  newId: () => string;
};

const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
const starRow = (stars: number) => `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`;

export function relationPanel(initial: RelationDetail, deps: RelationPanelDeps): HTMLElement {
  let detail = initial;
  const manage = deps.canManage();
  const mayAdopt = manage && deps.canEditCast();
  let busy = false;
  const root = h('section', { class: 'cr-panel', attrs: { 'data-relation': detail.id } });

  // ---- members -------------------------------------------------------------------------------------------------------
  const members = h(
    'div',
    { class: 'cr-members', attrs: { role: 'list', 'aria-label': '角色' } },
    ...detail.members.map((id) =>
      h(
        'span',
        { class: 'cr-member', attrs: { role: 'listitem' } },
        dot(deps.colour(id), 8),
        h('b', { text: deps.nameOf(id) }),
      ),
    ),
  );

  // ---- a pair's ratings and reason -----------------------------------------------------------------------------------
  const ratings = detail.ratings.length
    ? h(
        'div',
        { class: 'cr-ratings', attrs: { 'data-ratings': '' } },
        ...detail.ratings.map((r) =>
          h(
            'p',
            {
              class: 'cr-rating',
              attrs: {
                'aria-label': `${deps.nameOf(r.from)} 对 ${deps.nameOf(r.to)}：${r.stars} 星，${RELATION_STAR_LABELS[r.stars]}`,
              },
            },
            h('span', { class: 'cr-rating-who', text: `${deps.nameOf(r.from)} 对 ${deps.nameOf(r.to)}` }),
            h('span', { class: 'cr-stars', text: starRow(r.stars), attrs: { 'aria-hidden': 'true' } }),
            h('b', { class: 'cr-stars-n is-mono', text: `${r.stars}` }),
            h('span', { class: 'cr-stars-word', text: RELATION_STAR_LABELS[r.stars] ?? '' }),
          ),
        ),
      )
    : null;
  const reason = detail.reason
    ? h('div', { class: 'cr-reason' }, h('span', { class: 'cr-label', text: '理由' }), h('p', { text: detail.reason }))
    : null;

  // ---- the story box ---------------------------------------------------------------------------------------------------
  const box = h('textarea', { class: 'cr-story', attrs: { 'aria-label': '故事', 'data-story': '' } });
  box.value = detail.text;
  growBox(box, 'para', { multiline: true });
  const counter = h('span', { class: 'cr-count is-mono' });
  const flagsHost = h('ul', { class: 'cr-flags', hidden: true, attrs: { 'aria-label': '整理提示' } });
  const error = h('p', { class: 'cr-error', attrs: { role: 'alert' }, hidden: true });
  const showError = (code: string) => {
    error.textContent = RELATION_ADOPT_ERROR_TEXT[code] ?? sentenceOf(code);
    error.hidden = false;
  };
  const length = () => [...box.value].length;
  const limitLine = h('p', { class: 'cr-limit', attrs: { role: 'status' }, hidden: true });

  // ---- the group: join, or create with a name ---------------------------------------------------------------------------
  const match = detail.match;
  const name = h('input', { class: 'cr-name', attrs: { type: 'text', 'aria-label': '组合名', 'data-group-name': '' } });
  name.value = match?.kind === 'new' ? match.suggestedName : '';
  const joinChip = h('span', {
    class: `cr-join${match?.kind === 'join' ? '' : ' is-new'}`,
    text: match?.kind === 'join' ? `加入：${match.name}` : '新建组合',
    attrs: { 'data-match': match?.kind === 'join' ? 'join' : 'new', tabindex: '0' },
  });
  const matchLine = h('div', { class: 'cr-match' }, joinChip, match?.kind === 'new' ? name : null);
  if (match?.kind === 'join')
    hoverValue(joinChip, `${match.inDraft ? '草稿' : '正式版本'}里已有这个组合，现有 ${match.stories} 条故事`);
  if (match?.kind === 'new')
    hoverValue(name, detail.members.length === 2 ? '两位的组合默认叫「A与B」，可以改' : '新组合的名字，1–30 个字');

  // ---- actions ----------------------------------------------------------------------------------------------------------
  const adopt = h('button', { class: 'cr-adopt', text: '采纳', attrs: { type: 'button' } });
  const reject = h('button', { class: 'cr-reject', text: '不采纳', attrs: { type: 'button' } });
  const exclude = h('button', {
    class: 'cr-exclude',
    text: detail.excluded ? '计入' : '不计入',
    attrs: { type: 'button', 'aria-pressed': String(detail.excluded) },
  });
  hoverValue(reject, '只是不采纳这条故事；玩家给的星级仍然计入统计');
  const excludeTip = hoverValue(exclude, '');
  const tipOf = () =>
    hoverValue(
      excludeTip,
      detail.excluded
        ? '让这条的星级重新计入「玩家眼中的关系」'
        : '这条的星级不再计入「玩家眼中的关系」（垃圾投稿）；故事不受影响',
    );
  tipOf();
  const adoptNote = h('span', {
    class: 'cr-adopt-note',
    text: '写进世界设定草稿，发布前玩家看不到。采纳后给玩家发的共创积分不收回。',
  });

  const paint = () => {
    const over = length() > CAST_LIMITS.storySummary;
    counter.textContent = `${length()}/${RELATION_TEXT_MAX}`;
    counter.dataset.over = String(over);
    const blocked = detail.blocked;
    const nameBad =
      match?.kind === 'new' &&
      (name.value.length < 1 || name.value.length > CAST_LIMITS.groupName || /[\r\n]/.test(name.value));
    const why = !mayAdopt
      ? '没有采纳的权限'
      : blocked
        ? (RELATION_ADOPT_ERROR_TEXT[blocked] ?? '')
        : over
          ? (RELATION_ADOPT_ERROR_TEXT.COCREATION_STORY_TOO_LONG ?? '')
          : box.value.trim() === ''
            ? (RELATION_ADOPT_ERROR_TEXT.COCREATION_TEXT_INVALID ?? '')
            : nameBad
              ? (RELATION_ADOPT_ERROR_TEXT.COCREATION_GROUP_NAME_INVALID ?? '')
              : detail.decision === 'adopted'
                ? '已经采纳'
                : '';
    adopt.disabled = busy || why !== '';
    adopt.dataset.locked = String(adopt.disabled);
    limitLine.textContent = blocked ? (RELATION_ADOPT_ERROR_TEXT[blocked] ?? '') : '';
    limitLine.hidden = !blocked;
    reject.disabled = busy || !manage || detail.decision === 'adopted';
    reject.dataset.locked = String(reject.disabled);
    exclude.disabled = busy || !manage;
    exclude.dataset.locked = String(exclude.disabled);
  };

  const tidy = paidButton({
    name: 'cocreation-tidy',
    label: () => '整理 · 1 次付费调用',
    confirmLabel: () => '确认付费 · 1 次',
    reason: () => (!manage ? '没有处理共创的权限' : busy ? '正在处理…' : ''),
    onConfirm: () => {
      void deps.run(async () => {
        error.hidden = true;
        busy = true;
        tidy.refresh();
        paint();
        try {
          const result = await deps.api.tidy(detail.id, deps.newId());
          box.value = result.story;
          box.dispatchEvent(new Event('input'));
          flagsHost.replaceChildren(...result.flags.map((flag) => h('li', { text: flag })));
          flagsHost.hidden = result.flags.length === 0;
          deps.status(result.flags.length ? '整理好了，请看提示。尚未采纳。' : '整理好了。尚未采纳。');
        } catch (caught) {
          showError(codeOf(caught));
        } finally {
          busy = false;
          tidy.refresh();
          paint();
        }
      });
    },
  });
  hoverValue(
    tidy.button,
    '用草稿模型把这条整理成一条故事，并提示像不像玩家个人内容、有没有和已有设定冲突。只填入下面的框，不会采纳。',
  );

  box.addEventListener('input', () => {
    error.hidden = true;
    paint();
  });
  name.addEventListener('input', () => {
    error.hidden = true;
    paint();
  });

  adopt.addEventListener('click', () => {
    if (adopt.disabled || detail.castRevision === null) return;
    void deps.run(async () => {
      busy = true;
      paint();
      error.hidden = true;
      try {
        const done = await deps.api.adopt({
          id: detail.id,
          requestId: deps.newId(),
          expectedRevision: detail.castRevision!,
          text: box.value,
          groupName: match?.kind === 'new' ? name.value : null,
        });
        detail = { ...detail, decision: 'adopted', text: box.value };
        decidedHost.replaceChildren(...decidedNodes());
        deps.changed({ decision: 'adopted' });
        deps.status(
          `${done.joined ? '已加入组合' : '已新建组合'}，写进世界设定草稿 ${done.castRevision}。尚未发布：请到「关系与故事」确认后发布。`,
        );
      } catch (caught) {
        showError(codeOf(caught));
      } finally {
        busy = false;
        paint();
      }
    });
  });
  reject.addEventListener('click', () => {
    if (reject.disabled) return;
    void deps.run(async () => {
      busy = true;
      paint();
      try {
        await deps.api.reject(detail.id);
        detail = { ...detail, decision: 'rejected' };
        decidedHost.replaceChildren(...decidedNodes());
        deps.changed({ decision: 'rejected' });
        deps.status('已标为不采纳，并归档。');
      } catch (caught) {
        showError(codeOf(caught));
      } finally {
        busy = false;
        paint();
      }
    });
  });
  exclude.addEventListener('click', () => {
    if (exclude.disabled) return;
    void deps.run(async () => {
      busy = true;
      paint();
      try {
        const next = !detail.excluded;
        await deps.api.exclude(detail.id, next);
        detail = { ...detail, excluded: next };
        exclude.firstChild!.textContent = next ? '计入' : '不计入';
        exclude.setAttribute('aria-pressed', String(next));
        tipOf();
        deps.changed({ excluded: next });
        deps.status(next ? '这条的星级已不计入统计。' : '这条的星级重新计入统计。');
      } catch (caught) {
        showError(codeOf(caught));
      } finally {
        busy = false;
        paint();
      }
    });
  });

  const decidedNodes = (): Node[] =>
    detail.decision === 'adopted'
      ? [statusBadge('已采纳', 'ok'), h('a', { class: 'cc-go', text: '去关系与故事发布 →', attrs: { href: '#/cast' } })]
      : detail.decision === 'rejected'
        ? [statusBadge('不采纳', 'neutral')]
        : [];
  const decidedHost = h('span', { class: 'cr-decided' }, ...decidedNodes());

  root.append(
    ...(
      [
        h('div', { class: 'cr-head' }, members, decidedHost),
        ratings,
        reason,
        matchLine,
        h('label', { class: 'cr-story-wrap' }, h('span', { class: 'cr-label', text: '故事' }), box, counter),
        flagsHost,
        error,
        limitLine,
        manage
          ? h(
              'div',
              { class: 'cr-actions' },
              tidy.root,
              h('span', { class: 'cc-spacer' }),
              exclude,
              reject,
              h('span', { class: 'cr-adopt-group' }, adopt, adoptNote),
            )
          : null,
      ] as Array<HTMLElement | null>
    ).filter((node): node is HTMLElement => node !== null),
  );
  paint();
  return root;
}
