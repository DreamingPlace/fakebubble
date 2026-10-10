/**
 * A small in-memory DOM for component tests: elements, text nodes, classes, attributes, events with bubbling and a
 * selector engine for the shapes the components use (tag, .class, #id, [attr], [attr="v"], :not([attr]), descendant
 * and comma). It exists so tests can drive real component code without a browser or a new dependency.
 */
type Handler = (event: FakeEvent) => void;
export type FakeEvent = {
  type: string;
  target: FakeNode;
  key?: string;
  isComposing?: boolean;
  shiftKey?: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

export class FakeNode {
  parent: FakeElement | null = null;
  textContentValue = '';
  get isText() {
    return true;
  }
  get textContent(): string {
    return this.textContentValue;
  }
  set textContent(value: string) {
    this.textContentValue = value;
  }
  remove() {
    this.parent?.removeChild(this);
  }
}
const parseSelector = (selector: string) =>
  selector.split(',').map((part) =>
    part
      .trim()
      .split(/\s+/)
      .map((compound) => {
        // Class, id and tag are read from the compound without its [attr="v"] and :not(...) parts, whose values may contain dots.
        const bare = compound.replace(/\[[^\]]*\]/g, '').replace(/:not\([^)]*\)/g, '');
        const tag = /^[a-zA-Z][\w-]*/.exec(bare)?.[0];
        const classes = [...bare.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
        const id = /#([\w-]+)/.exec(bare)?.[1];
        const attrs = [...compound.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g)].map((m) => ({
          name: m[1]!,
          value: m[2] ?? m[3],
        }));
        const not = [...compound.matchAll(/:not\(\[([\w-]+)\]\)/g)].map((m) => m[1]!);
        return { tag, classes, id, attrs, not };
      }),
  );

