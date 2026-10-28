import type { CastDoc } from './web-cast.ts';

/**
 * How cast validation problems are spelled for people (the 关系与故事 page, the cast file import and scripts/cast-file.ts share it):
 * a code becomes a sentence, and a path of ids and indexes becomes the character's name, the story's title, the group's name.
 */
export function nameOf(doc: CastDoc, id: string): string {
  // Defensive about shape: the cast file import also names things in a document that has not passed the shape check yet.
  const character = doc.characters?.find?.((c) => c?.characterId === id);
  if (character) return character.identity?.names?.[0]?.text ?? id;
  return doc.people?.find?.((p) => p?.id === id)?.names?.[0]?.text ?? id;
}

/** Friendly spelling of the codes validation returns; a code this table does not know is shown as it is. */
export const ISSUE_LABEL: Record<string, string> = {
  CAST_SHAPE: '内容格式或长度不符',
  CAST_DUPLICATE_ID: '重复的编号',
  CAST_UNKNOWN_CHARACTER: '引用了阵容里没有的角色',
  CAST_UNKNOWN_PERSON: '引用了不存在的人物',
  CAST_SELF_RATING: '不能给自己评分',
  CAST_SELF_RELATION: '不能给自己写称呼和相处',
  CAST_RATING_OUT_OF_GRID: '评分必须在 0–5 星、以半星为单位',
  CAST_DUPLICATE_DIRECTION: '同一个方向写了两份称呼和相处',
  CAST_DUPLICATE_MEMBER: '组合里有重复的成员',
  CAST_DUPLICATE_PARTICIPANT: '故事里有重复的参与者',
  CAST_DUPLICATE_OVERRIDE: '同一个角色有两条手动设置',
  CAST_PERIOD_ORDER: '时间段的开始晚于结束',
  CAST_CHARACTER_MISSING: '角色还没有建立',
  CAST_CHARACTER_DELETED: '角色已被删除',
  CAST_VIEW_TOO_LARGE: '这个角色看到的内容太长',
  CAST_DOC_TOO_LARGE: '整份资料太长',
  CAST_EMPTY: '阵容里还没有角色',
  CAST_GROUP_TOO_SMALL: '组合不足两人',
  CAST_DUPLICATE_NAME: '有角色重名',
  CAST_FILE_HEADER: '文件头不对（应为 format "burbur-cast"、version 1）',
  CAST_FILE_NEW_KEY: '新角色的临时编号写法不对（应为 new:名字）',
  CAST_FILE_WORKBENCH: '角色工作台资料不符合要求',
  CAST_FILE_WORKBENCH_IGNORED: '已有角色的工作台资料不会被文件改动，这一段被忽略',
  CAST_FILE_NEW_UNDEFINED: '用了 new:… 的新角色，但文件里没有这个角色',
  CAST_FILE_NO_CREATE: '没有新建角色的权限，文件里却有新角色',
  CAST_FILE_UNKNOWN_ID: '文件里的编号在当前草稿里找不到',
};

const FIELD_LABEL: Record<string, string> = {
  identity: '身份',
  names: '名字',
  aliases: '别名',
  oneLiner: '一句话',
  selfConcept: '自我认知',
  profile: '简介',
  personality: '性格',
  speech: '说话方式',
  catchphrases: '口头禅',
  samples: '说话样例',
  avoid: '不会这样说',
  experiences: '经历',
  performance: '演绎说明',
  hidden: '不公开设定',
  members: '成员',
  participants: '参与者',
  overrides: '手动设置',
  period: '时间段',
  title: '标题',
  summary: '概要',
  details: '细节',
  boundary: '叙述边界',
  background: '背景',
  name: '名称',
  from: '谁',
  to: '对谁',
  address: '称呼',
  treatment: '相处',
};
/**
 * An issue's path ("characters[c01].identity.names", "stories[2].participants[1]") as people read it: ids and indexes become the
 * character's name, the story's title or the group's name. `who` is the character it is about (null: nothing in particular), so
 * the page can group a long list by character.
 */
export function humanIssue(doc: CastDoc, rawPath: string): { who: string | null; where: string } {
  const pick = <T>(list: T[], key: string, idOf: (item: T) => string): T | undefined =>
    list.find((item) => idOf(item) === key) ?? (/^\d+$/.test(key) ? list[Number(key)] : undefined);
  // A shape problem is reported against the whole document ("doc.characters[2].profile"); "doc" is not a part of the cast.
  const path = rawPath.replace(/^doc\.?/, '');
  let who: string | null = null;
  const parts: string[] = [];
  for (const [, head, key = '', rest = ''] of path.matchAll(/([A-Za-z]+)(?:\[([^\]]*)\])?((?:\.[A-Za-z]+)*)/g)) {
    if (head === 'characters' || head === 'people') {
      const character = pick(doc.characters, key, (c) => c.characterId);
      const person = pick(doc.people, key, (p) => p.id);
      const label = nameOf(doc, character?.characterId ?? person?.id ?? key);
      if (head === 'characters') who ??= label;
      else parts.push(label);
    } else if (head === 'groups') {
      const group = pick(doc.groups, key, (g) => g.id);
      parts.push(group ? `组合「${group.name}」` : '组合');
    } else if (head === 'stories') {
      const story = pick(doc.stories, key, (g) => g.id);
      parts.push(story ? `故事「${story.title}」` : '故事');
    } else if (head === 'ratings') {
      if (key) who ??= nameOf(doc, key);
      parts.push('星级');
    } else if (head === 'directions') {
      // the key is the entry's id (or its index); the entry belongs to the character it is FROM
      const direction = pick(doc.directions, key, (d) => d.id);
      if (direction) who ??= nameOf(doc, direction.from);
      parts.push('称呼与相处');
    } else if (head) {
      const label = FIELD_LABEL[head];
      if (label) parts.push(label);
      else if (key) parts.push(nameOf(doc, key));
    }
    for (const field of rest.split('.').filter(Boolean)) if (FIELD_LABEL[field]) parts.push(FIELD_LABEL[field]!);
  }
  return { who, where: parts.join(' · ') };
}
