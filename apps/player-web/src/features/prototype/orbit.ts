/** Signed position on an odd-length visual ring, independent of business identity. */
export function ringOffset(index: number, active: number, count: number): number {
  const forward = (((index - active) % count) + count) % count;
  return forward > Math.floor(count / 2) ? forward - count : forward;
}

const cardX = [0, 0.382, 0.764, 0.98, 1.14, 1.12, 0.88, 0.48];
const cardY = [0, 8, 22, 42, 63, 80, 93, 102];
const cardScale = [1, 0.96, 0.91, 0.84, 0.77, 0.71, 0.66, 0.62];
const cardOpacity = [1, 0.83, 0.64, 0.28, 0.17, 0.11, 0.075, 0.045];
const avatarScale = [1, 0.86, 0.73, 0.6, 0.51, 0.44, 0.39, 0.35];
const avatarOpacity = [1, 0.88, 0.68, 0.44, 0.24, 0.11, 0.04, 0];

export function orbitStyle(offset: number, count: number) {
  const depth = Math.min(Math.abs(offset), 7);
  const sign = Math.sign(offset);
  const angle = (offset * 2 * Math.PI) / count;
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
