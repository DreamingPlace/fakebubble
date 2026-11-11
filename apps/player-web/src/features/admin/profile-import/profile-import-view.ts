import { InviteLocalApiError } from '../../../services/invite-local-api.ts';
import { h } from '../../cocreation/h.ts';
import { statusBadge, type BadgeTone } from '../ui/status-badge.ts';

/**
 * Part 24b-7: it is an inline panel under the title row (no drawer): three steps, 选择文件 → 预览 → 确认导入 (the panel's one solid
 * button), and the result stays in the panel until it is closed.
 *
 * Part 24j: 角色工作台 → 导入角色资料. Choose one or more .md files, read the preview (nothing is written), then confirm. The preview
 * says, per character, whether it is new / existing / 将绑定代码, every change old → new, the checklist of what cannot be stored
 * yet, and every error or warning with its place. Any error blocks the whole import.
 */
export type ImportChange = { field: string; old: string; new: string };
export type ImportProblem = {
  code: string;
  file: string;
  section: string | null;
  field: string | null;
  item: number | null;
  text: string;
};
export type ImportCharacter = {
  file: string;
  code: string;
  mode: 'new' | 'existing' | 'bind';
  name: string;
  changes: ImportChange[];
  castChanges: ImportChange[];
  checklist: { key: string; text: string }[];
  unchanged: boolean;
};
export type ImportPreview = {
  ok: boolean;
  unchanged: boolean;
  basis: unknown;
  characters: ImportCharacter[];
  castChangeCount: number;
  problems: ImportProblem[];
  warnings: ImportProblem[];
};
export type ImportResult = {
  unchanged: boolean;
  characters: { code: string; mode: 'new' | 'existing' | 'bind'; changed: boolean; revision: number | null }[];
  castRevision: number | null;
};
export type ImportFile = { name: string; text: string };
export interface ProfileImportApi {
  profileImportPreview(files: ImportFile[]): Promise<ImportPreview>;
  profileImportApply(input: { requestId: string; files: ImportFile[]; basis: unknown }): Promise<ImportResult>;
}
export const IMPORT_FILE_CHARS = 60_000;
export const IMPORT_FILES = 20;

const MODE: Record<ImportCharacter['mode'], [string, BadgeTone]> = {
  new: ['新角色', 'ok'],
  existing: ['已有角色', 'neutral'],
  bind: ['将绑定代码', 'warn'],
};
/** Where a problem is: 文件 · 分区 · 字段 · 第 N 项. */
export const placeOf = (p: ImportProblem) =>
  [p.file, p.section, p.field, p.item !== null ? `第 ${p.item} 项` : null].filter((x) => x).join(' · ');