export class FakeElement extends FakeNode {
  tagName: string;
  children: (FakeElement | FakeText)[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, { fn: Handler; capture: boolean }[]>();
  value = '';
  checked = false;
  scrollTop = 0;
  scrollLeft = 0;
  clientWidth = 0;
  scrollWidth = 0;
  focused = false;
  style = {
    values: new Map<string, string>(),
    getPropertyValue(name: string) {
      return this.values.get(name) ?? '';
    },
    setProperty(name: string, value: string) {
      this.values.set(name, value);
    },
  };
  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }
  override get isText() {
    return false;
  }
  get className() {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', value);
  }
  get classList() {
    const owner = this;
    const names = () => owner.className.split(/\s+/).filter(Boolean);
    return {
      add: (...n: string[]) => (owner.className = [...new Set([...names(), ...n])].join(' ')),
      remove: (...n: string[]) =>
        (owner.className = names()
          .filter((c) => !n.includes(c))
          .join(' ')),
      contains: (n: string) => names().includes(n),
      toggle(n: string, force?: boolean) {
        const on = force ?? !names().includes(n);
        if (on) this.add(n);
        else this.remove(n);
        return on;
      },
    };
  }
  get id() {
    return this.attributes.get('id') ?? '';
  }
  get dataset() {
    const owner = this;
    return new Proxy({} as Record<string, string>, {
      get: (_, key: string) =>
        owner.attributes.get(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_, key: string, value: string) => {
        owner.attributes.set(`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }
  get hidden() {
    return this.attributes.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }
  get disabled() {
    return this.attributes.has('disabled');
  }
  set disabled(value: boolean) {
    if (value) this.attributes.set('disabled', '');
    else this.attributes.delete('disabled');
  }
  get type() {
    return this.attributes.get('type') ?? '';
  }
  set type(value: string) {
    this.attributes.set('type', value);
  }
  get placeholder() {
    return this.attributes.get('placeholder') ?? '';
  }
  set placeholder(value: string) {
    this.attributes.set('placeholder', value);
  }
  get children_() {
    return this.children;
  }
  override get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  override set textContent(value: string) {
    this.children.forEach((child) => (child.parent = null));
    this.children = [];
    if (value !== '') this.append(new FakeText(value));
  }
  set innerHTML(value: string) {
    if (value !== '') throw new Error('FakeElement: components must not parse HTML; use textContent');
    this.textContent = '';
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  append(...nodes: (FakeElement | FakeText | string)[]) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      child.remove();
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes: (FakeElement | FakeText)[]) {
    this.children.forEach((child) => (child.parent = null));
    this.children = [];
    this.append(...nodes);
  }
  removeChild(child: FakeNode) {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
  }
  contains(other: unknown): boolean {
    for (let node = other as FakeNode | null; node; node = node.parent) if (node === this) return true;
    return false;
  }
  addEventListener(type: string, fn: Handler, capture: boolean | { capture?: boolean } = false) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture: capture === true || (typeof capture === 'object' && !!capture.capture) });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: Handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry.fn !== fn),
    );
  }
  dispatch(type: string, extra: Partial<FakeEvent> = {}) {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      ...extra,
    };
    for (let node: FakeElement | null = this; node; node = node.parent)
      for (const entry of [...(node.listeners.get(type) ?? [])]) entry.fn(event);
    return event;
  }
  /** A click on a disabled control does nothing, as in a browser. */
  click() {
    if (this.disabled) return;
    this.dispatch('click');
  }
  /** Types into a textarea or input: sets the value and fires `input`. */
  type_(text: string) {
    this.value = text;
    this.dispatch('input');
  }
  focus() {
    const doc = (globalThis as unknown as { document: FakeDocument }).document;
    doc.activeElement = this;
    this.focused = true;
  }
  scrollIntoView() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  matches(selector: string) {
    return parseSelector(selector).some((chain) => this.matchesCompound(chain.at(-1)!));
  }
  private matchesCompound(c: ReturnType<typeof parseSelector>[number][number]) {
    return (
      (!c.tag || this.tagName === c.tag.toUpperCase()) &&
      c.classes.every((cls) => this.classList.contains(cls)) &&
      (!c.id || this.id === c.id) &&
      c.attrs.every((a) =>
        a.value === undefined ? this.attributes.has(a.name) : this.attributes.get(a.name) === a.value,
      ) &&
      c.not.every((name) => !this.attributes.has(name))
    );
  }
  querySelectorAll(selector: string): FakeElement[] {
    const chains = parseSelector(selector);
    const out: FakeElement[] = [];
    const walk = (node: FakeElement, ancestors: FakeElement[]) => {
      for (const child of node.children) {
        if (child.isText) continue;
        const el = child as FakeElement;
        const path = [...ancestors, el];
        if (
          chains.some((chain) => {
            if (!el.matchesCompound(chain.at(-1)!)) return false;
            let at = path.length - 2;
            for (let i = chain.length - 2; i >= 0; i--) {
              while (at >= 0 && !path[at]!.matchesCompound(chain[i]!)) at--;
              if (at < 0) return false;
              at--;
            }
            return true;
          })
        )
          out.push(el);
        walk(el, path);
      }
    };
    walk(this, []);
    return out;
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
export class FakeText extends FakeNode {
  constructor(text: string) {
    super();
    this.textContentValue = text;
  }
}
export class FakeDocument {
  body = new FakeElement('body');
  documentElement = new FakeElement('html');
  activeElement: FakeElement | null = null;
  listeners = new Map<string, Handler[]>();
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(text: string) {
    return new FakeText(text);
  }
  addEventListener(type: string, fn: Handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  /** Fires a document-level listener (Escape, outside click). */
  fire(type: string, extra: Partial<FakeEvent> = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])])
      fn({ type, target: this.body, defaultPrevented: false, preventDefault() {}, stopPropagation() {}, ...extra });
  }
}

/** Installs a fresh document for one test and restores the previous global afterwards. */
export function installFakeDom(t: { after(fn: () => void): void }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new FakeDocument();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  // `Node` is the base class components test `instanceof` against.
  const previousNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: FakeNode });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousNode) Object.defineProperty(globalThis, 'Node', previousNode);
    else Reflect.deleteProperty(globalThis, 'Node');
  });
  return document;
}
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
