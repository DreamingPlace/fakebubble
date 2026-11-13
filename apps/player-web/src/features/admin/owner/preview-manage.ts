import type { OwnerAdminClient } from '../../../services/owner-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import type { ConfirmInPlace } from '../ui/inline-confirm.ts';

export const previewManageCopy = {
  open: '整理预演',
  done: '完成',
  all: '全选',
  none: '清除选择',
  delete: '删除所选…',
  picked: (n: number) => `已选 ${n} 项`,
  title: '删除预演',
  confirm: (runs: number, singles: number, previews: number) =>
    `永久删除所选的${runs ? ` ${runs} 个运行` : ''}${runs && singles ? '和' : ''}${singles ? ` ${singles} 条单次预演` : ''}（共 ${previews} 条）？输入、结果和试听音频无法恢复；费用记录只保留数量。`,
  go: (previews: number) => `永久删除 ${previews} 条`,
  deleted: (previews: number) => `已删除 ${previews} 条预演。`,
  busy: '运行中的预演不能选择。',
  pick: '选择删除',
};
export type ManageTarget = {
  key: string;
  el: HTMLElement;
  slot: HTMLElement;
  previews: number;
  busy: boolean;
  isRun: boolean;
};

/**
 * Part 31 (C): the owner deletes 预演 records, one by one or by selection. A bar above the feed turns on a checkbox on every finished
 * run and single preview; 删除所选 asks once, naming how many, in place. The server refuses the whole request while any chosen one is
 * still running, so those boxes are off. Nothing is drawn for anyone but the owner (the host omits `owner`).
 */
export function previewManage(
  bar: HTMLElement,
  deps: {
    api: Pick<OwnerAdminClient, 'deletePreviews'>;
    confirm: ConfirmInPlace;
    run: (work: () => Promise<void>) => Promise<void>;
    toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
    disposed: () => boolean;
    targets: () => ManageTarget[];
    /** After a deletion: read the character's runs again. */
    reload: () => Promise<void>;
    isOwner: () => boolean;
  },
) {
  let on = false;
  const picked = new Set<string>();
  const toggle = h('button', {
    class: 'admin-secondary',
    text: previewManageCopy.open,
    attrs: { type: 'button', 'aria-pressed': 'false' },
  });
  const count = h('span', { class: 'pm-count', attrs: { role: 'status', 'aria-live': 'polite' } });
  const all = h('button', { class: 'admin-secondary', text: previewManageCopy.all, attrs: { type: 'button' } });
  const del = h('button', {
    class: 'admin-secondary is-danger',
    text: previewManageCopy.delete,
    attrs: { type: 'button' },
  });
  const confirmHost = h('div', { class: 'pm-confirm' });
  const tools = h('div', { class: 'admin-bar pm-tools', hidden: true }, count, all, del);
  bar.append(h('div', { class: 'admin-bar' }, toggle), tools, confirmHost);
  const boxes = new Map<string, HTMLInputElement>();
  const chosen = () => deps.targets().filter((t) => picked.has(t.key) && !t.busy);
  const paint = () => {
    const mine = chosen();
    count.textContent = previewManageCopy.picked(mine.length);
    del.disabled = mine.length === 0;
    toggle.textContent = on ? previewManageCopy.done : previewManageCopy.open;
    toggle.setAttribute('aria-pressed', String(on));
    tools.hidden = !on;
  };
  /** Puts a checkbox on every target while the mode is on, and takes them all away when it is off. */
  const sync = () => {
    const live = new Set<string>();
    if (on && deps.isOwner())
      for (const t of deps.targets()) {
        live.add(t.key);
        let box = boxes.get(t.key);
        if (!box || !t.slot.contains(box.parentElement)) {
          box?.parentElement?.remove();
          box = h('input', { attrs: { type: 'checkbox', 'aria-label': previewManageCopy.pick } });
          box.addEventListener('change', () => {
            if (box!.checked) picked.add(t.key);
            else picked.delete(t.key);
            paint();
          });
          const label = h('label', { class: 'pw-tick pm-tick' }, box);
          t.slot.prepend(label);
          boxes.set(t.key, box);
        }
        box.disabled = t.busy;
        if (t.busy) box.title = previewManageCopy.busy;
        box.checked = picked.has(t.key) && !t.busy;
        t.el.dataset.pickable = 'true';
      }
    for (const [key, box] of [...boxes]) {
      if (live.has(key)) continue;
      box.parentElement?.remove();
      boxes.delete(key);
      if (!on) picked.delete(key);
    }
    if (!on) for (const t of deps.targets()) delete t.el.dataset.pickable;
    paint();
  };
  toggle.addEventListener('click', () => {
    on = !on;
    if (!on) picked.clear();
    sync();
  });
  all.addEventListener('click', () => {
    const free = deps.targets().filter((t) => !t.busy);
    if (free.every((t) => picked.has(t.key))) for (const t of free) picked.delete(t.key);
    else for (const t of free) picked.add(t.key);
    sync();
  });
  del.addEventListener(
    'click',
    () =>
      void (async () => {
        const mine = chosen();
        if (mine.length === 0) return;
        const runs = mine.filter((t) => t.isRun),
          singles = mine.filter((t) => !t.isRun);
        const previews = mine.reduce((n, t) => n + t.previews, 0);
        const yes = await deps.confirm(
          {
            title: previewManageCopy.title,
            message: previewManageCopy.confirm(runs.length, singles.length, previews),
            confirmLabel: previewManageCopy.go(previews),
          },
          confirmHost,
        );
        if (!yes || deps.disposed()) return;
        await deps.run(async () => {
          const result = await deps.api.deletePreviews({
            runIds: runs.map((t) => t.key),
            previewIds: singles.map((t) => t.key),
          });
          picked.clear();
          deps.toast(previewManageCopy.deleted(result.previews), 'ok');
          await deps.reload();
        });
      })(),
  );
  paint();
  return { sync, isOn: () => on };
}
