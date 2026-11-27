import './player-build-guard.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture, loadPlaywright } from './console-fixture-24b6.ts';

/**
 * Part 36 design board (review pictures only; nothing here ships). The frames come from the REAL player page (real CSS, real chat DOM,
 * the console fixture's offline provider); the long-press menu, the quote, the rated mark and the batch are PROPOSALS injected on top
 * with the class names the build will use (`b36-*`).
 *
 * usage: node scripts/shoot-part-36-board.ts <dir>     (run `pnpm web:player:build` first)
 * Writes <dir>/board-{android,ios,desktop}-{light,dark}.png (six frames each) and <dir>/frames/*.png.
 */
const out = resolve(process.argv[2] ?? 'review/part-36');
mkdirSync(`${out}/frames`, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ICON = (d: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const THUMB_UP = ICON(
  '<path d="M7 11v9H4v-9z"/><path d="M7 11l4-7c1.6 0 2.5 1.2 2.2 2.8L12.7 10H19a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.7 20H7"/>',
);
const THUMB_DOWN = ICON(
  '<path d="M17 13V4h3v9z"/><path d="M17 13l-4 7c-1.6 0-2.5-1.2-2.2-2.8L11.3 14H5a2 2 0 0 1-2-2.4l1.3-6A2 2 0 0 1 6.3 4H17"/>',
);
const QUOTE = ICON('<path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 7 7"/>');
const MIC = ICON('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>');
const DOC = ICON('<path d="M6 4h12M6 9h12M6 14h12M6 19h8"/>');
const CARD = ICON('<rect x="4" y="3.5" width="16" height="17" rx="3.5"/><path d="M8 15.5h8M8 11.5h5"/>');

const CSS = `
.b36-quote{display:flex;gap:8px;align-items:stretch;min-width:0;border-radius:10px;padding:6px 10px 6px 0;background:color-mix(in srgb,var(--bb-ink) 7%,transparent);overflow:hidden;margin:0 0 5px;text-align:left}
.b36-quote::before{content:"";flex:none;width:3px;border-radius:2px;background:var(--bb-sub);opacity:.7}
.b36-quote[data-from="her"]::before{background:var(--n-accent,var(--accent));opacity:1}
.b36-quote span{display:block;min-width:0}
.b36-quote b{display:block;font-size:11px;font-weight:600;opacity:.72;line-height:1.3}
.b36-quote i{display:block;font-style:normal;font-size:13px;line-height:1.35;opacity:.86;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}
.page-shell .message-row.outgoing .text-bubble .b36-quote{background:color-mix(in srgb,var(--s-out-fg) 14%,transparent)}
.page-shell .message-row.outgoing .text-bubble .b36-quote::before{background:var(--s-out-fg);opacity:.55}
.b36-row-tight{margin-bottom:3px!important}
.b36-row-tight .text-bubble{border-bottom-right-radius:6px}
.b36-compose-quote{flex:0 0 100%;order:-1;display:flex;align-items:center;gap:8px;animation:b36-slide 260ms var(--bb-ease) both}
.b36-compose-quote .b36-quote{flex:1;margin:0;min-width:0}
.b36-x{flex:none;width:44px;height:44px;margin:-8px -8px -8px 0;border:0;background:transparent;color:var(--bb-sub);display:grid;place-items:center;border-radius:50%;font-size:18px}
.composer.b36-has-quote{flex-wrap:wrap;row-gap:8px}
@keyframes b36-slide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes b36-pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.18);opacity:1}100%{transform:scale(1)}}
.b36-scrim{position:fixed;inset:0;z-index:900;background:rgba(12,11,16,.38);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:b36-fade 180ms ease both}
@keyframes b36-fade{from{opacity:0}to{opacity:1}}
.b36-lift{position:fixed;z-index:901;margin:0;animation:b36-lift 220ms var(--bb-ease) both;filter:drop-shadow(0 10px 22px rgba(0,0,0,.28))}
@keyframes b36-lift{from{transform:scale(1)}to{transform:scale(1.035)}}
.b36-menu{position:fixed;z-index:902;display:flex;align-items:center;gap:2px;padding:5px;border-radius:22px;background:var(--s-solid,#fff);color:var(--bb-ink);box-shadow:0 12px 34px rgba(0,0,0,.28),inset 0 0 0 1px var(--s-card-line);animation:b36-menu 240ms var(--bb-ease) both;transform-origin:var(--ox,50%) var(--oy,100%)}
:root[data-theme="dark"] .b36-menu{background:#25222d}
@keyframes b36-menu{from{opacity:0;transform:scale(.86) translateY(6px)}to{opacity:1;transform:none}}
.b36-menu button{height:44px;min-width:44px;padding:0 12px;border:0;border-radius:17px;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:14px;font-weight:500;white-space:nowrap}
.b36-menu .b36-sep{width:1px;height:22px;background:rgba(128,128,128,.3);margin:0 2px}
.b36-mark{position:absolute;left:calc(100% + 6px);bottom:0;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--s-solid,#fff);box-shadow:0 1px 4px rgba(0,0,0,.18);color:var(--n-accent,var(--accent));animation:b36-pop 320ms var(--bb-ease) both}
.b36-mark.is-left{left:auto;right:calc(100% + 6px)}
.b36-mine-holder{position:relative;display:block;max-width:calc(100% - 40px)}
.b36-mine-holder .text-bubble{max-width:100%}
.page-shell .message-row,.page-shell .message-row.outgoing{align-items:flex-start!important}
.page-shell .message-row .message-avatar,.page-shell .message-row.outgoing::after{margin-top:0!important;align-self:flex-start!important}
.b36-mark svg{width:14px;height:14px}
.b36-mark[data-r="down"]{color:var(--bb-sub)}
:root[data-theme="dark"] .b36-mark{background:#2d2a36}
.b36-holder{position:relative;max-width:calc(100% - 47px);display:block}
.b36-holder .text-bubble{max-width:100%}
.b36-waiting{display:flex;justify-content:flex-end;padding:0 46px 6px 0;gap:4px}
.b36-waiting i{width:6px;height:6px;border-radius:50%;background:var(--bb-sub);opacity:.35;animation:b36-wait 1.2s ease-in-out infinite}
.b36-waiting i:nth-child(2){animation-delay:.15s}.b36-waiting i:nth-child(3){animation-delay:.3s}
@keyframes b36-wait{0%,100%{opacity:.25;transform:none}50%{opacity:.8;transform:translateY(-2px)}}
`;

const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const pw = loadPlaywright();
const webkit = await pw.webkit.launch();
try {
  for (const id of ['wei-guagua']) {
    const detail = await (await f.post(`characters/${id}/detail`, {})).json();
    const profile = structuredClone(detail.published.profile);
    profile.template.version += 1;
    await f.post(`characters/${id}/save`, { expectedRevision: detail.draft?.revision ?? null, profile });
  }
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const ANDROID = {
    ...pw.devices['Pixel 7'],
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3.5,
    userAgent: ANDROID_UA,
  };
  const IOS = { ...pw.devices['iPhone 14'] };
  const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  const configs: [string, string, Record<string, unknown>, boolean][] = [];
  for (const theme of ['light', 'dark']) {
    configs.push([`android-${theme}`, theme, ANDROID, false]);
    configs.push([`ios-${theme}`, theme, IOS, true]);
    configs.push([`desktop-${theme}`, theme, DESKTOP, false]);
  }
  const boardImages: Record<string, string[]> = {};
  for (const [name, theme, device, isWebkit] of configs) {
    const ctx = await (isWebkit ? webkit : f.browser).newContext({
      ...device,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    const page: Page = await ctx.newPage();
    await page.addInitScript(
      (t: string) =>
        localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua', theme: t })),
      theme,
    );
    await page.goto(`${f.origin}/?mode=provider`);
    const card = page.locator('.card-slot.is-active');
    await card.waitFor({ timeout: 20_000 });
    await wait(1200);
    await card.click({ force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    await wait(1500);
    await page.addStyleTag({ content: CSS });
    await page.evaluate(
      ([up, down, quote, cardIcon, mic, doc]: string[]) => {
        const slot = document.querySelector('.card-slot.is-active')!;
        const list = slot.querySelector<HTMLElement>('.sent-messages')!;
        const body = slot.querySelector<HTMLElement>('.chat-body')!;
        const title = slot.querySelector<HTMLElement>('.chat-head strong')!;
        const name = title.textContent ?? '';
        const welcome = slot.querySelector('.welcome-row');
        const avatarHtml =
          welcome?.querySelector('.message-avatar')?.outerHTML ?? '<span class="avatar message-avatar"></span>';
        const playHtml = welcome?.querySelector('.play-button')?.innerHTML ?? '';
        const mine = (text: string, tight: boolean, quoteHtml = '') => {
          const row = document.createElement('div');
          row.className = `message-row outgoing${tight ? ' b36-row-tight' : ''}`;
          row.innerHTML = `<span class="b36-mine-holder"><p class="text-bubble">${quoteHtml}${text}</p></span>`;
          return row;
        };
        const her = (kind: 'voice' | 'text', text: string, secs = 6) => {
          const row = document.createElement('div');
          row.className = 'message-row incoming';
          row.innerHTML =
            kind === 'voice'
              ? `${avatarHtml}<div class="voice-stack"><div class="b36-holder"><div class="voice-bubble"><button class="play-button" type="button">${playHtml.replace(/\d+″/, '')}<span class="voice-seconds">${secs}″</span></button><button class="transcript-toggle" type="button">转文字</button></div></div></div>`
              : `${avatarHtml}<div class="b36-holder"><p class="text-bubble incoming-text">${text}</p></div>`;
          return row;
        };
        const q = (from: 'me' | 'her', who: string, text: string) =>
          `<span class="b36-quote" data-from="${from}"><span><b>${who}</b><i>${text}</i></span></span>`;
        const mark = (holder: Element, r: 'up' | 'down', left = false) => {
          const m = document.createElement('span');
          m.className = left ? 'b36-mark is-left' : 'b36-mark';
          m.dataset.r = r;
          m.innerHTML = (r === 'up' ? up : down) ?? '';
          holder.append(m);
        };
        const reset = () => {
          for (const el of document.querySelectorAll(
            '.b36-scrim,.b36-lift,.page-shell:has(> .card-slot > .b36-lift),.b36-menu,.b36-compose-quote,.b36-waiting',
          ))
            el.remove();
          slot.querySelector('.composer')?.classList.remove('b36-has-quote');
          title.textContent = name;
          for (const r of Array.from(list.querySelectorAll<HTMLElement>('.message-row'))) r.style.visibility = '';
          for (const row of Array.from(list.children)) row.remove();
        };
        const menu = (
          row: HTMLElement,
          bubbleSel: string,
          items: { icon: string; label?: string; sep?: boolean }[],
        ) => {
          const rect = row.getBoundingClientRect();
          const rb = (row.querySelector(bubbleSel) as HTMLElement).getBoundingClientRect();
          const scrim = document.createElement('div');
          scrim.className = 'b36-scrim';
          // the lifted row keeps the page's own selectors: it sits in a copy of the shell and card ancestors (display: contents)
          const shell = document.createElement('div');
          shell.className = (document.querySelector('.page-shell') as HTMLElement).className;
          shell.style.display = 'contents';
          for (const a of Array.from((document.querySelector('.page-shell') as HTMLElement).attributes))
            if (a.name.startsWith('data-')) shell.setAttribute(a.name, a.value);
          const holder = document.createElement('div');
          holder.className = slot.className;
          for (const a of Array.from(slot.attributes))
            if (a.name.startsWith('data-')) holder.setAttribute(a.name, a.value);
          holder.style.display = 'contents';
          const clone = row.cloneNode(true) as HTMLElement;
          clone.classList.add('b36-lift');
          clone.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;margin:0;animation:b36-lift 220ms var(--bb-ease) both`;
          holder.append(clone);
          shell.append(holder);
          const bar = document.createElement('div');
          bar.className = 'b36-menu';
          bar.innerHTML = items
            .map((i) =>
              i.sep
                ? '<span class="b36-sep"></span>'
                : `<button type="button" aria-label="${i.label ?? ''}">${i.icon}${i.label ? `<span>${i.label}</span>` : ''}</button>`,
            )
            .join('');
          document.body.append(scrim, shell, bar);
          {
            const c = clone.getBoundingClientRect();
            clone.style.left = `${rect.left + (rect.left - c.left)}px`;
            clone.style.top = `${rect.top + (rect.top - c.top)}px`;
          }
          row.style.visibility = 'hidden';
          const bw = bar.getBoundingClientRect().width;
          const left = Math.max(12, Math.min(window.innerWidth - bw - 12, rb.left + rb.width / 2 - bw / 2));
          const above = rb.top > 90;
          bar.style.left = `${left}px`;
          bar.style.top = above ? `${rb.top - 62}px` : `${rb.bottom + 12}px`;
          bar.style.setProperty('--ox', `${Math.round(rb.left + rb.width / 2 - left)}px`);
          bar.style.setProperty('--oy', above ? '100%' : '0%');
        };
        (window as unknown as Record<string, unknown>).__b = {
          mine,
          her,
          q,
          mark,
          reset,
          menu,
          list,
          body,
          title,
          up,
          down,
          quote,
          cardIcon,
          mic,
          doc,
          name,
        };
      },
      [THUMB_UP, THUMB_DOWN, QUOTE, CARD, MIC, DOC],
    );
    const shoot = async (label: string) => {
      await wait(500);
      const path = `${out}/frames/${name}-${label}.png`;
      await page.screenshot({ path });
      return path;
    };
    const run = (fn: (b: any) => void) => page.evaluate(`(${fn.toString()})(window.__b)`);
    const batch = (b: any) =>
      b.list.append(b.mine('在吗', true), b.mine('我刚下班', true), b.mine('今天好累啊……', false));
    const batchSrc = batch.toString();
    const frames: string[] = [];
    // 1. several bubbles in a row; she has not started yet (three quiet dots where her reply will appear)
    await page.evaluate(`((b) => { b.reset(); (${batchSrc})(b);
      const dots = document.createElement('div'); dots.className = 'b36-waiting'; dots.innerHTML = '<i></i><i></i><i></i>';
      b.list.append(dots); b.body.scrollTop = b.body.scrollHeight; })(window.__b)`);
    frames.push(await shoot('1-batch'));
    // 2. she starts replying: the header turns to 正在讲话中, her voice bubble comes in, the batch stays as it is
    await run((b) => {
      b.list.querySelector('.b36-waiting')?.remove();
      b.title.textContent = '正在讲话中';
      b.list.append(b.her('voice', '', 7));
      b.list.lastElementChild.querySelector('.play-button')?.setAttribute('data-playing', 'true');
      b.body.scrollTop = b.body.scrollHeight;
    });
    frames.push(await shoot('2-replying'));
    // 3. long-press on her voice message: 引用 · 分享为卡片 · 👍 · 👎
    await page.evaluate(`((b) => { b.reset(); (${batchSrc})(b); b.list.append(b.her('voice', '', 7)); b.body.scrollTop = b.body.scrollHeight;
      b.menu(b.list.lastElementChild, '.voice-bubble', [{ icon: b.quote, label: '引用' }, { icon: b.cardIcon, label: '分享为卡片' }, { sep: true }, { icon: b.up, label: '赞' }, { icon: b.down, label: '踩' }]); })(window.__b)`);
    frames.push(await shoot('3-menu-her-voice'));
    // 4. long-press on the player's own bubble: 引用 only
    await page.evaluate(`((b) => { b.reset(); (${batchSrc})(b); b.list.append(b.her('voice', '', 7)); b.body.scrollTop = b.body.scrollHeight;
      b.menu(b.list.querySelectorAll('.message-row.outgoing')[2], '.text-bubble', [{ icon: b.quote, label: '引用' }]); })(window.__b)`);
    frames.push(await shoot('4-menu-mine'));
    // 5. the composer with a quote (her bubble) and ✕
    await page.evaluate(`((b) => { b.reset(); (${batchSrc})(b); b.list.append(b.her('text', '先把鞋脱了，坐下来，慢慢说。')); b.body.scrollTop = b.body.scrollHeight;
      const composer = document.querySelector('.card-slot.is-active .composer'); composer.classList.add('b36-has-quote');
      const strip = document.createElement('div'); strip.className = 'b36-compose-quote';
      strip.innerHTML = b.q('her', b.name, '先把鞋脱了，坐下来，慢慢说。') + '<button class="b36-x" type="button" aria-label="取消引用">✕</button>';
      composer.prepend(strip); })(window.__b)`);
    frames.push(await shoot('5-composer-quote'));
    // 6. sent bubbles with a quote of her bubble and of his own; the rated state; the voice bubble without the share icon
    await page.evaluate(`((b) => { b.reset(); (${batchSrc})(b);
      const voice = b.her('voice', '', 7); b.list.append(voice); b.mark(voice.querySelector('.b36-holder'), 'up');
      const text = b.her('text', '先把鞋脱了，坐下来，慢慢说。'); b.list.append(text); b.mark(text.querySelector('.b36-holder'), 'down');
      b.list.append(b.mine('好～', false, b.q('her', b.name, '先把鞋脱了，坐下来，慢慢说。')));
      const last = b.mine('对了，刚才说的那个', false, b.q('me', '我', '我刚下班')); b.list.append(last); b.mark(last.querySelector('.b36-mine-holder'), 'up', true);
      b.body.scrollTop = b.body.scrollHeight; })(window.__b)`);
    frames.push(await shoot('6-quotes-rated'));
    // 7. after 👎 in the menu: the menu turns into one question, 语音 or 内容 (a text-fallback reply has no voice, so it skips this)
    await page.evaluate(`((b) => { b.reset(); (${batchSrc})(b); b.list.append(b.her('voice', '', 7)); b.body.scrollTop = b.body.scrollHeight;
      b.menu(b.list.lastElementChild, '.voice-bubble', [{ icon: b.down }, { sep: true }, { icon: b.mic, label: '语音' }, { icon: b.doc, label: '内容' }]); })(window.__b)`);
    frames.push(await shoot('7-thumbs-down-choice'));
    boardImages[name] = frames;
    await ctx.close();
  }
  const boardCtx = await f.browser.newContext({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 1.5 });
  const labels = [
    '连发',
    '她开始回复',
    '长按她的语音',
    '长按我的气泡',
    '引用中',
    '已评价 · 引用 · 无分享图标',
    '点 👎 后选 语音 / 内容',
  ];
  for (const [name, frames] of Object.entries(boardImages)) {
    const desktop = name.startsWith('desktop');
    const dark = name.endsWith('dark');
    const imgs = frames
      .map(
        (p, i) =>
          `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${i + 1} ${labels[i]}</figcaption></figure>`,
      )
      .join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:24px;background:${dark ? '#0c0b10' : '#ece9e4'};font:14px system-ui,sans-serif;color:${dark ? '#f5f3f7' : '#141414'}}
      .g{display:grid;grid-template-columns:${desktop ? 'repeat(2,1fr)' : 'repeat(3,1fr)'};gap:22px}
      figure{margin:0}img{width:100%;border-radius:14px;display:block;box-shadow:0 2px 14px rgba(0,0,0,.25)}
      figcaption{padding:8px 4px 0;opacity:.75}</style><div class="g">${imgs}</div>`;
    const bp = await boardCtx.newPage();
    await bp.setContent(html);
    await wait(400);
    await bp.screenshot({ path: `${out}/board-${name}.png`, fullPage: true });
    await bp.close();
  }
  await boardCtx.close();
  writeFileSync(`${out}/.generated`, new Date().toISOString());
  console.log('board written to', out);
} finally {
  await webkit.close().catch(() => undefined);
}
process.exit(0);
