import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

/**
 * Part 24b-7d round 2: the words of the admin console, checked in the source (every user-visible string literal that holds Chinese):
 *   env      no environment-variable name inside a sentence (it may be a hover: a line that calls hoverValue is exempt)
 *   migration no migration number inside a sentence
 *   terms    one word for one thing (docs/ADMIN_COPY.md): 草稿 (not 修订 / 服务器草稿), 正式版本 (not 现行), 角色 (not 人物; 人物 stays in the
 *            关系与故事 cast, where it is the story's word for a person in it)
 *   id       「ID」 is not a visible label (编号 / 代码 / 音色编号)
 * Named exceptions: a download file name keeps the old word (it is not shown in the console).
 */
const root = new URL('../../../apps/player-web/src/features/admin/', import.meta.url);
const files = (dir: URL): URL[] =>
  readdirSync(dir).flatMap((name) => {
    const url = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? '/' : ''), dir);
    return name.endsWith('.ts') ? [url] : statSync(url).isDirectory() ? files(url) : [];
  });
const CJK = /[一-鿿]/;
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
type Hit = { rule: string; where: string; text: string };

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of files(root)) {
    const rel = file.pathname.slice(root.pathname.length);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const match of line.matchAll(LITERAL)) {
        const text = match[1] ?? match[2] ?? match[3] ?? '';
        if (!CJK.test(text)) continue;
        const where = `${rel}:${index + 1}`;
        const add = (rule: string) => hits.push({ rule, where, text: text.slice(0, 60) });
        const plain = text.replace(/\$\{[^}]*\}/g, ''); // an interpolated constant is not shown as its name
        if (/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/.test(plain) && !line.includes('hoverValue(')) add('env');
        if (/迁移 ?\d+/.test(text)) add('migration');
        const fileName = /\.json|\.csv/.test(text); // named exception: a download file name
        if (!fileName && (/修订|服务器草稿|现行/.test(text) || (!rel.startsWith('cast/') && /人物/.test(text))))
          add('terms');
        if (/(^|[^A-Za-z])ID([^A-Za-z]|$)/.test(text)) add('id');
      }
    });
  }
  return hits;
}

for (const rule of ['env', 'migration', 'terms', 'id']) {
  test(`24b-7d round 2 copy: no ${rule} violation in the console's sentences`, () => {
    assert.deepEqual(
      scan()
        .filter((h) => h.rule === rule)
        .map((h) => `${h.where}  ${h.text}`),
      [],
    );
  });
}
