/** E visual shell. Without a live binding it is a pure local fixture and sends nothing. */
import { orbitStyle, ringOffset } from './orbit.js';
import { followChatViewport, swipeStep } from './mobile-layout.js';
import type { LiveBinding } from './provider-binding.js';
import { providerPeople, escapeCardText, type Person } from './provider-catalog-view.js';

type Phase = 'browse' | 'hover' | 'expanding' | 'chat' | 'collapsing';

const knownPeople: Person[] = [
  { id: 'preview-guagua', name: '瓜瓜', mark: '瓜', color: '#D7C8B9', ink: '#614C3C', transcript: '我才放学回来，让你等久了', characterId: 'wei-guagua' },
  { id: 'preview-jojo', name: 'JOJO', mark: 'J', color: '#C7D1D3', ink: '#405C61', transcript: 'Thanks Kobe，你终于来了', characterId: 'jojo' },
  { id: 'preview-chen-jimi', name: '陈吉米', mark: '吉', color: '#C8C6D7', ink: '#535271', transcript: '打瓦请按1，王者请按2，其他事请挂断', characterId: 'chen-jimi' },
];
const reserveColors = ['#C8D4CB', '#D6CED4', '#C9D3DC', '#D9D0C5', '#CFD7D2', '#D4CDDB'];
const reserve = (index: number): Person => ({
  id: `preview-reserve-${String(index).padStart(2, '0')}`,
  name: `未开放位置${index}`,
  mark: '',
  color: reserveColors[(index - 1) % reserveColors.length]!,
  ink: '#596962',
});
// Twelve unconfigured positions make the fifteen-slot geometry testable without inventing people.
const people: Person[] = [
  ...Array.from({ length: 6 }, (_, i) => reserve(i + 1)),
  ...knownPeople,
  ...Array.from({ length: 6 }, (_, i) => reserve(i + 7)),
];

