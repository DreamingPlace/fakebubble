// Local check of a cast file (Part 24b-5): `node scripts/cast-file.ts validate <file>`.
// Runs the same rules as the server's 导入文件 (apps/server/cast/cast-file.ts + cast-validation.ts) and prints every problem with its
// path and the character's name, then each character's view size against the cap. Exit code 0 only if the file can be imported
// AND published. It reads one file and writes nothing; it cannot know which existing characters the server has (see docs/CAST_FILE.md).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { prepareCastFile, idsInFile, type PreparedCastFile } from '../apps/server/cast/cast-file.ts';
import type { CastFileProblem } from '../packages/contracts/web-cast.ts';

const line = (tag: string, problem: CastFileProblem) =>
  `  ${tag} ${problem.who ? `${problem.who} · ` : ''}${problem.path} — ${problem.text} (${problem.code})`;

export function checkCastFile(text: string): { prepared: PreparedCastFile | null; output: string[]; ok: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { prepared: null, output: ['  [错误] 这不是合法的 JSON 文件。'], ok: false };
  }
  let counter = 0;
  const prepared = prepareCastFile(raw, {
    current: null,
    known: idsInFile(raw),
    // Offline there is no character table: an id that is not new is taken as existing.
    lookup: { exists: () => true, deleted: () => false },
    newId: () => `role-local${String(++counter).padStart(3, '0')}`,
  });
  const out: string[] = [];
  const { summary } = prepared;
  if (summary)
    out.push(
      `角色 ${summary.charactersAdded.length}（新 ${prepared.created.length}）· 人物 ${summary.people} · 评分 ${summary.ratings} · 称呼与相处 ${summary.directions} · 组合 ${summary.groups} · 故事 ${summary.stories} · 梗 ${summary.memes}`,
    );
  for (const p of prepared.problems) out.push(line('[错误]', p));
  for (const p of prepared.publishBlockers) out.push(line('[发布会被挡住]', p));
  for (const p of prepared.warnings) out.push(line('[提醒]', p));
  for (const view of prepared.views) {
    const over = view.size > view.max;
    out.push(
      `  视图 ${view.name}：${view.size} / ${view.max}${over ? `，超出，压缩后 ${view.finalSize}；会舍弃：${view.dropped.join('、') || '（无可舍弃，发布会被挡住）'}` : ''}`,
    );
  }
  const ok = prepared.importable && prepared.publishBlockers.length === 0;
  out.push(ok ? '结果：可以导入，也可以发布。' : '结果：还不能导入并发布，请先修正上面的问题。');
  return { prepared, output: out, ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file] = process.argv.slice(2);
  if (command !== 'validate' || !file) {
    console.error('用法：node scripts/cast-file.ts validate <file>');
    process.exit(2);
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`读不到文件：${file}`);
    process.exit(2);
  }
  console.log(`文件：${file}`);
  const { output, ok } = checkCastFile(text);
  for (const row of output) console.log(row);
  process.exit(ok ? 0 : 1);
}
