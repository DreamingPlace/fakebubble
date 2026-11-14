import assert from 'node:assert/strict';
import test from 'node:test';
import { isPortraitUrl } from '../../src/features/brand/portrait.ts';
import { PREFS_KEY, PlayerPrefs, parsePrefs } from '../../src/features/prefs/player-prefs.ts';

const sha = 'a'.repeat(64);

test('Part 31b: only the server’s own content-addressed picture URL is ever put in an <img>', () => {
  assert.equal(isPortraitUrl(`/api/web/provider/public-image/${sha}`), true);
  for (const bad of [
    null,
    undefined,
    5,
    '',
    `https://evil.invalid/api/web/provider/public-image/${sha}`,
    `/api/web/provider/public-image/${sha}?x=1`,
    `/api/web/provider/public-image/${'A'.repeat(64)}`,
    '/api/web/provider/public-image/short',
    `//evil.invalid/api/web/provider/public-image/${sha}`,
    'javascript:alert(1)',
  ])
    assert.equal(isPortraitUrl(bad), false, String(bad));
});

test('Part 31b: the last-viewed card is one shape-checked id in the existing local prefs; anything else is dropped, nothing is repaired', () => {
  assert.equal(parsePrefs(JSON.stringify({ lastViewed: 'wei-guagua' })).lastViewed, 'wei-guagua');
  for (const bad of [
    5,
    null,
    ['x'],
    { id: 'x' },
    '',
    'UPPER',
    '../x',
    'a b',
    'x'.repeat(65),
    '-lead',
    '<img onerror=1>',
  ])
    assert.equal('lastViewed' in parsePrefs(JSON.stringify({ lastViewed: bad })), false, JSON.stringify(bad));
  assert.deepEqual(parsePrefs(null), { theme: 'system', frame: 'soft', chatBg: {} }, 'a first visit has no key at all');
  assert.deepEqual(parsePrefs('not json'), { theme: 'system', frame: 'soft', chatBg: {} });
});

test('Part 31b: storing it survives storage being off, a throwing storage and 清除本设备的体验数据', () => {
  const kept = new Map<string, string>();
  const store = new PlayerPrefs({
    getItem: (k) => kept.get(k) ?? null,
    setItem: (k, v) => void kept.set(k, v),
    removeItem: (k) => void kept.delete(k),
  });
  assert.equal(store.lastViewed, null);
  store.setLastViewed('jojo');
  assert.equal(JSON.parse(kept.get(PREFS_KEY)!).lastViewed, 'jojo');
  assert.equal(
    new PlayerPrefs({ getItem: (k) => kept.get(k) ?? null, setItem: () => {}, removeItem: () => {} }).lastViewed,
    'jojo',
    'read back on the next visit',
  );
  store.setLastViewed('Not An Id');
  assert.equal(store.lastViewed, 'jojo', 'an invalid id changes nothing');
  store.clear();
  assert.equal(store.lastViewed, null);
  assert.equal(kept.has(PREFS_KEY), false);
  const broken = new PlayerPrefs({
    getItem: () => {
      throw new Error('off');
    },
    setItem: () => {
      throw new Error('full');
    },
    removeItem: () => {},
  });
  broken.setLastViewed('jojo');
  assert.equal(broken.lastViewed, 'jojo', 'this visit still remembers it');
  assert.equal(new PlayerPrefs(null).lastViewed, null);
});
