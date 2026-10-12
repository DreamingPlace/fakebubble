/** Only build-generated, content-addressed static paths qualify, after manifest/byte verification. */
export function playerAssetCacheControl(path: string): string {
  return /^assets\/(?:[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js|static-[a-f0-9]{64}\.(?:css|svg|png|jpe?g|webp|woff2))$/.test(path)
    ? 'public, max-age=31536000, immutable'
    : path === 'favicon.ico'
      ? 'public, max-age=86400'
      : 'no-store';
}
