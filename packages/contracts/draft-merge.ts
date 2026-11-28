/**
 * Part 55: a three-way merge of two edits of one document, field by field. `base` is what both sides started from, `mine` is the edit
 * being saved, `theirs` is what is stored now. A field changed on one side only is taken from that side; a field changed on both sides
 * to the same value is taken once; a field changed on both sides to different values is a CONFLICT and is named, never merged.
 *
 * A document is read as a flat map of "field paths" (see `fieldsOf`); the caller decides the granularity (which objects are fields
 * and which are looked into) and how a path is written back. Pure: nothing here reads or writes storage.
 */
export type Fields = ReadonlyMap<string, unknown>;

const same = (a: unknown, b: unknown) => stable(a) === stable(b);
export function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(',')}}`;
}

export type FieldMerge = { values: Map<string, unknown>; conflicts: string[]; changedByMe: string[] };

/** Per field: the merged value (`undefined` = the field is absent), the fields both sides changed differently, the fields taken from `mine`. */
export function mergeFields(base: Fields, mine: Fields, theirs: Fields): FieldMerge {
  const paths = new Set([...base.keys(), ...mine.keys(), ...theirs.keys()]);
  const values = new Map<string, unknown>();
  const conflicts: string[] = [];
  const changedByMe: string[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path),
      m = mine.get(path),
      t = theirs.get(path);
    const mineChanged = !same(b, m),
      theirsChanged = !same(b, t);
    if (mineChanged && theirsChanged && !same(m, t)) {
      conflicts.push(path);
      continue;
    }
    if (mineChanged) {
      values.set(path, m);
      changedByMe.push(path);
    } else values.set(path, t);
  }
  return { values, conflicts, changedByMe };
}
