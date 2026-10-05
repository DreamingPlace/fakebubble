/** Signed position on an odd-length visual ring, independent of business identity. */
export function ringOffset(index: number, active: number, count: number): number {
  const forward = ((index - active) % count + count) % count;
  return forward > Math.floor(count / 2) ? forward - count : forward;
}

const cardX = [0, .382, .764, .98, 1.14, 1.12, .88, .48];
const cardY = [0, 8, 22, 42, 63, 80, 93, 102];
const cardScale = [1, .96, .91, .84, .77, .71, .66, .62];
const cardOpacity = [1, .83, .64, .28, .17, .11, .075, .045];
const avatarScale = [1, .86, .73, .6, .51, .44, .39, .35];
const avatarOpacity = [1, .88, .68, .44, .24, .11, .04, 0];

export function orbitStyle(offset: number, count: number) {
  const depth = Math.min(Math.abs(offset), 7);
  const sign = Math.sign(offset);
  const angle = offset * 2 * Math.PI / count;
  return {
    x: sign * cardX[depth]!,
    y: cardY[depth]!,
    scale: cardScale[depth]!,
    opacity: cardOpacity[depth]!,
    z: 100 - depth,
    avatarX: Math.sin(angle),
    avatarY: (1 - Math.cos(angle)) * 52,
    avatarScale: avatarScale[depth]!,
    avatarOpacity: avatarOpacity[depth]!,
    wash: `${Math.min(70, depth * 12)}%`,
  };
}
