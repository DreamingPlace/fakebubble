import { MAX_SHAPES, shapesFor, type Mode, type Shape, type Skin, type Surface } from './palette-skin.ts';

/**
 * Part 24k-2: puts a character's 主色 + 点缀 on a surface. The colours become custom properties for both modes (CSS picks by
 * `html[data-theme]`); the shapes are static blurred ellipses behind the content (transform / opacity only, at most 5 per surface),
 * generated from the character id. Everything is set through the CSSOM (no inline style attributes), so the page's CSP is untouched.
 */
const MODES: Mode[] = ['night', 'day'];
const KEY: Record<Mode, string> = { night: 'n', day: 'd' };

/** The colour variables of one character, on the element that wraps its card and its chat. */
export function setSkinProperties(element: HTMLElement, skin: { night: Skin; day: Skin }) {
  for (const mode of MODES) {
    const k = KEY[mode],
      s = skin[mode];
    element.style.setProperty(`--pk-${k}-main`, s.main);
    element.style.setProperty(`--pk-${k}-glow`, s.glow);
    element.style.setProperty(`--pk-${k}-a1`, s.accents[0]);
    element.style.setProperty(`--pk-${k}-a2`, s.accents[1]);
    element.style.setProperty(`--pk-${k}-t1`, s.accentText[0]);
    element.style.setProperty(`--pk-${k}-name`, s.nameLight);
    element.style.setProperty(`--pk-${k}-glyph`, s.glyph);
  }
  element.dataset.skin = '1';
}

function shapeElement(shape: Shape): HTMLElement {
  const el = document.createElement('i');
  el.className = `pk-shape pk-${shape.kind}`;
  const v = (name: string, value: string | number) => el.style.setProperty(name, String(value));
  v('--x', `${shape.x}%`);
  v('--y', `${shape.y}%`);
  v('--w', `${shape.w}%`);
  v('--h', `${shape.h}%`);
  v('--r', `${shape.rotate}deg`);
  v('--blur', `${shape.blur}px`);
  v('--o', shape.opacity);
  v('--c-n', `var(--pk-n-${shape.colour === 'glow' ? 'glow' : `a${shape.colour + 1}`})`);
  v('--c-d', `var(--pk-d-${shape.colour === 'glow' ? 'glow' : `a${shape.colour + 1}`})`);
  return el;
}

/** The shape layer of one surface, as the first child of `host` (z-index -1 inside the host's own stacking context). */
export function mountShapes(host: HTMLElement, characterId: string, surface: Surface) {
  host.querySelector(`:scope > .pk-shapes[data-surface="${surface}"]`)?.remove();
  const layer = document.createElement('div');
  layer.className = 'pk-shapes';
  layer.dataset.surface = surface;
  layer.setAttribute('aria-hidden', 'true');
  for (const shape of shapesFor(characterId, surface).slice(0, MAX_SHAPES)) layer.append(shapeElement(shape));
  host.prepend(layer);
  return layer;
}
