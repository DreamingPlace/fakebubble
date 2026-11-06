import { InviteLocalApiError } from '../../../services/invite-local-api.ts';
import { h } from '../../cocreation/h.ts';
import { drawer } from '../ui/drawer.ts';
import { statusBadge, type BadgeTone } from '../ui/status-badge.ts';

/**
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
  const panel = drawer(parent, { title: '导入角色资料', wide: true, onClose: () => reset() });
  const picker = h('input', {
    attrs: { type: 'file', multiple: '', accept: '.md,text/markdown,text/plain' },
  }) as HTMLInputElement;
  picker.hidden = true;
  const choose = h('button', { class: 'admin-secondary', text: '选择 .md 文件', attrs: { type: 'button' } });
  const chosenLine = h('span', { class: 'pi-chosen' });
  const result = h('div', { class: 'pi-result' });
  const confirm = h('button', { class: 'admin-primary', text: '确认导入', attrs: { type: 'button' } });
  const cancel = h('button', { class: 'admin-secondary', text: '取消', attrs: { type: 'button' } });
  const foot = h('div', { class: 'pi-foot', hidden: true }, confirm, cancel);
  panel.body.append(h('div', { class: 'pi-pick' }, choose, chosenLine, picker), result, foot);
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
  const changeTable = (rows: ImportChange[], first: string) =>
    h(
      'table',
      { class: 'pi-changes' },
      h('thead', {}, h('tr', {}, h('th', { text: first }), h('th', { text: '现在' }), h('th', { text: '导入后' }))),
      h(
        'tbody',
        {},
        ...rows.map((row) =>
          h(
            'tr',
            {},
            h('th', { text: row.field, attrs: { scope: 'row' } }),
            h('td', {
              class: row.old === '' ? 'pi-none' : '',
              text: row.old === '' ? '（空）' : row.old,
              attrs: { title: row.old },
            }),
            h('td', { text: row.new, attrs: { title: row.new } }),
          ),
        ),
      ),
    );

  function paint() {
    result.replaceChildren();
    const preview = shown;
    foot.hidden = !preview;
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
    confirm.disabled = !preview.ok || preview.unchanged;
    confirm.title = !preview.ok ? '先解决上面的错误' : preview.unchanged ? '没有变化' : '';
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
  cancel.addEventListener('click', () => panel.close());
  confirm.addEventListener('click', () => {
    const preview = shown;
    if (!preview?.ok || preview.unchanged) return;
    void host.run(async () => {
      try {
        const done = await host.api.profileImportApply({ requestId, files, basis: preview.basis });
        if (host.disposed()) return;
        const count = done.characters.filter((c) => c.changed).length;
        panel.close();
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
  return {
    open: () => panel.open(),
    /** Test seam. */
    chooseFiles: (list: ImportFile[]) => {
      files = list;
      return refresh();
    },
    dispose: () => panel.dispose(),
  };
}
