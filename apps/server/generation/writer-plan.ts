/**
 * Part 58: the v8 writer thinks first, inside the same call. Its output is a short hidden plan between fixed markers, then the reply:
 *
 *   【读到】what the player's words really want (one line)
 *   【目的】what she wants the player to feel (one or two of AIMS, a few words of how)
 *   【回复】the reply lines
 *
 * The plan is for the owner only. `splitWriterOutput` is the one place that separates it, and it never lets a marker or plan text
 * through to the reply: a missing or malformed plan is dropped, and a marker found anywhere in the reply part is removed. A model
 * that drifts a little (half-width brackets, a colon after the marker, markdown bold) is still understood.
 */
export const PLAN_READ = '读到';
export const PLAN_AIM = '目的';
export const PLAN_REPLY = '回复';

/** The closed list of purposes; the writer's own wording may add a few words after one. */
export const AIMS = ['被接住', '被关心', '心动', '开心', '惊喜', '被认真对待'] as const;
export type Aim = (typeof AIMS)[number];
export const MAX_RECENT_AIMS = 3;

export interface WriterPlan {
  read: string;
  aim: string;
  aims: Aim[];
}

/** 【读到】 / [目的] / 【回复】：  with an optional colon, and markdown bold stars around it. */
const MARKER = /\**[【[［〖]\s*(读到|目的|回复)\s*[】\]］〗]\**\s*[：:]?/gu;
const hasMarker = (text: string) => new RegExp(MARKER.source, 'u').test(text);
const dropMarkers = (text: string) => text.replace(MARKER, '');
const clip = (text: string, max: number) => [...text.trim().replace(/\s+/gu, ' ')].slice(0, max).join('');

/**
 * The closed-list purposes a 目的 line names, in the order they appear, at most two. Only the part before the first colon counts
 * (the words after it say how, and may mention another word), or the whole line when there is no colon.
 */
export function aimsOf(line: string): Aim[] {
  const label = line.split(/[：:]/u)[0]!;
  const found: { at: number; aim: Aim }[] = [];
  for (const aim of AIMS) {
    const at = label.indexOf(aim);
    if (at >= 0) found.push({ at, aim });
  }
  return found
    .sort((a, b) => a.at - b.at)
    .slice(0, 2)
    .map((item) => item.aim);
}

/** The plan in the text before the reply (or the whole malformed text): what follows 【读到】 and 【目的】 up to the next marker. */
function planOf(head: string): WriterPlan | null {
  const marks = [...head.matchAll(MARKER)];
  const section = (name: string) => {
    const at = marks.findIndex((mark) => mark[1] === name);
    if (at < 0) return null;
    const from = marks[at]!.index + marks[at]![0].length;
    const to = marks[at + 1]?.index ?? head.length;
    return head.slice(from, to).replace(/^[\s*：:]+|\**\s*$/gu, '');
  };
  const read = section(PLAN_READ),
    aim = section(PLAN_AIM);
  if (read === null || aim === null) return null;
  const aims = aimsOf(aim);
  if (!clip(read, 80) || !aims.length) return null;
  return { read: clip(read, 80), aim: clip(aim, 80), aims };
}

/**
 * Splits the model's raw output. The reply is what follows the first 【回复】. With no marker at all, the whole output is the reply.
 * With a marker but no 【回复】 (malformed), every line that carries a marker is plan text and is removed; the rest is the reply
 * (a plan line with no marker of its own cannot be told from a reply line and is not guessed at). Stray markers inside the reply
 * are removed too.
 */
export function splitWriterOutput(raw: string): { reply: string; plan: WriterPlan | null } {
  if (!hasMarker(raw)) return { reply: raw, plan: null };
  const replyMark = [...raw.matchAll(MARKER)].find((mark) => mark[1] === PLAN_REPLY);
  if (replyMark) {
    const head = raw.slice(0, replyMark.index);
    return { reply: dropMarkers(raw.slice(replyMark.index + replyMark[0].length)), plan: planOf(head) };
  }
  const lines = raw.split(/\r\n|\r|\n/u);
  return {
    reply: lines.filter((line) => !hasMarker(line)).join('\n'),
    plan: planOf(lines.filter(hasMarker).join('\n')),
  };
}
