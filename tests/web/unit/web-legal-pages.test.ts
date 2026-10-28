import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildWebPlayer } from '../../../scripts/build-web-player.ts';

const read = (name: string) => readFileSync(`apps/player-web/src/legal/${name}`, 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

test('both legal pages are static Chinese documents with no script, linked to each other', () => {
  for (const [name, other] of [
    ['privacy.html', 'terms.html'],
    ['terms.html', 'privacy.html'],
  ] as const) {
    const html = read(name);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="zh-CN">/);
    assert.doesNotMatch(html, /<script|javascript:|\son[a-z]+\s*=/i, 'static: nothing executes');
    assert.doesNotMatch(html, /https?:\/\//, 'no external resource or link');
    assert.ok(html.includes(`href="/${other}"`), `${name} links ${other}`);
    assert.ok(
      html.includes('href="/apps/player-web/src/styles/main.css"'),
      'the build rewrites this to the hashed stylesheet',
    );
  }
});

// Named exception (Part 19): the test that stood here ("every fact the owner must confirm is marked 【待确认：…】, and the
// unfinished-draft banner is there") described the DRAFT stage. The owner's facts are now in the pages, so it is replaced by
// the checks below; every other legal-page test in this file is unchanged.
// Named exception (Part 24b-5): the owner renamed the operator to Burbur everywhere, so the pinned operator name and the
// "最近更新" date (the merge date of that rename) change below. Every other assertion in this test is unchanged.
test('legal pages finalized in Part 19: no 待确认, no draft banner, and the owner facts are in', () => {
  const EMAIL = 'contact@4th-generation.fans';
  for (const name of ['privacy.html', 'terms.html']) {
    const html = read(name);
    assert.ok(!html.includes('待确认'), `${name} has no 待确认`);
    assert.doesNotMatch(html, /legal-draft|legal-todo/, `${name} has no draft banner or marked placeholder`);
    // The address is there, and every occurrence of it is the visible text of (or the target of) one mailto link.
    assert.ok(html.includes(EMAIL), `${name} shows the contact address`);
    assert.equal(
      (html.match(new RegExp(EMAIL.replace(/\./g, '\\.'), 'g')) ?? []).length,
      2 *
        (
          html.match(
            new RegExp(`<a href="mailto:${EMAIL.replace(/\./g, '\\.')}">${EMAIL.replace(/\./g, '\\.')}</a>`, 'g'),
          ) ?? []
        ).length,
      `${name}: every address is a mailto link`,
    );
    const plain = text(html);
    assert.ok(plain.includes('最近更新：2026 年 10 月 28 日。自本页公开发布之日起生效。'), `${name} effective date`);
    assert.ok(plain.includes('Burbur 开源项目（个人维护，非公司主体）'), `${name} operator`);
    assert.ok(
      plain.includes('本服务由个人维护的开源项目提供。与本服务有关的问题或争议，请先通过上面的邮箱联系我们协商解决。'),
      `${name} governing law`,
    );
  }
  const policy = text(read('privacy.html')),
    terms = text(read('terms.html'));
  assert.ok(policy.includes('本服务面向 18 周岁及以上用户，未满 18 周岁请勿使用。'), 'privacy: 18+');
  assert.ok(policy.includes('我们会在 15 个工作日内回复。'), 'privacy: response time');
  assert.ok(
    policy.includes(
      'DeepSeek 位于中国大陆；Cloudflare 和 Fish Audio 的服务器可能位于中国大陆以外。使用本服务即表示你同意你的消息被发送到这些地区处理。各处理方对数据的保留和使用以其自己的服务条款和隐私政策为准；我们不会授权任何一方用你的聊天内容训练模型。',
    ),
    'privacy: cross-border and no training',
  );
  assert.ok(
    terms.includes(
      '你的聊天内容不会用于训练任何 AI 模型。我们可能以匿名编号查看聊天内容，用于改进角色的说话方式（详见《隐私政策》）。',
    ),
    'terms: no training',
  );
  assert.ok(terms.includes('免责声明') && terms.includes('在法律允许的范围内'), 'terms: the disclaimer stays');
});

test('the privacy policy covers what is collected, why, the processors, AI replies, retention, minors and contact', () => {
  const policy = text(read('privacy.html'));
  for (const topic of [
    '邮箱',
    '昵称',
    '聊天内容',
    '语音',
    'IP 地址的哈希值', // what is collected
    '提供聊天服务',
    '限制滥用', // why
    'Cloudflare',
    'DeepSeek',
    'Fish Audio', // the processors
    '回复由人工智能生成', // AI generated
    '再保留 7 天',
    '180 天',
    '删除我的账号',
    '清除本设备的体验数据', // retention and deletion
    '未成年人',
    '联系', // minors, contact
  ])
    assert.ok(policy.includes(topic), `privacy policy mentions ${topic}`);
  // It never promises more than the system does: the raw address is not stored, and passwords are one-way.
  assert.match(policy, /不保存原始地址/);
  assert.match(policy, /单向加密/);
});

test('the user agreement covers the service, accounts and invites, conduct, content, termination and liability', () => {
  const terms = text(read('terms.html'));
  for (const topic of [
    '人工智能生成',
    '最多 5 条回复',
    '再送 10 条免费消息',
    '每天最多完成 3 次注册',
    '邀请码',
    '批量注册',
    '你的内容',
    '删除账号',
    '免责声明',
    '《隐私政策》',
    '适用法律',
  ])
    assert.ok(terms.includes(topic), `user agreement mentions ${topic}`);
});

test('the player build ships both pages as pinned static files with the hashed stylesheet', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'legal-build-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  buildWebPlayer({ root: resolve('.'), output });
  const manifest = JSON.parse(readFileSync(join(output, 'player-manifest.json'), 'utf8')) as {
    files: Record<string, string>;
  };
  for (const name of ['privacy.html', 'terms.html']) {
    assert.ok(manifest.files[name], `${name} is in the manifest`);
    const html = readFileSync(join(output, name), 'utf8');
    assert.match(html, /href="\/assets\/static-[a-f0-9]{64}\.css"/);
    assert.ok(!html.includes('/apps/player-web/src/'));
  }
  assert.ok(readdirSync(output).includes('index.html'));
});
