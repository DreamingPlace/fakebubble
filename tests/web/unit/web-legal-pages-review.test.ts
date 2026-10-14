import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Part 19 (item 4): the two privacy-policy statements about transcript review. The pages are static files that cannot vary with
// CHAT_REVIEW_ENABLED, so both sentences are in the page unconditionally (true once the flag is on, and it is on at launch).
const html = readFileSync('apps/player-web/src/legal/privacy.html', 'utf8');
const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const section = (n: number) => {
  const start = html.indexOf(`<h2>${n}. `);
  const next = html.indexOf('<h2>', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
};
const plain = (value: string) => value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

test('privacy section 2: after 聊天内容和“记忆”, the testing-period statement is there, word for word', () => {
  const two = section(2);
  const items = [...two.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => plain(m[1]!));
  const chat = items.findIndex((item) => item.startsWith('聊天内容和“记忆”'));
  assert.ok(chat >= 0);
  assert.equal(
    items[chat + 1],
    '测试期间：为了调整角色的说话方式，管理员可以查看聊天全文。查看时只显示一个匿名编号（例如 JOJO-AX01），不显示你的邮箱、昵称或账号；但如果你在聊天里提到能认出你的信息，管理员可能认出你。账号或体验数据删除后，聊天文字仍以匿名编号保留 180 天供改进角色，之后自动删除。',
  );
});

test('privacy section 5: the 180-day sentence, and the account, email, nickname, memories, voice and co-creation content still go immediately', () => {
  const five = plain(section(5));
  assert.ok(five.includes('账号或体验数据删除后，聊天文字仍以匿名编号保留 180 天供改进角色，之后自动删除。'));
  const immediate = five.slice(five.indexOf('你随时可以删除'));
  assert.match(immediate, /账号、邮箱、昵称、记忆、语音、共创内容和登录信息会立即删除/);
  // The chat text is the one thing that is not deleted at once, and the page says so instead of promising otherwise.
  assert.ok(!/聊天、记忆、语音、共创内容、昵称和登录信息会立即删除/.test(five));
});

test('the page does not promise more than the system does: only anonymous codes, never an account, are shown to the administrator', () => {
  assert.ok(text.includes('只显示一个匿名编号'));
  assert.ok(text.includes('不显示你的邮箱、昵称或账号'));
  assert.ok(!/管理员可以查看你的(邮箱|昵称)/.test(text));
});
