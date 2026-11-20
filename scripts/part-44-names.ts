import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadPlaywright } from './console-fixture-24b6.ts';

/**
 * Part 44 (fix 3): the home cards' nicknames, measured in a real browser on the console fixture's player page. The fixture's bootstrap
 * answer is rewritten on the way (only each character's displayName, and every slot made available), so the real card code and CSS draw
 * every test name. Nothing is stored; nothing else about the page changes.
 *
 * The names are real bad cases from the owner's S23 Ultra (憨憨 too big; 三点水的vuan / Cactus K… / …flection clipped) and the other
 * shapes of the 15: a 12-character CJK name (the cast file's longest), Latin with descenders and overhang, a mixed short one.
 */
export const TEST_NAMES = [
  '憨憨',
  '三点水的vuan',
  'Cactus Kelly',
  'Reflection',
  'Jacqueline Gypsy',
  '十二个字的名字好长啊真的',
  'fjgpqy Jyqg',
  '阿杰Jay',
  'Wuthering Heights',
  '陈吉米',
  'Q.Z',
  '小A',
  'Emma',
  '秦川',
  'JOJO',
] as const;

// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;

/** Open the player home with the test names on the cards. */
export const CARD_IDS = [
  'wei-guagua',
  'jojo',
  'chen-jimi',
  ...Array.from({ length: 12 }, (_, i) => `c${String(i + 4).padStart(2, '0')}`),
];
export async function openNamedHome(
  page: Page,
  origin: string,
  names: readonly string[] = TEST_NAMES,
  front = 'wei-guagua',
) {
  await page.route('**/api/web/provider/bootstrap', async (route: any) => {
    const response = await route.fetch();
    const body = await response.json();
    body.characters.forEach((c: any, i: number) => {
      c.displayName = names[i] ?? c.displayName;
      c.availability = { state: 'available', personaVersion: 1 };
    });
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(
    (id: string) => localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: id })),
    front,
  );
  await page.goto(`${origin}/?mode=provider`);
  await page.locator('.card-slot.is-active').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  await page.waitForTimeout(2200);
}

export type NameFact = {
  text: string;
  /** font-size / card width */
  size: number;
  fontPx: number;
  cardW: number;
  /** glyph ink beyond the name's box and beyond the card, px (positive = clipped / outside) */
  inkLeft: number;
  inkRight: number;
  inkTop: number;
  inkBottom: number;
  /** the text's advance width beyond the box's content width, px */
  overflowX: number;
  family: string;
  lineHeight: string;
  letterSpacing: string;
  clip: string;
};

/** Per card: the nickname's size and how far its glyph INK reaches beyond its own box (what background-clip:text would cut off). */
export const measureNames = (page: Page): Promise<NameFact[]> =>
  page.evaluate(() => {
    const out: NameFact[] = [];
    const canvas = document.createElement('canvas').getContext('2d')!;
    for (const slot of document.querySelectorAll<HTMLElement>('.card-slot.is-active')) {
      const el = slot.querySelector<HTMLElement>('.card-face:not(.face-reserve) .face-name');
      if (!el) continue;
      // the text lives in the element itself, or in the one inner span of Part 44
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const textEl = (el.querySelector('.face-name-text') as HTMLElement | null) ?? el;
      const ts = getComputedStyle(textEl);
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const text = range.getBoundingClientRect();
      const lines = range.getClientRects().length;
      // the painted box of the gradient: the element that carries the background-clip
      const painter = [el, textEl].find((e) => getComputedStyle(e).backgroundClip === 'text') ?? el;
      const pr = painter.getBoundingClientRect();
      canvas.font = `${ts.fontStyle} ${ts.fontWeight} ${ts.fontSize} ${ts.fontFamily}`;
      (canvas as unknown as { letterSpacing: string }).letterSpacing = ts.letterSpacing;
      const m = canvas.measureText(el.textContent ?? '');
      const lh = parseFloat(ts.lineHeight) || parseFloat(ts.fontSize) * 1.2;
      const baseline =
        text.top + (text.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
      void lh;
      const startX = ts.textAlign === 'right' || ts.textAlign === 'end' ? text.right - m.width : text.left;
      const slotRect = slot.querySelector<HTMLElement>('.card-face')!.getBoundingClientRect();
      const inkL = startX - m.actualBoundingBoxLeft;
      const inkR = startX + m.actualBoundingBoxRight;
      const inkT = baseline - m.actualBoundingBoxAscent;
      const inkB = baseline + m.actualBoundingBoxDescent;
      out.push({
        text: el.textContent ?? '',
        size: parseFloat(cs.fontSize) / el.offsetWidth,
        fontPx: parseFloat(cs.fontSize),
        cardW: slotRect.width,
        inkLeft: Math.max(pr.left - inkL, slotRect.left - inkL),
        inkRight: Math.max(inkR - pr.right, inkR - slotRect.right),
        inkTop: pr.top - inkT,
        inkBottom: inkB - pr.bottom,
        overflowX: Math.max(0, textEl.offsetWidth - 0.24 * parseFloat(ts.fontSize) - el.offsetWidth),
        family: ts.fontFamily,
        lineHeight: ts.lineHeight,
        letterSpacing: ts.letterSpacing,
        clip: `${ts.backgroundClip}|${ts.overflow}|lines=${lines}`,
      });
    }
    return out;
  });

/** The front card's face, as a clip of the page (the cards' aura never settles, so an element shot would wait forever). */
export async function shootFront(page: Page, file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const box = await page.locator('.card-slot.is-active .card-face').boundingBox();
  await page.screenshot({ path: file, clip: box, animations: 'disabled' });
}

export const nameEnvironments = (pw: ReturnType<typeof loadPlaywright>) => [
  {
    key: 'android-s23ultra',
    launch: () =>
      pw.chromium.launch({
        args: [
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-gpu-rasterization',
          '--ignore-gpu-blocklist',
          '--enable-unsafe-swiftshader',
        ],
      }),
    context: {
      ...pw.devices['Pixel 7'],
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 3.5,
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    },
  },
  {
    key: 'desktop',
    launch: () => pw.chromium.launch(),
    context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  },
  { key: 'ios-webkit', launch: () => pw.webkit.launch(), context: { ...pw.devices['iPhone 15'] } },
];
