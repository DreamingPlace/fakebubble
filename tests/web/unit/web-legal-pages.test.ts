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

test('every fact the owner must confirm is marked 【待确认：…】, and the unfinished-draft banner is there', () => {
  for (const name of ['privacy.html', 'terms.html']) {
    const html = read(name);
    const marked = [...html.matchAll(/<span class="legal-todo">([^<]*)<\/span>/g)].map((m) => m[1]!);
    assert.ok(marked.length >= 4, `${name} has marked items`);
    for (const item of marked) assert.match(item, /^【待确认：[^【】]+】$/, item);
    assert.match(html, /class="legal-draft"/);
    // Any 待确认 outside a marked span would be an unmarked placeholder.
    assert.equal((html.match(/待确认/g) ?? []).length, marked.length + (html.match(/“待确认”/g) ?? []).length);
  }
  const joined = text(read('privacy.html')) + text(read('terms.html'));
  for (const required of ['运营者名称', '联系邮箱', '适用法律与管辖地区', '生效日期'])
    assert.ok(joined.includes(`【待确认：${required}`), `${required} is marked for the owner`);
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
