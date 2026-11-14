import type { CharacterAdminClient } from '../../services/character-admin-api.ts';
import type { ClipTakes, Slot, Take } from '../../services/clip-takes-api.ts';
import { ERROR_SENTENCES } from './error-sentences.ts';
import { copyCodeButton } from './ui/error-line.ts';
import { AdminFormError, check, el } from './character-form.ts';
import { paidButton } from './ui/paid-button.ts';
import { statusBadge } from './ui/status-badge.ts';
import { hoverValue } from './ui/hover-value.ts';
import { micros } from './preview/copy.ts';

/**
 * Part 30: the 声音 tab. One panel per character: the voice at the top, 生成全部, then one block per slot (a welcome line or the
 * footer) listing its takes. Every take has its own player that loads by itself; the person marks one take per slot as 选用,
 * ticks the slots they heard to the end, and presses one 批准. The workbench hands in its own helpers, so every button follows the
 * console's rules (locked while busy or unsaved, one request id per paid action, a refusal always shows its sentence).
 */
export type PanelEnv = {
  api: CharacterAdminClient;
  target: string;
  dirty: () => boolean;
  can: (action: 'materials' | 'approve-materials' | 'read') => boolean;
  gone: () => boolean;
  view: () => number;
  button: (
    parent: HTMLElement,
    text: string | (() => string),
    locked: () => boolean,
    work: () => Promise<void> | void,
    secondary?: boolean,
  ) => HTMLButtonElement;
  guard: <T extends HTMLInputElement | HTMLTextAreaElement>(node: T, locked: () => boolean) => T;
  act: (work: () => Promise<void>) => void;
  exact: <I, T>(key: string, input: I, send: (input: I) => Promise<T>) => Promise<T>;
  /** Controls inside a node that is about to be replaced are forgotten. */
  release: (container: HTMLElement) => void;
  paint: (zone: { node: HTMLElement; paint: () => void }) => void;
  sync: () => void;
  status: (text: string) => void;
  /** Every time the slots were read (the 发布 tab shows each slot's 选用 take name). */
  changed: (value: ClipTakes) => void;
  /** Blob URLs the page owns (revoked when the role is left). */
  urls: Set<string>;
};
const ORIGIN_TEXT = { generated: '生成', feedback: '按反馈', uploaded: '上传' } as const;
const slotName = (slot: Slot, index: number) => (slot.kind === 'footer' ? '结束' : `欢迎 ${index + 1}`);
const estimateWhy = (why: string) => (why === 'PRICE_MISSING' ? 'Fish 价格未生效，先到「系统」续期价格' : '暂不能生成');
const seconds = (ms: number | null) => (ms === null ? '' : `${(ms / 1000).toFixed(2)} 秒`);

