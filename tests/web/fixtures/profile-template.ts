/**
 * Part 24j: synthetic character template files (docs/CHARACTER_TEMPLATE.md) for tests and the screenshot script. Every field of the
 * contract is present; `values` overrides a field by its exact name (a relation block by `relations`). Nothing here is real data.
 */
const SECTIONS: [number, string, string[]][] = [
  [
    1,
    '基本信息',
    [
      '角色代码',
      '人设名称',
      '网页展示名／昵称',
      '自称',
      '别名（含英文名）',
      '中性称呼',
      '黑称',
      '饰演过的角色',
      '动物形象',
      '性别设定',
      '生日',
      '身高',
      '头像／形象图片文件',
      '一句话描述',
      '名片一句话',
      '音色模型 ID（Fish Audio）',
    ],
  ],
  [2, '展示与欢迎内容', ['欢迎词', '角色主色', '是否为成长中角色']],
  [
    3,
    '性格与相处方式',
    ['陌生时的相处方式', '熟悉后的变化', '表达关心的方式', '开玩笑或被调侃时的反应', '遇到冲突·拒绝·冷场时的反应'],
  ],
  [
    4,
    '语言与声音特征',
    [
      '常用词与口头禅',
      '句子长短·断句习惯',
      '称呼对方的习惯',
      '文字聊天习惯',
      '开心时怎么说',
      '低落时怎么说',
      '生气时怎么说',
      '不会使用的措辞',
    ],
  ],
  [
    5,
    '背景与生活',
    [
      '成长背景',
      '现在的生活状态',
      '兴趣·擅长的事',
      '喜欢与不喜欢的事物',
      '宠物',
      '家庭成员',
      '外貌·衣着·体态',
      '学校-年级',
    ],
  ],
  [6, '目前情况', ['现在所在地', '近况']],
  [7, '人物关系', []],
  [8, '边界与隐藏设定', ['知道但不会说出口的事', '不可改变的核心设定', '不应擅自补充的事实', '不符合角色的行为·表达']],
];
export interface Relation {
  code: string;
  cp?: string;
  addresses?: string;
  attitude?: string;
  shared?: string;
}
export function templateFile(
  values: Record<string, string>,
  relations: Relation[] = [],
  options: { omit?: string[]; extra?: Record<string, string[]>; without?: number[] } = {},
) {
  const out: string[] = ['# 合成角色资料（测试用）', ''];
  for (const [n, title, fields] of SECTIONS) {
    if (options.without?.includes(n)) continue;
    out.push(`## ${n} ${title}`, '');
    for (const field of fields) {
      if (options.omit?.includes(field)) continue;
      // 名片一句话 is optional: a file without it is an old (still valid) file, so it is written only when a test gives it.
      if (field === '名片一句话' && values[field] === undefined) continue;
      const value = values[field] ?? '';
      const lines = value.split('\n');
      out.push(`- ${field}：${lines[0]}`);
      for (const rest of lines.slice(1)) out.push(`  ${rest}`);
    }
    for (const extra of options.extra?.[String(n)] ?? []) out.push(extra);
    if (n === 7)
      relations.forEach((r, i) => {
        out.push(
          `### 关系 ${i + 1}`,
          `- 对方角色代码：${r.code}`,
          `- CP名：${r.cp ?? ''}`,
          `- 本角色如何称呼对方：${r.addresses ?? ''}`,
          `- 本角色对对方的态度：${r.attitude ?? ''}`,
          `- 相处方式及共同经历：${r.shared ?? ''}`,
          '',
        );
      });
    out.push('');
  }
  return out.join('\n');
}
