import type {
  BroadcastAdminClient,
  BroadcastDetail,
  BroadcastDraft,
  BroadcastOptions,
  BroadcastRow,
  BroadcastVoices,
} from '../../services/broadcast-admin-api.ts';
import { h, length } from '../cocreation/h.ts';
import { dateField } from './ui/date-field.ts';
import { exactCount, hoverValue } from './ui/hover-value.ts';
import type { ConfirmInPlace } from './ui/inline-confirm.ts';
import { pageHead } from './ui/page-head.ts';
import { paidButton } from './ui/paid-button.ts';
import { segmented } from './ui/segmented.ts';
import { statusBadge, type BadgeTone } from './ui/status-badge.ts';
import { assignColours } from './ui/character-colour.ts';
import { exactMoney } from './ui/hover-value.ts';
import type { MakeExport } from './export/export-dialog.ts';

type Voice = { kind: 'generated' | 'uploaded'; takeId: string | 'keep'; durationMs: number; text: string | null };
const STATE: Record<BroadcastRow['state'], { text: string; tone: BadgeTone }> = {
  scheduled: { text: '已定时', tone: 'info' },
  sending: { text: '发送中', tone: 'warn' },
  sent: { text: '已发送', tone: 'ok' },
  cancelled: { text: '已取消', tone: 'neutral' },
};
/** "2026-11-20 10:00 UTC": the console shows every time in UTC. */
export const utcTime = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}″`;

/**
 * 运营 → 广播. A character sends a text (1–3 bubbles) and, if wanted, a voice to every registered player: now or at a time (UTC).
 * Voice per character is generated in that character's own voice (the cost is confirmed on the button, a take is listened to
 * before sending) or uploaded as a WAV. The one irreversible step, 发送, asks in place and says what it will do; everything else
 * explains itself on hover. A scheduled broadcast can be edited or cancelled until it starts; the list shows counts, never players.
 */
export function broadcastView(
  root: HTMLElement,
  deps: {
    api: BroadcastAdminClient;
    /** Part 57: the page's 导出 button (the history, counts only; without it there is none). */
    makeExport?: MakeExport;
    run: (work: () => Promise<void>) => Promise<void>;
    confirm: ConfirmInPlace;
    toast: (text: string) => void;
    newRequestId: () => string;
    disposed: () => boolean;
    pollMs?: number;
    now?: () => number;
  },
) {
  const now = deps.now ?? (() => Date.now());
  let options: BroadcastOptions | null = null;
  let colours = new Map<string, string>();
  const selected = new Set<string>();
  let bubbles = [''];
  const voices = new Map<string, Voice>();
  const estimates = new Map<string, { micros: number } | { reason: string } | 'asking'>();
  const pending = new Map<string, string>();
  let editing: { id: string; revision: number } | null = null;
  let rows: BroadcastRow[] = [];
  let poll: ReturnType<typeof setInterval> | null = null;
  let audio: HTMLAudioElement | null = null;
  let estimateTimer: ReturnType<typeof setTimeout> | null = null;
  const requestId = (key: string) => {
    const held = pending.get(key) ?? deps.newRequestId();
    pending.set(key, held);
    return held;
  };

  // ---- compose -----------------------------------------------------------------------------------------------------------
  const characterBox = h('div', { class: 'bc-chars', attrs: { role: 'group', 'aria-label': '发送的角色' } });
  const allButton = h('button', { class: 'bc-link', text: '全选', attrs: { type: 'button' } });
  const bubbleBox = h('div', { class: 'bc-bubbles' });
  const counter = h('span', { class: 'bc-count' });
  const addBubble = h('button', { class: 'bc-link', text: '再加一条', attrs: { type: 'button' } });
  const voiceBox = h('div', { class: 'bc-voices' });
  const problem = h('p', { class: 'admin-hint bc-problem', attrs: { role: 'alert' }, hidden: true });
  const confirmHost = h('div', { class: 'bc-confirm' });
  const editBar = h('div', { class: 'bc-editbar', attrs: { 'data-open': 'false' } });
  const send = h('button', { class: 'admin-primary', attrs: { type: 'button', id: 'bc-send' } });
  const timeSeg = segmented(
    '发送时间',
    [
      { id: 'now', label: '现在发送' },
      { id: 'later', label: '定时发送' },
    ] as const,
    'now',
    () => paintTime(),
  );
  const day = dateField({ id: 'bc-day', label: '发送日期', utc: true });
  const clock = h('input', {
    class: 'bc-clock',
    attrs: {
      id: 'bc-time',
      maxlength: '5',
      placeholder: 'HH:MM',
      autocomplete: 'off',
      'aria-label': '发送时刻（UTC）',
      'data-w': 'xs',
    },
  });
  const when = h(
    'span',
    { class: 'bc-when', attrs: { 'data-open': 'false' } },
    day.root,
    clock,
    h('span', { class: 'admin-date-utc', text: 'UTC' }),
  );
  const joined = () => bubbles.map((b) => b.trim()).filter(Boolean);
  const validText = () => {
    const parts = joined();
    const total = parts.reduce((n, b) => n + length(b), 0);
    const max = options?.limits ?? { bubbleCharacters: 60, totalCharacters: 150 };
    return parts.length >= 1 && parts.every((b) => length(b) <= max.bubbleCharacters) && total <= max.totalCharacters;
  };
  const sendAt = (): number | null | 'bad' => {
    if (timeSeg.value === 'now') return null;
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(clock.value.trim());
    if (!day.value || !m) return 'bad';
    const at = Date.parse(`${day.value}T${m[1]!.padStart(2, '0')}:${m[2]}:00Z`);
    return Number.isFinite(at) ? at : 'bad';
  };
  const paintTime = () => {
    when.dataset.open = String(timeSeg.value === 'later');
    paint();
  };
  const reason = (): string => {
    if (!options) return '正在读取…';
    if (selected.size === 0) return '请先选择角色。';
    if (!validText())
      return `文字需要 1–${options.limits.bubbles} 条，每条最多 ${options.limits.bubbleCharacters} 字，合计最多 ${options.limits.totalCharacters} 字。`;
    const at = sendAt();
    if (at === 'bad') return '请填写发送日期和 HH:MM。';
    if (at !== null && at < now() + 60_000) return '定时需要在一分钟之后。';
    if (options.recipients === 0 && at === null) return '现在还没有注册玩家。';
    return '';
  };
  const paint = () => {
    const total = bubbles.reduce((n, b) => n + length(b.trim()), 0);
    counter.textContent = `合计 ${total}/${options?.limits.totalCharacters ?? 150} 字`;
    counter.dataset.over = String(!!options && total > options.limits.totalCharacters);
    addBubble.hidden = bubbles.length >= (options?.limits.bubbles ?? 3);
    send.textContent = editing ? '保存修改' : timeSeg.value === 'now' ? '发送' : '定时发送';
    const why = reason();
    send.disabled = why !== '';
    send.dataset.locked = String(why !== '');
    send.title = why;
    allButton.textContent = options && selected.size === options.characters.length ? '全不选' : '全选';
    paintVoices();
  };
  const paintBubbles = () => {
    const nodes = bubbles.map((text, index) => {
      const input = h('textarea', {
        class: 'bc-bubble',
        attrs: {
          rows: '2',
          'aria-label': `第 ${index + 1} 条`,
          maxlength: String(options?.limits.bubbleCharacters ?? 60),
        },
      });
      input.value = text;
      input.addEventListener('input', () => {
        bubbles[index] = input.value;
        // The words changed: a voice generated from the old words no longer reads them.
        for (const [id, v] of voices) if (v.kind === 'generated') voices.delete(id);
        queueEstimates();
        paint();
      });
      const remove = h('button', {
        class: 'bc-x',
        text: '删除',
        attrs: { type: 'button', 'aria-label': `删除第 ${index + 1} 条` },
      });
      remove.hidden = bubbles.length === 1;
      remove.addEventListener('click', () => {
        bubbles.splice(index, 1);
        paintBubbles();
      });
      return h('div', { class: 'bc-bubble-row' }, input, remove);
    });
    bubbleBox.replaceChildren(...nodes);
    queueEstimates();
    paint();
  };
  addBubble.addEventListener('click', () => {
    if (bubbles.length < (options?.limits.bubbles ?? 3)) {
      bubbles.push('');
      paintBubbles();
      (bubbleBox.lastElementChild?.querySelector('textarea') as HTMLElement | null)?.focus();
    }
  });

  // ---- characters ---------------------------------------------------------------------------------------------------------
  const paintCharacters = () => {
    if (!options) return;
    characterBox.replaceChildren(
      ...options.characters.map((c) => {
        const box = h('input', { attrs: { type: 'checkbox', value: c.characterId, 'aria-label': c.name } });
        box.checked = selected.has(c.characterId);
        const dot = h('i', { class: 'bc-dot', attrs: { 'aria-hidden': 'true' } });
        dot.style.background = colours.get(c.characterId) ?? '#8C8697';
        const label = h(
          'label',
          { class: 'bc-char', attrs: { 'data-on': String(box.checked), 'data-id': c.characterId } },
          box,
          dot,
          h('span', { text: c.name }),
        );
        box.addEventListener('change', () => {
          if (box.checked) selected.add(c.characterId);
          else {
            selected.delete(c.characterId);
            voices.delete(c.characterId);
          }
          label.dataset.on = String(box.checked);
          queueEstimates();
          paint();
        });
        return label;
      }),
    );
  };
  allButton.addEventListener('click', () => {
    if (!options) return;
    if (selected.size === options.characters.length) {
      selected.clear();
      voices.clear();
    } else for (const c of options.characters) selected.add(c.characterId);
    paintCharacters();
    queueEstimates();
    paint();
  });

  // ---- voices -------------------------------------------------------------------------------------------------------------
  const stop = () => {
    audio?.pause();
    audio = null;
  };
  const listen = async (takeId: string) => {
    const got = await deps.api.takeAudio(takeId);
    stop();
    const bytes = Uint8Array.from(atob(got.base64), (c) => c.charCodeAt(0));
    audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })));
    void audio.play().catch(() => undefined);
  };
  const askEstimate = async (characterId: string) => {
    const parts = joined();
    if (!options?.speechAvailable || !parts.length || !validText()) return;
    estimates.set(characterId, 'asking');
    paintVoices();
    try {
      const e = await deps.api.estimate(characterId, parts);
      if (deps.disposed()) return;
      estimates.set(characterId, e.ok ? { micros: e.estimateMicros } : { reason: e.reason });
    } catch {
      estimates.set(characterId, { reason: 'ERROR' });
    }
    paintVoices();
  };
  const queueEstimates = () => {
    estimates.clear();
    if (estimateTimer !== null) clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => {
      for (const id of selected) void askEstimate(id);
    }, 400);
  };
  const voiceRow = (id: string) => {
    const c = options!.characters.find((x) => x.characterId === id)!;
    const v = voices.get(id);
    const e = estimates.get(id);
    const dot = h('i', { class: 'bc-dot', attrs: { 'aria-hidden': 'true' } });
    dot.style.background = colours.get(id) ?? '#8C8697';
    const head = h('span', { class: 'bc-vname' }, dot, c.name);
    const controls = h('span', { class: 'bc-vctl' });
    if (v) {
      const play = h('button', { class: 'bc-play', text: `试听 ${seconds(v.durationMs)}`, attrs: { type: 'button' } });
      if (v.takeId === 'keep') play.hidden = true;
      play.addEventListener('click', () => void deps.run(() => listen(v.takeId)));
      const clear = h('button', { class: 'bc-x', text: '清除', attrs: { type: 'button' } });
      clear.addEventListener('click', () => {
        voices.delete(id);
        paintVoices();
      });
      controls.append(statusBadge(v.kind === 'generated' ? '已生成' : '已上传', 'ok'), play, clear);
    } else {
      const parts = joined();
      const pb = paidButton({
        name: `bc-${id}`,
        label: () => `生成${e && typeof e === 'object' && 'micros' in e ? ` · ${exactMoney(e.micros)}` : ''}`,
        confirmLabel: () => '确认付费生成',
        reason: () =>
          !options?.speechAvailable
            ? '这个站点还没有开启朗读。'
            : !c.voice
              ? '这个角色还没有设定音色。'
              : !parts.length || !validText()
                ? '先写好文字。'
                : e === 'asking' || e === undefined
                  ? '正在估算费用…'
                  : 'reason' in e
                    ? '暂时不能生成。'
                    : '',
        onConfirm: () => {
          void deps.run(async () => {
            const est = estimates.get(id);
            if (!est || typeof est !== 'object' || !('micros' in est)) return;
            const take = await deps.api.speak({
              requestId: requestId(`speak:${id}:${parts.join('|')}`),
              characterId: id,
              bubbles: parts,
              acknowledgeMicros: est.micros,
            });
            voices.set(id, {
              kind: 'generated',
              takeId: take.takeId,
              durationMs: take.durationMs,
              text: parts.join(''),
            });
            paintVoices();
            deps.toast('语音已生成，可以先试听');
          });
        },
      });
      const file = h('input', {
        attrs: { type: 'file', accept: '.wav,audio/wav', hidden: 'true', 'aria-label': `${c.name} 的语音文件` },
      });
      const upload = h('button', { class: 'bc-link', text: '上传 WAV', attrs: { type: 'button' } });
      upload.addEventListener('click', () => file.click());
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        if (!f) return;
        void deps.run(async () => {
          const base64 = btoa(
            Array.from(new Uint8Array(await f.arrayBuffer()), (b) => String.fromCharCode(b)).join(''),
          );
          const take = await deps.api.upload(id, base64);
          voices.set(id, { kind: 'uploaded', takeId: take.takeId, durationMs: take.durationMs, text: null });
          paintVoices();
        });
      });
      controls.append(pb.root, upload, file);
    }
    return h('div', { class: 'bc-voice', attrs: { 'data-char': id } }, head, controls);
  };
  let voiceFieldNode: HTMLElement | null = null;
  const rowCache = new Map<string, { sig: string; node: HTMLElement }>();
  /** A row is rebuilt only when what it shows changed, so an armed 生成 button is never swapped out under the pointer. */
  function paintVoices() {
    if (!options) return;
    const ids = options.characters.map((c) => c.characterId).filter((id) => selected.has(id));
    voiceBox.dataset.open = String(ids.length > 0);
    if (voiceFieldNode) voiceFieldNode.hidden = ids.length === 0;
    const nodes = ids.map((id) => {
      const v = voices.get(id);
      const e = estimates.get(id);
      const sig = JSON.stringify([
        v ? [v.kind, v.takeId, v.durationMs] : null,
        e === undefined ? null : typeof e === 'string' ? e : 'micros' in e ? e.micros : e.reason,
        joined().join('|'),
      ]);
      const cached = rowCache.get(id);
      if (cached && cached.sig === sig) return cached.node;
      const node = voiceRow(id);
      rowCache.set(id, { sig, node });
      return node;
    });
    for (const id of [...rowCache.keys()]) if (!ids.includes(id)) rowCache.delete(id);
    voiceBox.replaceChildren(...nodes);
  }

  // ---- send / edit ---------------------------------------------------------------------------------------------------------
  const draft = (): BroadcastDraft => {
    const ids = options!.characters.map((c) => c.characterId).filter((id) => selected.has(id));
    const map: BroadcastVoices = {};
    for (const id of ids) {
      const v = voices.get(id);
      map[id] = v ? (v.takeId === 'keep' ? 'keep' : v.takeId) : null;
    }
    const at = sendAt();
    return {
      bubbles: joined(),
      characterIds: ids,
      voices: map,
      sendAt: at === 'bad' ? null : at,
      acknowledge: { characters: ids.length, recipients: options!.recipients },
    };
  };
  const reset = () => {
    selected.clear();
    voices.clear();
    estimates.clear();
    pending.clear();
    bubbles = [''];
    editing = null;
    editBar.dataset.open = 'false';
    editBar.replaceChildren();
    clock.value = '';
    day.value = '';
    timeSeg.set('now');
    paintCharacters();
    paintBubbles();
    paintTime();
  };
  const submit = async () => {
    const why = reason();
    if (why || !options) return;
    const d = draft();
    const later = d.sendAt !== null;
    const target = options.recipients;
    const ok = await deps.confirm(
      {
        title: '确认发送广播',
        message: editing
          ? `保存对这条定时广播的修改：${d.characterIds.length} 个角色，${utcTime(d.sendAt ?? now())} 发出。`
          : later
            ? `将在 ${utcTime(d.sendAt!)} 由 ${d.characterIds.length} 个角色，向当时的注册玩家各发送一条消息（现在是 ${exactCount(target)} 位）。开始发送前可以修改或取消。`
            : `将由 ${d.characterIds.length} 个角色，向 ${exactCount(target)} 位注册玩家各发送一条消息，玩家的聊天里会出现这是角色自己说的话。发出后不能撤回。`,
        confirmLabel: editing ? '保存修改' : later ? '确认定时' : `确认发送给 ${exactCount(target)} 位`,
      },
      confirmHost,
    );
    if (!ok) return;
    await deps.run(async () => {
      if (editing)
        await deps.api.update(requestId(`update:${editing.id}:${JSON.stringify(d)}`), editing.id, editing.revision, d);
      else await deps.api.create(requestId(`create:${JSON.stringify(d)}`), d);
      deps.toast(editing ? '修改已保存' : later ? '已定时' : '已开始发送');
      reset();
      await refresh();
    });
  };
  send.addEventListener('click', () => void submit());

  const startEdit = async (id: string) => {
    const d: BroadcastDetail = await deps.api.detail(id);
    if (!d.editable || !d.bubbles || !d.characterIds) return;
    selected.clear();
    voices.clear();
    for (const c of d.characterIds) selected.add(c);
    bubbles = [...d.bubbles];
    for (const [c, v] of Object.entries(d.voices ?? {}))
      voices.set(c, { kind: v.kind, takeId: 'keep', durationMs: v.durationMs, text: null });
    editing = { id: d.id, revision: d.revision };
    timeSeg.set('later');
    const iso = new Date(d.sendAt).toISOString();
    day.value = iso.slice(0, 10);
    clock.value = iso.slice(11, 16);
    const cancel = h('button', { class: 'bc-link', text: '放弃修改', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => reset());
    editBar.replaceChildren(h('span', { text: `正在修改 ${utcTime(d.sendAt)} 的定时广播` }), cancel);
    editBar.dataset.open = 'true';
    paintCharacters();
    paintBubbles();
    paintTime();
    root.querySelector('.bc-compose')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };

  // ---- the list -------------------------------------------------------------------------------------------------------------
  const listBox = h('div', { class: 'bc-list' });
  const paintList = () => {
    if (!rows.length) {
      listBox.replaceChildren(h('p', { class: 'admin-hint', text: '还没有发过广播。' }));
      return;
    }
    const head = h(
      'div',
      { class: 'bc-row bc-row-head', attrs: { role: 'row' } },
      ...['状态', '角色', '时间', '玩家'].map((t) => h('span', { text: t, attrs: { role: 'columnheader' } })),
      h('span', { text: '' }),
    );
    const body = rows.map((r) => {
      const state = h('span', { class: 'bc-state' }, statusBadge(STATE[r.state].text, STATE[r.state].tone));
      if (r.state === 'sending') {
        const bar = h('i', { class: 'bc-bar', attrs: { 'aria-hidden': 'true' } }, h('b'));
        (bar.firstChild as HTMLElement).style.width = `${r.percent}%`;
        state.append(h('span', { class: 'bc-pct', text: `${r.percent}%` }), bar);
      }
      const names = r.characters.map((c) => c.name).join('、');
      const who = hoverValue(h('span', { class: 'bc-names', text: names }), names);
      const acts = h('span', { class: 'bc-acts' });
      if (r.state === 'scheduled') {
        const edit = h('button', { class: 'bc-link', text: '修改', attrs: { type: 'button' } });
        edit.addEventListener('click', () => void deps.run(() => startEdit(r.id)));
        const cancel = h('button', { class: 'bc-link bc-danger', text: '取消', attrs: { type: 'button' } });
        cancel.addEventListener(
          'click',
          () =>
            void (async () => {
              const ok = await deps.confirm(
                {
                  title: '取消广播',
                  message: `取消 ${utcTime(r.sendAt)} 的定时广播？取消后不会发出。`,
                  confirmLabel: '取消广播',
                },
                confirmHost,
              );
              if (!ok) return;
              await deps.run(async () => {
                await deps.api.cancel(requestId(`cancel:${r.id}`), r.id);
                if (editing?.id === r.id) reset();
                await refresh();
              });
            })(),
        );
        acts.append(edit, cancel);
      }
      return h(
        'div',
        { class: 'bc-row', attrs: { role: 'row', 'data-state': r.state } },
        state,
        who,
        h('span', { text: utcTime(r.sendAt) }),
        h('span', { class: 'bc-num', text: r.state === 'scheduled' ? '—' : exactCount(r.recipients) }),
        acts,
      );
    });
    listBox.replaceChildren(
      h('div', { class: 'bc-table', attrs: { role: 'table', 'aria-label': '广播记录' } }, head, ...body),
    );
  };
  const refresh = async () => {
    const got = await deps.api.list();
    if (deps.disposed()) return;
    rows = got.broadcasts;
    if (options) options.recipients = got.recipients;
    paintList();
    paint();
    const live = rows.some((r) => r.state === 'sending' || (r.state === 'scheduled' && r.sendAt <= now() + 5000));
    if (live && poll === null) poll = setInterval(() => void refresh().catch(() => undefined), deps.pollMs ?? 2000);
    if (!live && poll !== null) {
      clearInterval(poll);
      poll = null;
    }
  };

  const recipientsLine = h('span', { class: 'bc-recipients' });
  const whyLine = h('span', { class: 'bc-why', attrs: { 'aria-live': 'polite' } });
  const sendBar = h('div', { class: 'bc-sendbar' }, send, whyLine);
  const label = (text: string, tip: string | null, ...body: Node[]) =>
    h(
      'div',
      { class: 'bc-field' },
      tip ? hoverValue(h('span', { class: 'bc-label', text }), tip) : h('span', { class: 'bc-label', text }),
      ...body,
    );
  const voiceField = label(
    '语音（可选）',
    '每个角色单独设置。生成用该角色自己的音色，先试听再发送；也可以上传 WAV。有语音时，玩家看到的是一条语音，文字可「转文字」查看。',
    voiceBox,
  );
  voiceField.className = 'bc-field bc-voicefield';
  voiceField.hidden = true;
  voiceFieldNode = voiceField;
  const charField = label('角色', '按首页顺序；只有在线的角色可选。每个角色各发一条。', allButton, characterBox);
  charField.className = 'bc-field bc-charfield';
  root.replaceChildren(
    pageHead(
      '广播',
      recipientsLine,
      deps.makeExport?.(() => [
        {
          id: 'broadcast',
          label: '广播记录',
          kind: 'broadcast',
          range: 'none',
          tip: '每次广播的状态、时间和人数；没有玩家，也没有消息内容',
        },
      ]),
    ),
    h(
      'section',
      { class: 'bc-compose system-section' },
      editBar,
      charField,
      label(
        '文字',
        '1–3 条，每条最多 60 字，合计最多 150 字。',
        bubbleBox,
        h('div', { class: 'bc-bubblefoot' }, addBubble, counter),
      ),
      voiceField,
      label('时间', '时间按 UTC 显示。定时至少在一分钟之后。', h('div', { class: 'bc-time' }, timeSeg.root, when)),
      problem,
      sendBar,
      confirmHost,
    ),
    h('section', { class: 'system-section' }, h('h3', { text: '广播记录' }), listBox),
  );
  const why = whyLine;
  const origPaint = paint;
  void origPaint;
  const refreshWhy = () => {
    why.textContent = reason();
  };
  for (const node of [clock, day.input, bubbleBox, characterBox]) {
    node.addEventListener('input', () => {
      paint();
      refreshWhy();
    });
    node.addEventListener('change', () => {
      paint();
      refreshWhy();
    });
  }
  refreshWhy();

  return {
    load: async () => {
      options = await deps.api.options();
      colours = assignColours(
        options.characters.map((c) => ({ characterId: c.characterId, color: c.color, displayName: c.name })),
      );
      recipientsLine.textContent = '';
      for (const id of [...selected]) if (!options.characters.some((c) => c.characterId === id)) selected.delete(id);
      paintCharacters();
      if (!editing) paintBubbles();
      paintTime();
      recipientsLine.textContent = `注册玩家 ${exactCount(options.recipients)} 位`;
      await refresh();
      refreshWhy();
    },
    clear() {
      if (poll !== null) clearInterval(poll);
      poll = null;
      if (estimateTimer !== null) clearTimeout(estimateTimer);
      stop();
      options = null;
      rows = [];
      reset();
      listBox.replaceChildren();
    },
  };
}
