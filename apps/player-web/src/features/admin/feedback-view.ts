import type { FeedbackAdminClient, FeedbackCounts, FeedbackFilter, FeedbackItem, FeedbackRange } from '../../services/feedback-admin-api.ts';
import { h } from '../cocreation/h.ts';
import type { MakeExport } from './export/export-dialog.ts';
import { writerField } from './export/export-fields.ts';
import { exactCount, hoverValue } from './ui/hover-value.ts';
import { segmented } from './ui/segmented.ts';
import { errorLine } from './ui/error-line.ts';

/**
 * 语音反馈 (Part 36, the owner's page): how many 👍 / 👎 each character, each 回复写法 and each model got over a range, and the 👎
 * replies, newest first, in the pseudonymous form of 测试对话 (the anonymous code, nicknames replaced). Her voice plays here; an
 * item can be marked 已听. No sentence explains the page: the words are on hover (docs/ADMIN_COPY.md).
 */
export const feedbackCopy = {
  title: '语音反馈',
  tip: '玩家对角色回复点的赞和踩。踩可以是对语音，也可以是对内容。',
  ranges: [
    { id: '7', label: '7 天' },
    { id: '30', label: '30 天' },
    { id: '90', label: '90 天' },
  ] as const,
  scope: [
    { id: 'all', label: '全部' },
    { id: 'unheard', label: '未听' },
  ] as const,
  up: '赞',
  down: '踩',
  voice: '语音',
  content: '内容',
  byCharacter: '按角色',
  byWriter: '按回复写法',
  byModel: '按模型',
  allCharacters: '全部角色',
  allWriters: '全部回复写法',
  allModels: '全部模型',
  play: '播放',
  playing: '播放中',
  heard: '已听',
  unheard: '标为已听',
  more: '更多',
  empty: '这段时间还没有踩。',
  playerSays: '玩家',
  replySays: '角色',
};

