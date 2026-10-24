/** The visual shell: a carousel of the characters the server's catalog lists, every chat driven by the live binding. */
import { orbitStyle, ringOffset } from './orbit.js';
import { appendLegalLinks, footerNote } from './legal-links.ts';
import { followChatViewport, swipeStep } from './mobile-layout.js';
import type { LiveBinding } from './provider-binding.js';
import { providerPeople, escapeCardText, type Person } from './provider-catalog-view.js';
import { handSvg, wordmarkSvg } from '../brand/wordmark.js';

type Phase = 'browse' | 'hover' | 'expanding' | 'chat' | 'collapsing';

const icon = (name: 'sound' | 'back' | 'send' | 'play' | 'more') => {
  const paths = {
    sound: '<path d="M3 10v4m4-7v10m4-14v18m4-15v12m4-8v4"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    send: '<path d="m4 12 16-8-5 16-3-7-8-1Zm8 1 8-9"/>',
    play: '<path d="m9 6 9 6-9 6V6Z"/>',
    more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
};

/** The page's paper; the character's aura is painted over it by `.aura-stack`, never mixed into it (Part 25a). */
const PAPER = '#FAF8F6';

/** Part 25a: the front of the 小卡 — shown while the card is a card, faded out when it becomes the chat. Decoration only. */
function cardFace(person: Person, configured: boolean) {
  if (!configured)
    return `<div class="card-face face-reserve" aria-hidden="true">
      <div class="face-top"><span>burbur</span><span>No.${person.card.no}</span></div>
      <div class="face-main face-empty">${handSvg('?', { size: 120, weight: 1.6, label: null, className: 'hand face-question' })}<span class="face-empty-text">新朋友还未到来</span></div>
    </div>`;
  const line = person.transcript
    ? `<div class="face-voice"><span class="face-play"><svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span><span class="face-line">${escapeCardText(person.transcript)}</span></div>`
    : '';
  return `<div class="card-face" aria-hidden="true">
      <div class="face-top"><span>burbur</span><span>No.${person.card.no}</span></div>
      <div class="face-main"><span class="face-name">${escapeCardText(person.name)}</span>${
        person.card.latin
          ? handSvg(person.card.latin, { size: 44, weight: 1.9, label: null, className: 'hand face-latin' })
          : ''
      }</div>
      ${line}
      <i class="face-sheen"></i>
    </div>`;
}

function createCard(person: Person) {
  const name = escapeCardText(person.name),
    mark = escapeCardText(person.mark);
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
        ${configured ? `<button class="chat-more icon-button" type="button" aria-label="更多" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>` : ''}
      </div>
      <div class="chat-body" role="log" aria-label="${name}的消息">
        ${configured ? `<p class="friend-notice">${name}已添加了你，来打个招呼吧</p>` : ''}
        ${
          configured
            ? `
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
        `
            : '<div class="reserve-state" aria-label="尚未开放"><span class="reserve-symbol" aria-hidden="true"></span><p>新朋友还未到来</p></div>'
        }
        <div class="sent-messages"></div>
      </div>
      <div class="composer" ${configured ? '' : 'hidden'}>
        <label class="sr-only" for="reply-${person.id}">回复${name}</label>
        <textarea id="reply-${person.id}" rows="1" enterkeyhint="send" placeholder="回复…" aria-label="回复${name}"></textarea>
        <button class="send-button icon-button" type="button" aria-label="发送消息" disabled>${icon('send')}</button>
      </div>
      ${cardFace(person, configured)}
    </div>`;
  const [aura1, aura2, aura3, accent] = person.card.aura;
  card.style.setProperty('--aura-1', aura1);
  card.style.setProperty('--aura-2', aura2);
  card.style.setProperty('--aura-3', aura3);
  card.style.setProperty('--accent', accent);
  card.style.setProperty('--name-size', String(person.card.nameSize));
  card.style.setProperty('--avatar-bg', person.color);
  card.style.setProperty('--avatar-ink', person.ink);
  card.style.setProperty('--card-color', person.color);
  card.classList.toggle('is-reserve', !configured);
  return card;
}

export function startPrototype(root: HTMLElement, live: LiveBinding) {
  return startShell(root, providerPeople(live.catalog()), live);
}

function startShell(root: HTMLElement, people: Person[], live: LiveBinding) {
  root.innerHTML = `
    <div class="page-shell">
      <div class="aura-stack" aria-hidden="true"></div>
      <header class="site-head"><div class="brand">${wordmarkSvg({ size: 34, weight: 2, className: 'hand brand-hand' })}</div><span class="head-note">捡到一窝小四四</span></header>
      <main class="main-area">
        <h1 class="sr-only">选择人物开始聊天</h1>
        <div class="carousel" aria-label="人物聊天卡片，可滑动切换" tabindex="0"><div class="card-deck"></div></div>
        <nav class="avatar-nav" aria-label="选择人物"></nav>
      </main>
      <footer class="preview-note">${footerNote(live.freeTierEnabled, live.signedUpPlayer)}</footer>
      <div class="toast" role="status" aria-live="polite"></div>
    </div>`;
  const page = root.querySelector<HTMLElement>('.page-shell')!;
  appendLegalLinks(root.querySelector('.preview-note'), live.legalEnabled);
  followChatViewport(page);
  const carousel = root.querySelector<HTMLElement>('.carousel')!;
  const deck = root.querySelector<HTMLElement>('.card-deck')!;
  const nav = root.querySelector<HTMLElement>('.avatar-nav')!;
  const toast = root.querySelector<HTMLElement>('.toast')!;
  const cards = people.map((person) => createCard(person));
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
  const cardWidth = () => (window.innerWidth <= 600 ? window.innerWidth - 32 : Math.min(376, window.innerWidth - 108));

  const say = (message: string) => {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2800);
  };
  // Part 25a: one aura layer per character (and one for the empty slots). The page cross-fades between them; a drag blends the
  // two neighbours by how far the finger moved, like the solid colour did before.
  const auraStack = root.querySelector<HTMLElement>('.aura-stack')!;
  const auraKey = (person: Person) => (person.characterId ? person.id : 'neutral');
  const layers = new Map<string, HTMLElement>();
  for (const person of people) {
    if (layers.has(auraKey(person))) continue;
    const layer = document.createElement('div');
    layer.className = 'aura';
    const [aura1, aura2, aura3] = person.card.aura;
    layer.style.setProperty('--aura-1', aura1);
    layer.style.setProperty('--aura-2', aura2);
    layer.style.setProperty('--aura-3', aura3);
    auraStack.append(layer);
    layers.set(auraKey(person), layer);
  }
  page.style.setProperty('--page-bg', PAPER);
  document.documentElement.style.backgroundColor = PAPER;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', PAPER);
  const updateBackground = (position = active) => {
    const n = people.length;
    const wrapped = ((position % n) + n) % n;
    const lower = Math.floor(wrapped);
    const next = (lower + 1) % n;
    const weight = new Map<string, number>();
    const add = (person: Person, by: number) => weight.set(auraKey(person), (weight.get(auraKey(person)) ?? 0) + by);
    if (reduced.matches) add(people[active]!, 1);
    else {
      add(people[lower]!, 1 - (wrapped - lower));
      add(people[next]!, wrapped - lower);
    }
    for (const [key, layer] of layers) layer.style.opacity = String(weight.get(key) ?? 0);
  };
  const saveEditor = (index: number) => {
    const textarea = cards[index]!.querySelector('textarea')!;
    const scroll = cards[index]!.querySelector<HTMLElement>('.chat-body')!.scrollTop;
    drafts.set(people[index]!.id, {
      value: textarea.value,
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      scroll,
    });
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
    const mobile = window.innerWidth <= 600;
    nav.inert = chatting;
    nav.setAttribute('aria-hidden', String(chatting));
    // Part 25a: a card in front of another is solid and nothing shows through it. Only the three nearest cards on each side are
    // drawn, at most two of them empty "new friend" slots, and the words "新朋友还未到来" appear once, on the nearest empty slot.
    const isEmpty = (index: number) => !people[index]!.characterId;
    const hiddenSlots = new Set<number>();
    let nearEmpty = isEmpty(active) ? active : -1;
    let nearEmptyDepth = 99;
    for (const direction of [1, -1]) {
      let empties = 0;
      for (let depth = 1; depth <= Math.floor(people.length / 2); depth++) {
        const index = (((active + direction * depth) % people.length) + people.length) % people.length;
        if (depth > 3) hiddenSlots.add(index);
        else if (isEmpty(index)) {
          empties++;
          if (empties > 2) hiddenSlots.add(index);
          else if (!isEmpty(active) && depth < nearEmptyDepth) {
            nearEmpty = index;
            nearEmptyDepth = depth;
          }
        }
      }
    }
    cards.forEach((card, index) => {
      const offset = ringOffset(index, active, people.length);
      const orbit = orbitStyle(offset, people.length);
      const previous = previousOffsets.get(card);
      card.dataset.side = offset === 0 ? 'c' : offset < 0 ? 'l' : 'r';
      card.style.setProperty('--fan', String(Math.sign(offset) * Math.min(Math.abs(offset), 3) * 3.5));
      card.classList.toggle('is-hidden-slot', hiddenSlots.has(index));
      card.classList.toggle('is-near-empty', index === nearEmpty);
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
      card.classList.toggle(
        'is-chat',
        index === active && (phase === 'expanding' || phase === 'chat' || phase === 'collapsing'),
      );
      const hidden = chatting;
      const inaccessible =
        ((hidden || window.innerWidth <= 600) && index !== active) ||
        (!hidden && Math.abs(offset) > 2) ||
        hiddenSlots.has(index);
      card.inert = inaccessible;
      card.setAttribute('aria-hidden', inaccessible ? 'true' : 'false');
      const reply = card.querySelector<HTMLTextAreaElement>('textarea')!;
      reply.tabIndex = index === active ? 0 : -1;
      card.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
        if (!button.classList.contains('send-button')) button.tabIndex = index === active ? 0 : -1;
      });
    });
    nav.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => {
      const offset = ringOffset(index, active, people.length);
      const orbit = orbitStyle(offset, people.length);
      button.style.setProperty('--avatar-x', `${orbit.avatarX * Math.min(window.innerWidth * 0.44, 218)}px`);
      button.style.setProperty('--avatar-chat-x', `${orbit.avatarX * 118}px`);
      button.style.setProperty('--avatar-y', `${orbit.avatarY}px`);
      button.style.setProperty('--avatar-scale', String(orbit.avatarScale));
      button.style.setProperty('--avatar-opacity', String(orbit.avatarOpacity));
      button.style.setProperty('--wash', orbit.wash);
      button.style.zIndex = String(orbit.z);
      button.inert = Math.abs(offset) > (mobile ? 2 : 3);
      button.tabIndex = index === active ? 0 : -1;
      button.classList.toggle('selected', index === active);
      button.setAttribute('aria-current', index === active ? 'true' : 'false');
    });
    updateBackground();
  };
  const switchTo = (index: number) => {
    const next = ((index % people.length) + people.length) % people.length;
    if (next === active) return;
    live.stopVoice();
    if (phase === 'chat' && !people[next]!.transcript) {
      closeChat();
    }
    if (phase === 'chat' || phase === 'expanding') saveEditor(active);
    animation?.cancel();
    active = next;
    restoreEditor(active);
    render();
    const selected = people[active]!.characterId;
    if (selected) void live.open(selected, cards[active]!);
    if (phase === 'chat') cards[active]!.querySelector('textarea')!.focus({ preventScroll: true });
  };
  const spatial = (card: HTMLElement, before: DOMRect) => {
    animation?.cancel();
    if (reduced.matches) return;
    const after = card.getBoundingClientRect();
    const dx = before.left + before.width / 2 - (after.left + after.width / 2);
    const dy = before.top + before.height / 2 - (after.top + after.height / 2);
    animation = card.animate(
      [
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${before.width / after.width}, ${before.height / after.height})`,
        },
        { transform: 'translate(-50%, -50%) scale(1)' },
      ],
      { duration: 340, easing: 'cubic-bezier(.2,.82,.24,1)' },
    );
  };
  const openChat = (focus = false) => {
    if (phase === 'chat' || phase === 'expanding') return;
    if (!people[active]!.transcript) {
      say('这个位置还没有新朋友');
      return;
    }
    if (dragStart && carousel.hasPointerCapture(dragStart.pointerId))
      carousel.releasePointerCapture(dragStart.pointerId);
    dragStart = undefined;
    dragged = false;
    carousel.classList.remove('is-dragging');
    deck.style.setProperty('--drag-x', '0px');
    const card = cards[active]!;
    const before = card.getBoundingClientRect();
    phase = 'expanding';
    render();
    spatial(card, before);
    const settle = () => {
      if (phase === 'expanding') {
        phase = 'chat';
        render();
      }
    };
    const opened = people[active]!.characterId;
    if (opened) void live.open(opened, card);
    if (reduced.matches) settle();
    else settleTimer = window.setTimeout(settle, 220);
    if (focus) card.querySelector('textarea')!.focus({ preventScroll: true });
  };
  const closeChat = () => {
    if (phase !== 'chat' && phase !== 'expanding') return;
    clearTimeout(settleTimer);
    settleTimer = 0;
    live.stopVoice();
    const card = cards[active]!;
    saveEditor(active);
    const wasFocused = document.activeElement === card.querySelector('textarea');
    const before = card.getBoundingClientRect();
    phase = 'collapsing';
    render();
    phase = 'browse';
    render();
    spatial(card, before);
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
    const [aura1, aura2, aura3] = person.card.aura;
    button.style.setProperty('--aura-1', aura1);
    button.style.setProperty('--aura-2', aura2);
    button.style.setProperty('--aura-3', aura3);
    button.addEventListener('click', () => switchTo(index));
    nav.append(button);
  });
  nav.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      switchTo(active + 1);
      nav.querySelector<HTMLButtonElement>('.selected')?.focus();
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      switchTo(active - 1);
      nav.querySelector<HTMLButtonElement>('.selected')?.focus();
    }
  });

  cards.forEach((card, index) => {
    const reply = card.querySelector<HTMLTextAreaElement>('textarea')!;
    const send = card.querySelector<HTMLButtonElement>('.send-button')!;
    const transcriptButton = card.querySelector<HTMLButtonElement>('.transcript-toggle');
    const transcript = card.querySelector<HTMLElement>('.transcript');
    card.addEventListener(
      'click',
      (event) => {
        if (dragged) {
          event.preventDefault();
          return;
        }
        if (index !== active && (phase === 'browse' || phase === 'hover')) {
          event.stopPropagation();
          switchTo(index);
          openChat(event.target instanceof Element && !!event.target.closest('textarea'));
          return;
        }
        if (event.target instanceof Element && event.target.closest('button,textarea')) return;
        if (phase === 'browse' || phase === 'hover') openChat(false);
      },
      true,
    );
    card.addEventListener('pointerenter', () => {
      if (phase === 'browse') {
        phase = 'hover';
        card.classList.add('is-hovered');
      }
    });
    card.addEventListener('pointerleave', () => {
      card.classList.remove('is-hovered');
      if (phase === 'hover') phase = 'browse';
    });
    card.querySelector<HTMLButtonElement>('.back-button')!.addEventListener('click', closeChat);
    card.querySelector<HTMLButtonElement>('.play-button')?.addEventListener('click', () => {
      const characterId = people[index]!.characterId;
      if (characterId) live.playWelcome(characterId);
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
    reply.addEventListener('focus', () => {
      if (index === active) openChat(false);
    });
    reply.addEventListener('input', () => {
      send.disabled = !reply.value.trim();
      const characterId = people[index]!.characterId;
      if (characterId) live.updateComposer(characterId);
      saveEditor(index);
    });
    reply.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send.click();
      }
      if (event.key === 'Escape' && !event.isComposing) closeChat();
    });
    send.addEventListener('click', () => {
      const draft = reply.value,
        value = draft.trim();
      if (!value) return;
      const characterId = people[index]!.characterId;
      if (!characterId) return;
      void live.send(characterId, value, card, () => {
        // Clear only the acknowledged draft, never newer typing during the request.
        if (reply.value === draft) {
          reply.value = '';
          saveEditor(index);
        }
        live.updateComposer(characterId);
      });
      reply.focus({ preventScroll: true });
    });
  });

  carousel.addEventListener('keydown', (event) => {
    if (event.target !== carousel || (phase !== 'browse' && phase !== 'hover')) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      switchTo(active + 1);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      switchTo(active - 1);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      openChat(true);
    }
  });
  carousel.addEventListener(
    'wheel',
    (event) => {
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
    },
    { passive: false },
  );
  carousel.addEventListener('pointerdown', (event) => {
    if (phase === 'chat' || phase === 'expanding' || phase === 'collapsing') return;
    if (event.target instanceof Element && event.target.closest('textarea,button')) return;
    dragStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    dragged = false;
  });
  carousel.addEventListener('pointermove', (event) => {
    if (phase !== 'browse' && phase !== 'hover') return;
    if (!dragStart || event.pointerId !== dragStart.pointerId) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    if (Math.abs(dx) < 7 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
    dragged = true;
    // A swipe never leaves a text selection behind.
    window.getSelection()?.removeAllRanges();
    carousel.classList.add('is-dragging');
    if (event.pointerType === 'mouse') carousel.setPointerCapture(event.pointerId);
    deck.style.setProperty('--drag-x', `${Math.max(-110, Math.min(110, dx * 0.45))}px`);
    updateBackground(active - Math.max(-1, Math.min(1, dx / 320)));
  });
  const endDrag = (event: PointerEvent) => {
    if (!dragStart || event.pointerId !== dragStart.pointerId) return;
    const dx = event.clientX - dragStart.x,
      dy = event.clientY - dragStart.y;
    const step = swipeStep(dx, dy, event.type === 'pointercancel');
    dragStart = undefined;
    carousel.classList.remove('is-dragging');
    deck.style.setProperty('--drag-x', '0px');
    if (dragged && step) switchTo(active + step);
    else updateBackground();
    if (dragged)
      setTimeout(() => {
        dragged = false;
      }, 0);
  };
  carousel.addEventListener('pointerup', endDrag);
  carousel.addEventListener('pointercancel', endDrag);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) closeChat();
  });
  reduced.addEventListener('change', () => updateBackground());
  window.addEventListener('resize', render);
  render();
  live.attach({
    say,
    head: root.querySelector<HTMLElement>('.site-head')!,
    card: (characterId) => cards[people.findIndex((person) => person.characterId === characterId)]!,
    mark: (characterId) => people.find((person) => person.characterId === characterId)!.mark,
    name: (characterId) => people.find((person) => person.characterId === characterId)!.name,
  });
}