const icon = (name: 'sound' | 'back' | 'send' | 'play') => {
  const paths = {
    sound: '<path d="M3 10v4m4-7v10m4-14v18m4-15v12m4-8v4"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    send: '<path d="m4 12 16-8-5 16-3-7-8-1Zm8 1 8-9"/>',
    play: '<path d="m9 6 9 6-9 6V6Z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
};

function blend(a: string, b: string, t: number): string {
  const n = (s: string, i: number) => Number.parseInt(s.slice(i, i + 2), 16);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${[1, 3, 5].map(i => h(n(a, i) + (n(b, i) - n(a, i)) * t)).join('')}`;
}

function createCard(person: Person) {
  const name = escapeCardText(person.name), mark = escapeCardText(person.mark);
  const configured = person.transcript !== undefined;
  const card = document.createElement('article');
  card.className = 'card-slot';
  card.dataset.person = person.id;
  card.setAttribute('aria-label', configured ? `${person.name}的聊天` : person.name);
  card.innerHTML = `
    <div class="card-shell">
      <div class="chat-head">
        <button class="back-button icon-button" type="button" aria-label="返回人物浏览">${icon('back')}</button>
        <strong role="status" aria-live="polite">${name}</strong>
      </div>
      <div class="chat-body" role="log" aria-label="${name}的消息">
        ${configured ? `<p class="friend-notice">${name}已添加了你，来打个招呼吧</p>` : ''}
        ${configured ? `
        <div class="welcome-row message-row incoming">
          <span class="avatar message-avatar" aria-hidden="true">${mark}</span>
          <div class="voice-stack">
            <div class="voice-bubble">
              <button class="play-button" type="button" aria-label="播放${name}的语音，当前没有音频素材">${icon('play')}<span class="sound-bars">${icon('sound')}</span></button>
              <button class="transcript-toggle" type="button" aria-expanded="false">转文字</button>
            </div>
            <p class="transcript" hidden></p>
          </div>
        </div>
        ` : '<div class="reserve-state" aria-label="尚未开放"><span class="reserve-symbol" aria-hidden="true"></span><p>新朋友还未到来</p></div>'}
        <div class="sent-messages"></div>
      </div>
      <div class="composer" ${configured ? '' : 'hidden'}>
        <label class="sr-only" for="reply-${person.id}">回复${name}</label>
        <textarea id="reply-${person.id}" rows="1" enterkeyhint="send" placeholder="回复…" aria-label="回复${name}"></textarea>
        <button class="send-button icon-button" type="button" aria-label="发送消息" disabled>${icon('send')}</button>
      </div>
    </div>`;
  card.style.setProperty('--avatar-bg', person.color);
  card.style.setProperty('--avatar-ink', person.ink);
  card.style.setProperty('--card-color', person.color);
  card.classList.toggle('is-reserve', !configured);
  return card;
}

export function startPrototype(root: HTMLElement, live?: LiveBinding) {
  const roster = live ? providerPeople(live.catalog()) : people;
  return startShell(root, roster, live);
}

function startShell(root: HTMLElement, people: Person[], live?: LiveBinding) {
  root.innerHTML = `
    <div class="page-shell">
      <header class="site-head"><div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>FAKE 泡泡</span></div><span class="head-note">遇见一个新朋友</span></header>
      <main class="main-area">
        <h1 class="sr-only">选择人物开始聊天</h1>
        <div class="carousel" aria-label="人物聊天卡片，可滑动切换" tabindex="0"><div class="card-deck"></div></div>
        <nav class="avatar-nav" aria-label="选择人物"></nav>
      </main>
      <footer class="preview-note">${live ? '邀请体验 · 回复由AI生成' : '本地交互原型 · 合成数据 · 暂无真实语音或生成回复'}</footer>
      <div class="toast" role="status" aria-live="polite"></div>
    </div>`;
  const page = root.querySelector<HTMLElement>('.page-shell')!;
  followChatViewport(page);
  const carousel = root.querySelector<HTMLElement>('.carousel')!;
  const deck = root.querySelector<HTMLElement>('.card-deck')!;
  const nav = root.querySelector<HTMLElement>('.avatar-nav')!;
  const toast = root.querySelector<HTMLElement>('.toast')!;
  const cards = people.map(createCard);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  for (const card of cards) deck.append(card);
  let active = 7;
  let phase: Phase = 'browse';
  let dragStart: { x: number; y: number; pointerId: number } | undefined;
  let dragged = false;
  let lastWheel = 0;
  let animation: Animation | undefined;
  let settleTimer = 0;
  let toastTimer = 0;
  const previousOffsets = new Map<HTMLElement, number>();
  const drafts = new Map<string, { value: string; start: number; end: number; scroll: number }>();
  const cardWidth = () => window.innerWidth <= 360 ? window.innerWidth - 64
    : window.innerWidth <= 600 ? Math.min(360, window.innerWidth - 96)
      : Math.min(376, window.innerWidth - 108);

  const say = (message: string) => {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2800);
  };
  const updateBackground = (position = active) => {
    const n = people.length;
    const wrapped = ((position % n) + n) % n;
    const lower = Math.floor(wrapped);
    const next = (lower + 1) % n;
    const color = reduced.matches ? people[active]!.color : blend(people[lower]!.color, people[next]!.color, wrapped - lower);
    page.style.setProperty('--page-bg', color);
    document.documentElement.style.backgroundColor = color;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', color);
  };
  const saveEditor = (index: number) => {
    const textarea = cards[index]!.querySelector('textarea')!;
    const scroll = cards[index]!.querySelector<HTMLElement>('.chat-body')!.scrollTop;
    drafts.set(people[index]!.id, { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd, scroll });
  };
  const restoreEditor = (index: number) => {
    const state = drafts.get(people[index]!.id);
    if (!state) return;
    const textarea = cards[index]!.querySelector('textarea')!;
    textarea.value = state.value;
    textarea.setSelectionRange(state.start, state.end);
    cards[index]!.querySelector<HTMLElement>('.chat-body')!.scrollTop = state.scroll;
  };
  const render = () => {
    page.dataset.phase = phase;
    const chatting = phase === 'expanding' || phase === 'chat' || phase === 'collapsing';
    document.documentElement.classList.toggle('chat-open', chatting);
    nav.inert = chatting;
    nav.setAttribute('aria-hidden', String(chatting));
    cards.forEach((card, index) => {
      const offset = ringOffset(index, active, people.length);
      const orbit = orbitStyle(offset, people.length);
      const previous = previousOffsets.get(card);
      if (previous !== undefined && Math.abs(previous - offset) > 7) {
        card.classList.add('orbit-wrap');
        requestAnimationFrame(() => card.classList.remove('orbit-wrap'));
      }
      previousOffsets.set(card, offset);
      card.style.setProperty('--orbit-x', `${orbit.x * cardWidth()}px`);
      card.style.setProperty('--orbit-y', `${orbit.y}px`);
      card.style.setProperty('--orbit-scale', String(orbit.scale));
      card.style.setProperty('--orbit-opacity', String(orbit.opacity));
      card.style.setProperty('--wash', orbit.wash);
      card.style.zIndex = String(orbit.z);
      card.classList.toggle('is-active', index === active);
      card.classList.toggle('is-chat', index === active && (phase === 'expanding' || phase === 'chat' || phase === 'collapsing'));
      const hidden = chatting;
      const inaccessible = ((hidden || window.innerWidth <= 600) && index !== active) || (!hidden && Math.abs(offset) > 2);
      card.inert = inaccessible;
      card.setAttribute('aria-hidden', inaccessible ? 'true' : 'false');
      const reply = card.querySelector<HTMLTextAreaElement>('textarea')!;
      reply.tabIndex = index === active ? 0 : -1;
      card.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
        if (!button.classList.contains('send-button')) button.tabIndex = index === active ? 0 : -1;
      });
    });
    nav.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => {
      const offset = ringOffset(index, active, people.length);
      const orbit = orbitStyle(offset, people.length);
      button.style.setProperty('--avatar-x', `${orbit.avatarX * Math.min(window.innerWidth * .44, 218)}px`);
      button.style.setProperty('--avatar-chat-x', `${orbit.avatarX * 118}px`);
      button.style.setProperty('--avatar-y', `${orbit.avatarY}px`);
      button.style.setProperty('--avatar-scale', String(orbit.avatarScale));
      button.style.setProperty('--avatar-opacity', String(orbit.avatarOpacity));
      button.style.setProperty('--wash', orbit.wash);
      button.style.zIndex = String(orbit.z);
      button.inert = Math.abs(offset) > 3;
      button.tabIndex = index === active ? 0 : -1;
      button.classList.toggle('selected', index === active);
      button.setAttribute('aria-current', index === active ? 'true' : 'false');
    });
    updateBackground();
  };
  const switchTo = (index: number) => {
    const next = ((index % people.length) + people.length) % people.length;
    if (next === active) return;
    if (phase === 'chat' && !people[next]!.transcript) {
      closeChat();
    }
    if (phase === 'chat' || phase === 'expanding') saveEditor(active);
    animation?.cancel();
    active = next;
    restoreEditor(active);
    render();
    if (phase === 'chat') cards[active]!.querySelector('textarea')!.focus({ preventScroll: true });
  };
  const spatial = (card: HTMLElement, before: DOMRect) => {
    animation?.cancel();
    if (reduced.matches) return;
    const after = card.getBoundingClientRect();
    const dx = (before.left + before.width / 2) - (after.left + after.width / 2);
    const dy = (before.top + before.height / 2) - (after.top + after.height / 2);
    animation = card.animate([
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${before.width / after.width}, ${before.height / after.height})` },
      { transform: 'translate(-50%, -50%) scale(1)' },
    ], { duration: 340, easing: 'cubic-bezier(.2,.82,.24,1)' });
  };
  const openChat = (focus = false) => {
    if (phase === 'chat' || phase === 'expanding') return;
    if (!people[active]!.transcript) { say('这个位置还没有新朋友'); return; }
    if (dragStart && carousel.hasPointerCapture(dragStart.pointerId)) carousel.releasePointerCapture(dragStart.pointerId);
    dragStart = undefined;
    dragged = false;
    carousel.classList.remove('is-dragging');
    deck.style.setProperty('--drag-x', '0px');
    const card = cards[active]!;
    const before = card.getBoundingClientRect();
    phase = 'expanding'; render(); spatial(card, before);
    const settle = () => { if (phase === 'expanding') { phase = 'chat'; render(); } };
    const opened = people[active]!.characterId;
    if (live && opened) void live.open(opened, card);
    if (reduced.matches) settle();
    else settleTimer = window.setTimeout(settle, 220);
    if (focus) card.querySelector('textarea')!.focus({ preventScroll: true });
  };
  const closeChat = () => {
    if (phase !== 'chat' && phase !== 'expanding') return;
    clearTimeout(settleTimer);
    settleTimer = 0;
    const card = cards[active]!;
    saveEditor(active);
    const wasFocused = document.activeElement === card.querySelector('textarea');
    const before = card.getBoundingClientRect();
    phase = 'collapsing'; render();
    phase = 'browse'; render(); spatial(card, before);
    if (wasFocused) carousel.focus({ preventScroll: true });
  };

  people.forEach((person, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'avatar-choice';
    button.setAttribute('aria-label', person.transcript ? `选择${person.name}` : person.name);
    button.innerHTML = `<span class="avatar avatar-choice-mark" aria-hidden="true">${escapeCardText(person.mark) || '<span class="reserve-dot"></span>'}</span>`;
    button.style.setProperty('--avatar-bg', person.color);
    button.style.setProperty('--avatar-ink', person.ink);
    button.addEventListener('click', () => switchTo(index));
    nav.append(button);
  });
  nav.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); switchTo(active + 1); nav.querySelector<HTMLButtonElement>('.selected')?.focus(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); switchTo(active - 1); nav.querySelector<HTMLButtonElement>('.selected')?.focus(); }
  });

  cards.forEach((card, index) => {
    const reply = card.querySelector<HTMLTextAreaElement>('textarea')!;
    const send = card.querySelector<HTMLButtonElement>('.send-button')!;
    const transcriptButton = card.querySelector<HTMLButtonElement>('.transcript-toggle');
    const transcript = card.querySelector<HTMLElement>('.transcript');
    card.addEventListener('click', event => {
      if (dragged) { event.preventDefault(); return; }
      if (index !== active && (phase === 'browse' || phase === 'hover')) {
        event.stopPropagation();
        switchTo(index);
        openChat(event.target instanceof Element && !!event.target.closest('textarea'));
        return;
      }
      if (event.target instanceof Element && event.target.closest('button,textarea')) return;
      if (phase === 'browse' || phase === 'hover') openChat(false);
    }, true);
    card.addEventListener('pointerenter', () => { if (phase === 'browse') { phase = 'hover'; card.classList.add('is-hovered'); } });
    card.addEventListener('pointerleave', () => { card.classList.remove('is-hovered'); if (phase === 'hover') phase = 'browse'; });
    card.querySelector<HTMLButtonElement>('.back-button')!.addEventListener('click', closeChat);
    card.querySelector<HTMLButtonElement>('.play-button')?.addEventListener('click', () => {
      const characterId = people[index]!.characterId;
      if (live && characterId) live.playWelcome(characterId);
      else say('这段语音暂时无法播放');
    });
    transcriptButton?.addEventListener('click', () => {
      if (!transcript) return;
      const visible = transcript.hidden;
      transcript.hidden = !visible;
      transcript.textContent = visible ? people[index]!.transcript! : '';
      transcriptButton.textContent = visible ? '收起文字' : '转文字';
      transcriptButton.setAttribute('aria-expanded', String(visible));
    });
    reply.addEventListener('focus', () => { if (index === active) openChat(false); });
    reply.addEventListener('input', () => {
      send.disabled = !reply.value.trim();
      const characterId = people[index]!.characterId;
      if (live && characterId) live.updateComposer(characterId);
      saveEditor(index);
    });
    reply.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send.click(); }
      if (event.key === 'Escape' && !event.isComposing) closeChat();
    });
    send.addEventListener('click', () => {
      const draft = reply.value, value = draft.trim();
      if (!value) return;
      const characterId = people[index]!.characterId;
      if (live && characterId) {
        void live.send(characterId, value, card, () => {
          // Clear only the acknowledged draft, never newer typing during the request.
          if (reply.value === draft) { reply.value = ''; saveEditor(index); }
          live.updateComposer(characterId);
        });
        reply.focus({ preventScroll: true });
        return;
      }
      const row = document.createElement('div');
      row.className = 'message-row outgoing';
      const bubble = document.createElement('p');
      bubble.className = 'text-bubble';
      bubble.textContent = value;
      row.append(bubble);
      card.querySelector('.sent-messages')!.append(row);
      reply.value = ''; send.disabled = true;
      const body = card.querySelector<HTMLElement>('.chat-body')!;
      body.scrollTop = body.scrollHeight;
      saveEditor(index);
      reply.focus({ preventScroll: true });
      say('已加入本地预览；没有请求真实回复');
    });
  });

  carousel.addEventListener('keydown', event => {
    if (event.target !== carousel || (phase !== 'browse' && phase !== 'hover')) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); switchTo(active + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); switchTo(active - 1); }
    if (event.key === 'Enter') { event.preventDefault(); openChat(true); }
  });
  carousel.addEventListener('wheel', event => {
    if (phase === 'chat' || phase === 'expanding' || phase === 'collapsing') return;
    if (event.target instanceof Element && event.target.closest('textarea,button,[contenteditable="true"]')) return;
    if (window.getSelection()?.toString()) return;
    // Wheel deltas describe content motion, pointer deltas describe finger motion.
    // Do not turn vertical browser scrolling into a reversed horizontal swipe.
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const dominant = event.deltaX;
    if (Math.abs(dominant) < 4) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheel < 310) return;
    lastWheel = now;
    switchTo(active + Math.sign(dominant));
  }, { passive: false });
  carousel.addEventListener('pointerdown', event => {
    if (phase === 'chat' || phase === 'expanding' || phase === 'collapsing') return;
    if (event.target instanceof Element && event.target.closest('textarea,button')) return;
    dragStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    dragged = false;
  });
  carousel.addEventListener('pointermove', event => {
    if (phase !== 'browse' && phase !== 'hover') return;
    if (!dragStart || event.pointerId !== dragStart.pointerId) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    if (Math.abs(dx) < 7 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
    dragged = true;
    carousel.classList.add('is-dragging');
    if (event.pointerType === 'mouse') carousel.setPointerCapture(event.pointerId);
    deck.style.setProperty('--drag-x', `${Math.max(-110, Math.min(110, dx * .45))}px`);
    updateBackground(active - Math.max(-1, Math.min(1, dx / 320)));
  });
  const endDrag = (event: PointerEvent) => {
    if (!dragStart || event.pointerId !== dragStart.pointerId) return;
    const dx = event.clientX - dragStart.x, dy = event.clientY - dragStart.y;
    const step = swipeStep(dx, dy, event.type === 'pointercancel');
    dragStart = undefined;
    carousel.classList.remove('is-dragging');
    deck.style.setProperty('--drag-x', '0px');
    if (dragged && step) switchTo(active + step);
    else updateBackground();
    if (dragged) setTimeout(() => { dragged = false; }, 0);
  };
  carousel.addEventListener('pointerup', endDrag);
  carousel.addEventListener('pointercancel', endDrag);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) closeChat();
  });
  reduced.addEventListener('change', () => updateBackground());
  window.addEventListener('resize', render);
  render();
  live?.attach({ say, head: root.querySelector<HTMLElement>('.site-head')!,
    card: characterId => cards[people.findIndex(person => person.characterId === characterId)]!,
    mark: characterId => people.find(person => person.characterId === characterId)!.mark,
    name: characterId => people.find(person => person.characterId === characterId)!.name });
}
