import { selectField, textField, type ExportField } from './export-dialog.ts';

/** Part 57: the filters the exports share, as fields of the dialog (the names the console already uses). */
export const writerField: ExportField = selectField(
  '回复写法',
  [
    { value: '', label: '全部' },
    { value: 'v7', label: '旧写法' },
    { value: 'v8', label: '新写法' },
    { value: 'v8p', label: '新+档案' },
    { value: 'v8m', label: '新+档案+梗' },
  ],
  'writer',
  '只导出用这种写法写的回复。',
);
export const modelField: ExportField = textField('模型', 'model', {
  placeholder: '例如 deepseek-v4-pro',
  tip: '写的人或审核的是这个模型（不填就是全部）。',
});
export const statusField: ExportField = selectField(
  '状态',
  [
    { value: '', label: '全部' },
    { value: 'published', label: '已发布' },
    { value: 'failed', label: '失败' },
    { value: 'unknown', label: '结果未知' },
  ],
  'status',
);
export const playersField: ExportField = textField('玩家', 'players', {
  placeholder: '对话编号最后 4 位，用空格隔开',
  list: true,
  tip: '只导出这些对话编号的玩家（不填就是全部）。',
});