export function profileImportView(
  parent: HTMLElement,
  host: {
    api: ProfileImportApi;
    run: (work: () => Promise<void>) => Promise<void>;
    toast: (text: string, tone?: BadgeTone) => void;
    /** Called after an import that changed something: the shell reloads the roles and the open role. */
    onImported: () => Promise<void> | void;
    disposed: () => boolean;
  },
) {
  const picker = h('input', {
    attrs: { type: 'file', multiple: '', accept: '.md,text/markdown,text/plain' },
  }) as HTMLInputElement;
  picker.hidden = true;
  const choose = h('button', { class: 'admin-secondary', text: '选择 .md 文件', attrs: { type: 'button' } });
  const chosenLine = h('span', { class: 'pi-chosen' });
  const result = h('div', { class: 'pi-result' });
  const confirm = h('button', { class: 'admin-primary', text: '确认导入', attrs: { type: 'button' } });
  const closeButton = h('button', { class: 'admin-secondary', text: '关闭', attrs: { type: 'button' } });
  const foot = h('div', { class: 'pi-foot', hidden: true }, confirm);
  const STEPS = ['选择文件', '预览', '确认导入'] as const;
  const steps = h(
    'ol',
    { class: 'pi-steps', attrs: { 'aria-label': '导入步骤' } },
    ...STEPS.map((text) => h('li', { text })),
  );
  const body = h('div', { class: 'pi-body' }, h('div', { class: 'pi-pick' }, choose, chosenLine, picker), result, foot);
  const panel = h(
    'section',
    { class: 'pi-panel', hidden: true, attrs: { 'aria-label': '导入角色资料' } },
    h('header', { class: 'pi-head' }, h('h3', { text: '导入角色资料' }), steps, closeButton),
    body,
  );
  // `parent` is a row of its own under the title row (the page puts it above the rail and the editor).
  parent.append(panel);
  let isOpen = false;
  /** Which step the panel is on (0 选择文件, 1 预览, 2 确认导入 = the result stays here). */
  const stepTo = (index: number) =>
    Array.from(steps.children).forEach((li, i) => {
      li.setAttribute('data-state', i < index ? 'done' : i === index ? 'now' : 'next');
      if (i === index) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  stepTo(0);
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape' && panel.contains(document.activeElement)) api.close();
  };
  let files: ImportFile[] = [];
  let shown: ImportPreview | null = null;
  let requestId = '';

  function reset() {
    files = [];
    shown = null;
    result.replaceChildren();
    chosenLine.textContent = '';
    foot.hidden = true;
    picker.value = '';
    choose.textContent = '选择 .md 文件';
    stepTo(0);
  }
  const section = (title: string, tone: BadgeTone | null, ...nodes: (Node | null)[]) =>
    h('section', { class: 'pi-block', attrs: tone ? { 'data-tone': tone } : {} }, h('h4', { text: title }), ...nodes);
  const problemList = (list: ImportProblem[]) =>
    h(
      'ul',
      { class: 'pi-problems' },
      ...list.map((p) =>
        h('li', {}, h('span', { class: 'pi-place', text: placeOf(p) }), h('span', { class: 'pi-text', text: p.text })),
      ),
    );
  /** Nothing there yet (a new character): two columns. Otherwise 现在 → 导入后. */
  const changeTable = (rows: ImportChange[], first: string) => {
    const fresh = rows.every((row) => row.old === '');
    return h(
      'table',
      { class: fresh ? 'pi-changes pi-fresh' : 'pi-changes' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: first }),
          ...(fresh ? [] : [h('th', { text: '现在' })]),
          h('th', { text: '导入后' }),
        ),
      ),
      h(
        'tbody',
        {},
        ...rows.map((row) =>
          h(
            'tr',
            {},
            h('th', { text: row.field, attrs: { scope: 'row' } }),
            ...(fresh
              ? []
              : [
                  h('td', {
                    class: row.old === '' ? 'pi-none' : '',
                    text: row.old === '' ? '（空）' : row.old,
                    attrs: { title: row.old },
                  }),
                ]),
            h('td', { text: row.new, attrs: { title: row.new } }),
          ),
        ),
      ),
    );
  };

  function paint() {
    result.replaceChildren();
    const preview = shown;
    foot.hidden = !preview;
    stepTo(preview ? 1 : 0);
    if (!preview) return;
    if (preview.problems.length)
      result.append(
        section(`${preview.problems.length} 个错误：整次导入被阻止，请改文件`, 'danger', problemList(preview.problems)),
      );
    if (preview.warnings.length)
      result.append(section(`${preview.warnings.length} 条提醒`, 'warn', problemList(preview.warnings)));
    for (const character of preview.characters) {
      const [label, tone] = MODE[character.mode];
      const head = h(
        'header',
        { class: 'pi-card-head' },
        statusBadge(character.mode === 'bind' ? `${label} ${character.code}` : label, tone),
        h('strong', { text: character.name }),
        h('code', { class: 'pi-code', text: character.code }),
        h('span', { class: 'pi-file', text: character.file }),
      );
      const card = h('article', { class: 'pi-card' }, head);
      if (character.unchanged) card.append(h('p', { class: 'pi-none', text: '没有变化' }));
      else {
        if (character.changes.length) card.append(changeTable(character.changes, '角色工作台'));
        if (character.castChanges.length) card.append(changeTable(character.castChanges, '关系与故事'));
      }
      if (character.checklist.length)
        card.append(
          h(
            'div',
            { class: 'pi-checklist' },
            h('h5', { text: '待办清单' }),
            h('ul', {}, ...character.checklist.map((c) => h('li', { text: c.text }))),
          ),
        );
      result.append(card);
    }
    if (preview.ok && preview.unchanged)
      result.append(h('p', { class: 'pi-none', text: '没有变化：这些文件和现在的草稿完全一致。' }));
    // The page re-enables every control after a run; data-locked keeps this one off while there is an error or nothing to do.
    const off = !preview.ok || preview.unchanged;
    confirm.dataset.locked = String(off);
    confirm.disabled = off;
    confirm.title = !preview.ok ? '先解决上面的错误' : preview.unchanged ? '没有变化' : '';
    // The reason is a hover tip on the (off) button, never a sentence beside it.
  }

  /** The result stays in the panel (step 3) until it is closed: one row per character, what happened to it. */
  function showDone(preview: ImportPreview, done: ImportResult) {
    shown = null;
    result.replaceChildren();
    foot.hidden = true;
    stepTo(2);
    const nameOf = (code: string) => preview.characters.find((c) => c.code === code)?.name ?? code;
    const rows = done.characters.map((c) =>
      h(
        'li',
        {},
        statusBadge(MODE[c.mode][0], MODE[c.mode][1]),
        h('strong', { text: nameOf(c.code) }),
        h('code', { class: 'pi-code', text: c.code }),
        h('span', {
          class: 'pi-file',
          text: c.changed ? (c.revision === null ? '已导入' : `草稿修订 ${c.revision}`) : '没有变化',
        }),
      ),
    );
    result.append(
      section(
        done.unchanged ? '没有变化' : '已导入，还没有发布',
        done.unchanged ? null : 'ok',
        h('ul', { class: 'pi-done' }, ...rows),
      ),
    );
    chosenLine.textContent = '';
    choose.textContent = '再导入一批';
    picker.value = '';
  }
  async function read(list: File[]) {
    if (list.length > IMPORT_FILES) return host.toast(`一次最多 ${IMPORT_FILES} 个文件。`, 'warn');
    const loaded: ImportFile[] = [];
    for (const file of list) {
      const text = await file.text();
      if (text.length > IMPORT_FILE_CHARS)
        return host.toast(`${file.name} 超过 ${IMPORT_FILE_CHARS} 字，没有读取。`, 'warn');
      loaded.push({ name: file.name, text });
    }
    files = loaded;
    chosenLine.textContent = `已选 ${loaded.length} 个文件`;
    await refresh();
  }
  async function refresh() {
    requestId = globalThis.crypto.randomUUID();
    await host.run(async () => {
      const preview = await host.api.profileImportPreview(files);
      if (host.disposed()) return;
      shown = preview;
      paint();
    });
  }
  choose.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const chosen = Array.from(picker.files ?? []);
    if (chosen.length) void read(chosen);
  });
  closeButton.addEventListener('click', () => api.close());
  confirm.addEventListener('click', () => {
    const preview = shown;
    if (!preview?.ok || preview.unchanged) return;
    void host.run(async () => {
      try {
        const done = await host.api.profileImportApply({ requestId, files, basis: preview.basis });
        if (host.disposed()) return;
        const count = done.characters.filter((c) => c.changed).length;
        showDone(preview, done);
        host.toast(done.unchanged ? '没有变化。' : `已导入 ${count} 个角色的草稿。还没有发布。`, 'ok');
        await host.onImported();
      } catch (error) {
        const code = error instanceof InviteLocalApiError ? error.code : '';
        if (code === 'PROFILE_IMPORT_CONFLICT') {
          host.toast('预览之后草稿被改过，这次没有导入。已重新预览。', 'warn');
          await refresh();
          return;
        }
        if (code === 'PROFILE_IMPORT_INVALID') {
          host.toast('文件有问题，没有导入。', 'warn');
          await refresh();
          return;
        }
        throw error;
      }
    });
  });
  const api = {
    open() {
      if (isOpen) return;
      isOpen = true;
      reset();
      panel.hidden = false;
      document.addEventListener('keydown', onKey);
      panel.scrollIntoView?.({ block: 'nearest' });
      choose.focus();
    },
    close() {
      if (!isOpen) return;
      isOpen = false;
      panel.hidden = true;
      document.removeEventListener('keydown', onKey);
      reset();
    },
    /** Test seam. */
    chooseFiles: (list: ImportFile[]) => {
      files = list;
      return refresh();
    },
    dispose() {
      isOpen = false;
      document.removeEventListener('keydown', onKey);
      panel.remove();
    },
  };
  return api;
}
