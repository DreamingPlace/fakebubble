export const PLAYER_FRAMES = [
    { id: 'soft', label: '柔光', ring: ['#FFB295', '#BBA4FF', '#97C8F5'] },
    { id: 'peach', label: '蜜桃', ring: ['#E8561E', '#FFB295', '#FFEBC9'] },
    { id: 'sky', label: '天空', ring: ['#2F7BEA', '#97C8F5', '#D5F6EE'] },
    { id: 'mint', label: '薄荷', ring: ['#1F9E7A', '#8FD9BE', '#D5F6EE'] },
    { id: 'grape', label: '葡萄', ring: ['#7C4DEB', '#BBA4FF', '#FFD8EE'] },
    { id: 'ink', label: '墨', ring: ['#141414', '#4A4A4A', '#141414'] },
];
export const DEFAULT_FRAME = 'soft';
export const isFrameId = (value) => PLAYER_FRAMES.some((frame) => frame.id === value);
/** The frame of a character: ring accent, deep cloud, light cloud; the fill is the card's own two clouds. */
export function characterFrame(aura) {
    return { ring: [aura[3], aura[2], aura[1]], fill: [aura[2], aura[1]] };
}
export function playerFrame(id) {
    const frame = PLAYER_FRAMES.find((entry) => entry.id === id) ?? PLAYER_FRAMES[0];
    return { ring: frame.ring, fill: ['#F2EEE9', '#E9E2F2'] };
}
/** Custom properties through the CSSOM (strict CSP: no style attribute). `prefix` names the set: --frame-a... or --own-a... */
export function setFrameProperties(element, frame, prefix) {
    const names = ['a', 'b', 'c'];
    names.forEach((name, i) => element.style.setProperty(`--${prefix}-${name}`, frame.ring[i]));
    element.style.setProperty(`--${prefix}-f1`, frame.fill[0]);
    element.style.setProperty(`--${prefix}-f2`, frame.fill[1]);
}