export function feedbackView(
  root: HTMLElement,
  deps: {
    api: Pick<FeedbackAdminClient, 'counts' | 'list' | 'heard' | 'audio'>;
    run: (work: () => Promise<void>) => Promise<void>;
    status: (text: string) => void;
    disposed: () => boolean;
    makeExport?: MakeExport;
  },
) {
  let range: FeedbackRange = 30;
  let characterId = '',
    writer = '',
    model = '',
    unheardOnly = false;
  let counts: FeedbackCounts | null = null;
  let items: FeedbackItem[] = [];
  let hasMore = false;
  let loadId = 0;
  let audio: HTMLAudioElement | null = null;
  let audioUrl: string | null = null;
  let playingItem = 0;

  const filter = (): FeedbackFilter => ({
    range,
    ...(characterId ? { characterId } : {}),
    ...(writer ? { writer } : {}),
    ...(model ? { model } : {}),
    ...(unheardOnly ? { unheardOnly: true } : {}),
  });
  const rangeBar = segmented(
    '范围',
    feedbackCopy.ranges.map((r) => ({ id: r.id, label: r.label })),
    String(range),
    (id) => {
      range = Number(id) as FeedbackRange;
      void load();
    },
  );
  const scopeBar = segmented(
    '听过没有',
    feedbackCopy.scope.map((r) => ({ id: r.id, label: r.label })),
    'all',
    (id) => {
      unheardOnly = id === 'unheard';
      void loadList(false);
    },
  );
  const select = (label: string, onPick: (value: string) => void) => {
    const input = h('select', { attrs: { 'aria-label': label } });
    input.addEventListener('change', () => onPick(input.value));
    return input;
  };
  const characterSelect = select('角色', (value) => {
    characterId = value;
    void load();
  });
  const writerSelect = select('回复写法', (value) => {
    writer = value;
    void load();
  });
  const modelSelect = select('模型', (value) => {
    model = value;
    void load();
  });
  const bar = h('div', { class: 'admin-bar', attrs: { role: 'toolbar' } }, rangeBar.root, scopeBar.root, characterSelect, writerSelect, modelSelect);
  const exportButton = deps.makeExport?.(() => [
    {
      id: 'feedback',
      label: '语音反馈',
      kind: 'feedback',
      range: 'days',
      filters: () => ({ ...(characterId ? { characterId } : {}), ...(model ? { model } : {}), ...(unheardOnly ? { unheardOnly: true } : {}) }),
      fields: [writerField],
      tip: '每条踩一行：玩家的话、回复文字、踩的是语音还是内容。',
    },
  ]);
  if (exportButton) bar.append(h('span', { class: 'admin-bar-spacer' }), exportButton);
  const head = h('h2', { class: 'admin-page-title', text: feedbackCopy.title, attrs: { title: feedbackCopy.tip } });
  const summary = h('div', { class: 'fb-summary' });
  const list = h('div', { class: 'fb-list' });
  const more = h('button', { class: 'admin-secondary', text: feedbackCopy.more, attrs: { type: 'button' }, hidden: true });
  more.addEventListener('click', () => void deps.run(() => loadList(true)));
  const errors = h('div', { class: 'fb-errors' });
  root.append(head, bar, errors, summary, list, more);

  const fill = (select: HTMLSelectElement, all: string, options: readonly (readonly [string, string])[], value: string) => {
    select.replaceChildren(h('option', { text: all, attrs: { value: '' } }), ...options.map(([v, l]) => h('option', { text: l, attrs: { value: v } })));
    select.value = options.some(([v]) => v === value) ? value : '';
  };
  const num = (n: number) => hoverValue(h('span', { text: n.toLocaleString('en-US') }), exactCount(n));
  const countsTable = (title: string, rows: { name: string; up: number; down: number }[]) => {
    const table = h('table', { class: 'admin-table fb-table' });
    table.append(
      h('caption', { text: title }),
      h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { class: 'num', text: feedbackCopy.up }), h('th', { class: 'num', text: feedbackCopy.down }))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, h('th', { text: r.name }), h('td', { class: 'num' }, num(r.up)), h('td', { class: 'num' }, num(r.down))))),
    );
    return table;
  };
  const drawSummary = () => {
    summary.replaceChildren();
    if (!counts) return;
    const t = counts.total;
    summary.append(
      h(
        'p',
        { class: 'fb-total' },
        h('span', { text: `${feedbackCopy.up} ` }),
        num(t.up),
        h('span', { text: `　${feedbackCopy.down} ` }),
        num(t.down),
        h('span', { text: `（${feedbackCopy.voice} ` }),
        num(t.downVoice),
        h('span', { text: `　${feedbackCopy.content} ` }),
        num(t.downContent),
        h('span', { text: '）' }),
      ),
      h(
        'div',
        { class: 'fb-tables' },
        countsTable(feedbackCopy.byCharacter, counts.byCharacter.map((r) => ({ name: r.label, up: r.up, down: r.down }))),
        countsTable(feedbackCopy.byWriter, counts.byWriter.map((r) => ({ name: r.label, up: r.up, down: r.down }))),
        countsTable(feedbackCopy.byModel, counts.byModel.map((r) => ({ name: r.model, up: r.up, down: r.down }))),
      ),
    );
  };

  const stopAudio = () => {
    audio?.pause();
    audio = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    playingItem = 0;
  };
  const card = (item: FeedbackItem) => {
    const heard = h('button', { class: 'admin-secondary fb-heard', text: item.heard ? feedbackCopy.heard : feedbackCopy.unheard, attrs: { type: 'button', 'aria-pressed': String(item.heard) } });
    heard.addEventListener('click', () =>
      void deps.run(async () => {
        const next = !item.heard;
        await deps.api.heard(item.itemId, next);
        item.heard = next;
        heard.textContent = next ? feedbackCopy.heard : feedbackCopy.unheard;
        heard.setAttribute('aria-pressed', String(next));
        card.classList.toggle('is-heard', next);
      }),
    );
    const play = item.hasVoice ? h('button', { class: 'admin-secondary fb-play', text: feedbackCopy.play, attrs: { type: 'button' } }) : null;
    play?.addEventListener('click', () =>
      void deps.run(async () => {
        if (playingItem === item.itemId) {
          stopAudio();
          play.textContent = feedbackCopy.play;
          return;
        }
        stopAudio();
        for (const other of list.querySelectorAll<HTMLElement>('.fb-play')) other.textContent = feedbackCopy.play;
        const clip = await deps.api.audio(item.itemId);
        audioUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(clip.base64), (c) => c.charCodeAt(0))], { type: clip.contentType }));
        audio = new Audio(audioUrl);
        playingItem = item.itemId;
        play.textContent = feedbackCopy.playing;
        audio.addEventListener('ended', () => {
          stopAudio();
          play.textContent = feedbackCopy.play;
        });
        await audio.play();
      }),
    );
    const card = h(
      'article',
      { class: `fb-item${item.heard ? ' is-heard' : ''}`, attrs: { 'data-item': String(item.itemId) } },
      h(
        'header',
        { class: 'fb-head' },
        h('strong', { text: item.label }),
        h('span', { class: 'fb-target', text: item.target === 'voice' ? feedbackCopy.voice : feedbackCopy.content }),
        h('span', { class: 'fb-meta', text: `${item.time} · ${item.writerLabel} · ${item.model}` }),
        h('span', { class: 'admin-bar-spacer' }),
        play,
        heard,
      ),
      ...item.playerLines.map((line) => h('p', { class: 'fb-line fb-player', text: line, attrs: { title: feedbackCopy.playerSays } })),
      h('p', { class: 'fb-line fb-reply', text: item.replyText, attrs: { title: feedbackCopy.replySays } }),
    );
    return card;
  };
  const drawList = () => {
    list.replaceChildren(...(items.length ? items.map(card) : [h('p', { class: 'admin-empty', text: feedbackCopy.empty })]));
    more.hidden = !hasMore;
  };

  async function loadList(append: boolean) {
    const mine = ++loadId;
    const page = await deps.api.list({ ...filter(), ...(append && items.length ? { before: items[items.length - 1]!.itemId } : {}) });
    if (mine !== loadId || deps.disposed()) return;
    items = append ? [...items, ...page.items] : page.items;
    hasMore = page.hasMore;
    drawList();
  }
  async function load() {
    stopAudio();
    errors.replaceChildren();
    try {
      await deps.run(async () => {
        counts = await deps.api.counts(filter());
        // the selects offer what the data has, keeping the choice
        fill(characterSelect, feedbackCopy.allCharacters, counts.byCharacter.map((r) => [r.characterId, r.label] as const), characterId);
        fill(writerSelect, feedbackCopy.allWriters, counts.byWriter.map((r) => [r.writer, r.label] as const), writer);
        fill(modelSelect, feedbackCopy.allModels, counts.byModel.map((r) => [r.model, r.model] as const), model);
        characterId = characterSelect.value;
        writer = writerSelect.value;
        model = modelSelect.value;
        drawSummary();
        await loadList(false);
      });
    } catch (error) {
      errors.append(errorLine((error as { code?: string }).code ?? (error as Error).message));
    }
  }
  return { load, clear: () => stopAudio(), root };
}
