/** Tiny element builder. Text always goes through textContent, so player- or admin-supplied strings are never parsed as HTML. */
type Props = { class?: string; text?: string; attrs?: Record<string, string>; hidden?: boolean };
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  if (props.hidden) node.hidden = true;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
/** Code points, like the server counts them. */
export const length = (value: string) => [...value].length;
