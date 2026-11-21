import { sampleCastRaw } from './cast-sample.ts';

/** A big cast: `stories` stories among the 15 characters, `memes` inside jokes, `groups` groups, texts of the given size. */
export function bigRaw(options: { stories: number; memes: number; groups: number; detail: number; summary?: number }) {
  const raw = sampleCastRaw();
  const ids = Array.from({ length: 15 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
  const names = raw.characters.map((c) => c.identity.names[0]!.text);
  const fill = (n: number, seed: string) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
  raw.stories = Array.from({ length: options.stories }, (_, i) => ({
    title: `第${i}件事${names[i % 15]}`,
    summary: fill(options.summary ?? 100, `概要${i}`),
    details: fill(options.detail, `细节${i}`),
    period: { start: `20${20 + (i % 7)}-0${1 + (i % 9)}`, end: '' },
    participants: [ids[i % 15]!, ids[(i * 7 + 3) % 15]!].filter((id, at, list) => list.indexOf(id) === at),
    boundary: '',
    overrides: [],
  })) as never;
  raw.memes = Array.from({ length: options.memes }, (_, i) => ({
    key: `暗号${i}`,
    parties: [ids[i % 15]!, ids[(i + 5) % 15]!],
    meaning: fill(60, `意思${i}`),
    trigger: `聊到${['火锅', '考试', '下雨', '加班', '演出'][i % 5]}的时候${i}`,
    prohibited: '',
  })) as never;
  raw.groups = Array.from({ length: options.groups }, (_, i) => ({
    name: `小组${i}`,
    members: [ids[i % 15]!, ids[(i + 1) % 15]!, ids[(i + 2) % 15]!],
    background: fill(60, `背景${i}`),
    stories: [],
  })) as never;
  return raw;
}

/** Every 汉字 field at its maximum (3 bytes each): `stories` full stories, `memes` inside jokes and `groups` groups, as a raw cast. */
export function cjkRaw(stories: number, memes = 300, groups = 600) {
  const cjk = (n: number) => '汉'.repeat(n);
  /** A full-length 汉字 text that is different for every i (a name or key must be unique): the last two characters count. */
  const uniq = (n: number, i: number) =>
    cjk(n - 2) + String.fromCodePoint(0x4e00 + (i % 100)) + String.fromCodePoint(0x4e00 + Math.floor(i / 100));
  const raw = sampleCastRaw();
  const ids = Array.from({ length: 15 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
  raw.stories = Array.from({ length: stories }, (_, i) => ({
    title: uniq(30, i),
    summary: cjk(600),
    details: cjk(2000),
    period: { start: '2026-01', end: '' },
    participants: [ids[i % 15]!],
    boundary: cjk(100),
    overrides: [],
  })) as never;
  raw.memes = Array.from({ length: memes }, (_, i) => ({
    key: uniq(24, i),
    parties: [ids[i % 15]!],
    meaning: cjk(120),
    trigger: cjk(100),
    prohibited: cjk(100),
  })) as never;
  raw.groups = Array.from({ length: groups }, (_, i) => ({
    name: uniq(30, i),
    members: [ids[i % 15]!, ids[(i + 1) % 15]!],
    background: cjk(120),
    stories: [],
  })) as never;
  return raw;
}
