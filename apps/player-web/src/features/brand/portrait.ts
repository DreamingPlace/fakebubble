/**
 * Part 31b: a character's picture inside an avatar circle. The circle already shows the initials; the picture is laid over them.
 * States (data-portrait on the host): `loading` (a pale glow, the initials stay, nothing moves), `loaded` (the picture fades in over
 * 220 ms, never shifting the layout), and on any failure the picture is removed and the host is back to initials, silently.
 * The image is decorative (alt empty) and addressed by the sha256 of its content, so the browser caches it for good.
 */
const PORTRAIT_URL = /^\/api\/web\/provider\/public-image\/[a-f0-9]{64}$/;
export const isPortraitUrl = (value: unknown): value is string => typeof value === 'string' && PORTRAIT_URL.test(value);

export function mountPortrait(host: HTMLElement, url: string | null | undefined, options: { eager?: boolean } = {}) {
  if (!isPortraitUrl(url)) return;
  const image = document.createElement('img');
  image.className = 'portrait';
  image.alt = '';
  image.decoding = 'async';
  image.loading = options.eager ? 'eager' : 'lazy';
  image.draggable = false;
  host.classList.add('has-portrait');
  host.dataset.portrait = 'loading';
  image.addEventListener('load', () => {
    host.dataset.portrait = 'loaded';
  });
  image.addEventListener('error', () => {
    image.remove();
    host.classList.remove('has-portrait');
    delete host.dataset.portrait;
  });
  image.src = url;
  host.append(image);
}