export function clipTakesPanel(parent: HTMLElement, env: PanelEnv) {
  const root = el('div');
  root.className = 'vc-panel';
  parent.append(root);
  let state: ClipTakes | null = null;
  /** Estimates by slot (one take of that slot) and for 生成全部 (every empty slot). */
  const estimates = new Map<string, Awaited<ReturnType<CharacterAdminClient['takeEstimate']>>>();
  let allEstimate: Awaited<ReturnType<CharacterAdminClient['takeEstimate']>> | null = null;
  /** takeId → played to the end (the 选用 take must have been heard before its slot can be ticked). */
  const heard = new Set<string>();
  /** Blob URL by take id + sha (a take's bytes never change). */
  const audioUrls = new Map<string, string>();
  const sentence = (code: string) => ERROR_SENTENCES[code] ?? '失败，没有更多信息。';
  const reason = (extra = ''): string =>
    env.dirty() ? '先保存草稿' : !env.can('materials') ? '你没有素材权限' : !state?.voice ? '先填 音色编号' : extra;

  async function load() {
    const token = env.view();
    const next = await env.api.takes(env.target);
    if (env.gone() || token !== env.view()) return;
    state = next;
    env.changed(next);
    paint();
    if (!next.speechAvailable || !next.voice) return;
    const empty = next.slots.filter((slot) => !slot.takes.some((take) => take.usable));
    await Promise.all([
      ...next.slots.map((slot) =>
        env.api
          .takeEstimate(env.target, [slot.slotKey])
          .then((value) => estimates.set(slot.slotKey, value))
          .catch(() => estimates.set(slot.slotKey, { ok: false, reason: 'UNAVAILABLE' })),
      ),
      empty.length
        ? env.api
            .takeEstimate(
              env.target,
              empty.map((slot) => slot.slotKey),
            )
            .then((value) => (allEstimate = value))
            .catch(() => (allEstimate = { ok: false, reason: 'UNAVAILABLE' }))
        : Promise.resolve((allEstimate = null)),
    ]);
    if (env.gone() || token !== env.view()) return;
    paint();
  }
  const reload = async () => {
    await load();
  };

  function paint() {
    if (!state) return;
    env.release(root);
    root.replaceChildren();
    voiceLine(state);
    const empty = state.slots.filter((slot) => !slot.takes.some((take) => take.usable));
    if (state.speechAvailable && empty.length > 1) generateAll(empty);
    state.slots.forEach((slot, index) => slotBlock(slot, index));
    approval(state);
    env.sync();
  }

  function voiceLine(current: ClipTakes) {
    const line = el('div');
    line.className = 'vc-voice-line';
    root.append(line);
    if (!current.voice) {
      line.append(el('p', '先填 音色编号。'));
      return;
    }
    // The 音色编号 and 语速 are the form's own fields right above; this line says what will speak and where the voice lives.
    const will = el('span', `将用 ${current.voice.model} 朗读`);
    will.className = 'vc-k';
    line.append(will);
    const link = el('a', '在 fish.audio 打开这个音色');
    link.href = current.voice.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'vc-link';
    line.append(link);
  }

  function generateAll(empty: Slot[]) {
    const bar = el('div');
    bar.className = 'vc-all';
    root.append(bar);
    const key = `generate-all:${env.target}`;
    const cost = () => (allEstimate?.ok ? micros(allEstimate.estimateMicros) : '');
    const paid = paidButton({
      name: 'generate-all',
      label: () => (cost() ? `生成全部 ${empty.length} 条 · 约 ${cost()}` : `生成全部 ${empty.length} 条`),
      confirmLabel: () => `确认付费 · ${cost()}`,
      reason: () => reason(!allEstimate ? '正在读取费用' : !allEstimate.ok ? estimateWhy(allEstimate.reason) : ''),
      onConfirm: () => {
        const confirmed = allEstimate;
        if (!confirmed?.ok) return;
        env.act(async () => {
          let results: Awaited<ReturnType<CharacterAdminClient['takeGenerateAll']>> = [];
          try {
            results = await env.exact(
              key,
              { requestId: crypto.randomUUID(), acknowledgeMicros: confirmed.estimateMicros },
              (input) => env.api.takeGenerateAll(env.target, input),
            );
          } finally {
            if (!env.gone()) await reload().catch(() => undefined);
          }
          if (env.gone()) return;
          const failed = results.filter((item) => item.code);
          env.status(
            failed.length
              ? `已生成 ${results.length - failed.length} 条；${failed.length} 条没有成功，见各位置。`
              : `已生成 ${results.length} 条。请逐条试听。`,
          );
        });
      },
    });
    paid.root.classList.add('vc-gen');
    bar.append(paid.root);
    env.paint({ node: paid.root, paint: () => paid.refresh() });
  }

  function slotBlock(slot: Slot, index: number) {
    const block = el('section');
    block.className = 'vc-slot';
    block.dataset.slot = slot.slotKey;
    block.dataset.state = slot.approved ? 'approved' : slot.takes.some((take) => take.usable) ? 'ready' : 'empty';
    root.append(block);
    const head = el('div');
    head.className = 'vc-slot-head';
    head.append(el('h4', slotName(slot, index)));
    if (slot.approved) head.append(statusBadge('已批准', 'ok'));
    block.append(head, el('p', slot.text));
    if (slot.issue) {
      const badge = statusBadge(slot.issue.state === 'unknown' ? '结果未确认' : '未生成', 'warn');
      badge.className = `${badge.className} vc-issue`.trim();
      hoverValue(badge, sentence(slot.issue.code));
      block.append(badge, ' ', copyCodeButton(slot.issue.code));
    }
    if (slot.takes.length) {
      const list = el('div');
      list.className = 'vc-takes';
      block.append(list);
      for (const take of slot.takes) takeRow(list, slot, take);
    }
    slotActions(block, slot);
  }

  function takeRow(list: HTMLElement, slot: Slot, take: Take) {
    const row = el('div');
    row.className = 'vc-take';
    row.dataset.take = take.takeId;
    row.dataset.selected = String(take.selected && take.usable);
    row.dataset.usable = String(take.usable);
    list.append(row);
    // the name, renamed in place
    const name = env.guard(el('input'), () => env.dirty() || !env.can('materials'));
    name.className = 'vc-take-name';
    name.value = take.name;
    name.maxLength = 20;
    name.setAttribute('aria-label', '名称');
    name.addEventListener('change', () => {
      const next = name.value.trim();
      if (!next || next === take.name) {
        name.value = take.name;
        return;
      }
      env.act(async () => {
        await env.api.takeRename(env.target, take.takeId, next);
        if (!env.gone()) await reload();
      });
    });
    row.append(name);
    const meta = el('span', `${ORIGIN_TEXT[take.origin]}${take.durationMs ? ` · ${seconds(take.durationMs)}` : ''}`);
    meta.className = 'vc-meta';
    if (take.sha256) hoverValue(meta, `SHA256 ${take.sha256}`);
    row.append(meta);
    // Four fixed columns (name | origin · duration | player | actions): the player and the buttons line up whatever the origin says.
    const main = el('div');
    main.className = 'vc-take-main';
    row.append(main);
    if (take.status === 'unusable') {
      const badge = statusBadge(sentence(take.errorCode ?? 'WEB_SPEECH_NO_ONSET'), 'warn');
      badge.className = `${badge.className} vc-issue`.trim();
      main.append(badge);
    } else {
      main.append(player(take));
      if (!take.usable) main.append(statusBadge('与现在的欢迎词或音色不符', 'neutral'));
    }
    const actions = el('div');
    actions.className = 'vc-take-actions';
    row.append(actions);
    if (take.status === 'ready' && take.usable) {
      // the state says 已选用; the action that makes it so says 选用
      if (take.selected) actions.append(statusBadge('已选用', 'ok'));
      else
        env.button(
          actions,
          '选用',
          () => env.dirty() || !env.can('materials'),
          async () => {
            await env.api.takeSelect(env.target, take.takeId);
            if (!env.gone()) await reload();
          },
          true,
        ).className = 'admin-secondary vc-small';
    }
    const locked = take.selected && slot.approved;
    const del = env.button(
      actions,
      '删除',
      () => env.dirty() || !env.can('materials') || locked,
      async () => {
        await env.api.takeDelete(env.target, take.takeId);
        heard.delete(take.takeId);
        if (!env.gone()) await reload();
      },
      true,
    );
    del.className = 'admin-secondary vc-small';
    if (locked) hoverValue(del, sentence('TAKE_IN_USE'));
    if (take.feedback) {
      const note = el('p', `反馈：${take.feedback}`);
      note.className = 'vc-note';
      if (take.markup) hoverValue(note, take.markup);
      row.append(note);
    }
  }

  /** The inline player: ready by itself (the audio is read when the take is shown, never behind a button). */
  function player(take: Take) {
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'auto';
    audio.className = 'vc-player';
    audio.addEventListener('ended', () => {
      heard.add(take.takeId);
      env.sync();
      refreshApproval?.();
    });
    const cacheKey = `${take.takeId}:${take.sha256}`;
    const have = audioUrls.get(cacheKey);
    if (have) audio.src = have;
    else {
      const token = env.view();
      void env.api
        .takeAudio(env.target, take.takeId)
        .then(async (base64) => {
          if (env.gone() || token !== env.view()) return;
          const bytes = Uint8Array.from(atob(base64), (v) => v.charCodeAt(0));
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          if (digest !== take.sha256) throw new AdminFormError('成品哈希不匹配，拒绝试听或批准。');
          const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
          env.urls.add(url);
          audioUrls.set(cacheKey, url);
          audio.src = url;
        })
        .catch((error: unknown) => {
          audio.replaceWith(statusBadge(error instanceof AdminFormError ? error.message : '没有读取成功', 'warn'));
        });
    }
    return audio;
  }

  function slotActions(block: HTMLElement, slot: Slot) {
    const bar = el('div');
    bar.className = 'vc-actions';
    block.append(bar);
    const key = `generate:${env.target}:${slot.slotKey}`;
    const has = slot.takes.length > 0;
    const estimate = () => estimates.get(slot.slotKey) ?? null;
    const cost = () => {
      const e = estimate();
      return e?.ok ? micros(e.estimateMicros) : '';
    };
    if (state?.speechAvailable) {
      const paid = paidButton({
        name: `generate-${slot.slotKey}`,
        label: () => `${has ? '重录' : '生成'}${cost() ? ` · 约 ${cost()}` : ''}`,
        confirmLabel: () => `确认付费 · ${cost()}`,
        reason: () => {
          const e = estimate();
          return reason(!e ? '正在读取费用' : !e.ok ? estimateWhy(e.reason) : '');
        },
        onConfirm: () => {
          const confirmed = estimate();
          if (!confirmed?.ok) return;
          env.act(async () => {
            try {
              await env.exact(
                key,
                { requestId: crypto.randomUUID(), slotKey: slot.slotKey, acknowledgeMicros: confirmed.estimateMicros },
                (input) => env.api.takeGenerate(env.target, input),
              );
            } catch (error) {
              // An UNKNOWN call keeps its hold and is never resent: read the slot again so it shows 「未确认 · CODE」, then say why.
              if (!env.gone()) await reload().catch(() => undefined);
              throw error;
            }
            if (env.gone()) return;
            await reload();
            env.status('已加一条。请试听；生成不会批准。');
          });
        },
      });
      paid.root.classList.add('vc-gen');
      bar.append(paid.root);
      env.paint({ node: paid.root, paint: () => paid.refresh() });
      if (state.directionAvailable && has) feedbackRetake(block, bar, slot);
    }
    upload(bar, slot);
  }

  /** 按反馈重录: feedback → the marked-up line (editable) → 生成. Nothing is spent until the paid button is pressed twice. */
  function feedbackRetake(block: HTMLElement, bar: HTMLElement, slot: Slot) {
    const open = env.button(
      bar,
      '按反馈重录',
      () => env.dirty() || !env.can('materials'),
      () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) feedback.focus();
      },
      true,
    );
    open.className = 'admin-secondary';
    const panel = el('div');
    panel.className = 'vc-feedback';
    panel.hidden = true;
    block.append(panel);
    const feedback = env.guard(el('textarea'), () => env.dirty() || !env.can('materials'));
    feedback.rows = 2;
    feedback.maxLength = 200;
    feedback.placeholder = '例如：开头更懒一点，最后一句带笑';
    feedback.className = 'vc-feedback-input';
    feedback.setAttribute('aria-label', '反馈');
    panel.append(feedback);
    const rewriteBar = el('div');
    rewriteBar.className = 'vc-actions';
    panel.append(rewriteBar);
    let markup: HTMLTextAreaElement | null = null;
    const rewrite = env.button(
      rewriteBar,
      '改写这句',
      () => env.dirty() || !env.can('materials') || !feedback.value.trim(),
      async () => {
        const text = feedback.value.trim();
        const marked = await env.exact(
          `rewrite:${env.target}:${slot.slotKey}`,
          { requestId: crypto.randomUUID(), slotKey: slot.slotKey, feedback: text },
          (input) => env.api.takeRewrite(env.target, input),
        );
        if (env.gone()) return;
        showMarkup(marked, text);
      },
    );
    rewrite.className = 'admin-primary';
    feedback.addEventListener('input', env.sync);
    const result = el('div');
    result.className = 'vc-markup';
    panel.append(result);
    function showMarkup(marked: string, usedFeedback: string) {
      result.replaceChildren();
      markup = env.guard(el('textarea'), () => env.dirty() || !env.can('materials'));
      markup.rows = 3;
      markup.value = marked;
      markup.className = 'vc-markup-input';
      markup.setAttribute('aria-label', '带标记的句子');
      result.append(markup);
      let est: Awaited<ReturnType<CharacterAdminClient['takeEstimate']>> | null = null;
      const refreshEstimate = () => {
        est = null;
        paid.refresh();
        void env.api
          .takeEstimate(env.target, [slot.slotKey], markup!.value)
          .then((value) => {
            est = value;
            paid.refresh();
          })
          .catch(() => {
            est = { ok: false, reason: 'TEXT_INVALID' };
            paid.refresh();
          });
      };
      const cost = () => (est?.ok ? micros(est.estimateMicros) : '');
      const paid = paidButton({
        name: `feedback-${slot.slotKey}`,
        label: () => `生成 · 约 ${cost() || '…'}`,
        confirmLabel: () => `确认付费 · ${cost()}`,
        reason: () => reason(!est ? '正在读取费用' : !est.ok ? '标记后的句子不符，去掉标记必须与原句一致' : ''),
        onConfirm: () => {
          const confirmed = est;
          if (!confirmed?.ok || !markup) return;
          const sent = markup.value;
          env.act(async () => {
            try {
              await env.exact(
                `feedback:${env.target}:${slot.slotKey}`,
                {
                  requestId: crypto.randomUUID(),
                  slotKey: slot.slotKey,
                  acknowledgeMicros: confirmed.estimateMicros,
                  feedback: usedFeedback,
                  markup: sent,
                },
                (input) => env.api.takeGenerate(env.target, input),
              );
            } catch (error) {
              if (!env.gone()) await reload().catch(() => undefined);
              throw error;
            }
            if (env.gone()) return;
            await reload();
            env.status('已加一条按反馈录的。请试听。');
          });
        },
      });
      paid.root.classList.add('vc-gen');
      result.append(paid.root);
      env.paint({ node: paid.root, paint: () => paid.refresh() });
      markup.addEventListener('input', refreshEstimate);
      refreshEstimate();
    }
  }

  /** 上传: choosing a file never uploads by itself. The file name appears with the rights tick and an explicit 上传 button. */
  function upload(bar: HTMLElement, slot: Slot) {
    const file = el('input');
    file.type = 'file';
    file.accept = '.wav,audio/wav';
    const pick = el('label');
    pick.className = 'ad-file vc-pick';
    file.className = 'ad-file-input';
    const label = el('span', `选择${slotName(slot, slotIndexOf(slot))} WAV`);
    label.className = 'ad-file-button';
    pick.append(label, file);
    env.guard(file, () => env.dirty() || !env.can('materials'));
    bar.append(pick);
    const chosen = el('div');
    chosen.className = 'vc-chosen';
    chosen.hidden = true;
    bar.append(chosen);
    const name = el('span', '');
    name.className = 'vc-meta';
    chosen.append(name);
    const rights = env.guard(
      check(chosen, '这是我有权使用的成品，不是待克隆的原始声音样本'),
      () => env.dirty() || !env.can('materials'),
    );
    const send = env.button(
      chosen,
      '上传',
      () => env.dirty() || !env.can('materials') || !rights.checked || file.files?.length !== 1,
      async () => {
        const selected = file.files?.[0];
        if (!selected || selected.size > 6_000_000) throw new AdminFormError('请选择一条不超过 6 MB 的成品 WAV。');
        const bytes = new Uint8Array(await selected.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        await env.api.takeUpload(env.target, slot.slotKey, btoa(binary));
        if (env.gone()) return;
        await reload();
        env.status('已加一条上传的。请试听。');
      },
    );
    send.className = 'admin-primary vc-small';
    file.addEventListener('change', () => {
      name.textContent = file.files?.[0]?.name ?? '';
      chosen.hidden = !file.files?.length;
      env.sync();
    });
    rights.addEventListener('change', env.sync);
  }
  const slotIndexOf = (slot: Slot) => (state?.slots ?? []).findIndex((item) => item.slotKey === slot.slotKey);

  let refreshApproval: (() => void) | null = null;
  /** Per-slot ticks side by side, 全选, one 批准. A slot's tick opens once its 选用 take played to the end. */
  function approval(current: ClipTakes) {
    refreshApproval = null;
    const todo = current.slots.filter((slot) => slot.selectedTakeId && !slot.approved);
    if (!current.slots.length || !current.slots.some((slot) => slot.selectedTakeId)) return;
    const bar = el('div');
    bar.className = 'vc-approval';
    root.append(bar);
    // order: 全选, the slot ticks, the rights tick, 批准
    const all = env.guard(check(bar, '全选'), () => env.dirty() || !env.can('approve-materials'));
    const ticks = el('div');
    ticks.className = 'vc-ticks';
    bar.append(ticks);
    const boxes = new Map<string, HTMLInputElement>();
    const slotIndex = new Map(current.slots.map((slot, index) => [slot.slotKey, index]));
    for (const slot of current.slots) {
      const heardNow = () => !!slot.selectedTakeId && heard.has(slot.selectedTakeId);
      // A slot opens for ticking once its 选用 take played to the end; an approved one stays ticked and closed.
      const box = env.guard(
        check(ticks, slotName(slot, slotIndex.get(slot.slotKey)!)),
        () => env.dirty() || !env.can('approve-materials') || slot.approved || !heardNow(),
      );
      box.dataset.slot = slot.slotKey;
      const wrap = box.parentElement as HTMLElement;
      wrap.classList.add('vc-tick');
      boxes.set(slot.slotKey, box);
      if (slot.approved) box.checked = true;
      hoverValue(wrap, slot.approved ? '已批准' : '听完这一条的选用版本后才能勾选');
    }
    const rights = env.guard(
      check(bar, '我确认有权使用这个音色和成品'),
      () => env.dirty() || !env.can('approve-materials'),
    );
    const playable = () => todo.filter((slot) => heard.has(slot.selectedTakeId!));
    const apply = () => {
      for (const slot of current.slots) {
        const box = boxes.get(slot.slotKey)!;
        if (!slot.approved && !(slot.selectedTakeId && heard.has(slot.selectedTakeId))) box.checked = false;
      }
    };
    all.addEventListener('change', () => {
      for (const slot of playable()) boxes.get(slot.slotKey)!.checked = all.checked;
      env.sync();
    });
    const chosen = () => todo.filter((slot) => boxes.get(slot.slotKey)!.checked && heard.has(slot.selectedTakeId!));
    const go = env.button(
      bar,
      '批准',
      () => env.dirty() || !env.can('approve-materials') || !rights.checked || chosen().length === 0,
      async () => {
        await env.api.takeApprove(
          env.target,
          chosen().map((slot) => ({ slotKey: slot.slotKey, takeId: slot.selectedTakeId! })),
        );
        if (env.gone()) return;
        await reload();
        env.status('已批准所选位置；尚未发布角色。');
      },
    );
    go.className = 'admin-primary';
    refreshApproval = () => {
      apply();
      env.sync();
    };
    for (const box of [...boxes.values(), rights]) box.addEventListener('change', env.sync);
    env.paint({ node: bar, paint: apply });
    apply();
  }

  return { load, root };
}
