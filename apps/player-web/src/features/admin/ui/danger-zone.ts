import { h } from '../../cocreation/h.ts';

/** How long the biggest actions have to be held (Framework3: "按住 1.5 秒"). */
export const HOLD_MS = 1500;

export type Impact = { n: string; label: string };
export type DangerZoneOptions = {
  /** The opener at the foot of its area, e.g. 删除角色 JOJO. */
  open: string;
  /** What the action touches, as numbers. May load when the zone opens. */
  impact?: () => Promise<readonly Impact[]> | readonly Impact[];
  /** One sentence at most, only when the numbers do not say it. */
  note?: string;
  /** The biggest actions: type this name, then hold the button. Without it one confirm button does it. */
  typeName?: string;
  /** Label of the final button; the hold variant reads "按住 1.5 秒…". */
  confirm: string;
  /** Runs when confirmed. A rejection leaves the zone open so the error can be read. */
  run: () => Promise<void>;
  /** Locks the controls while another request runs. */
  busy?: () => boolean;
  holdMs?: number;
  /** The opener's id and the typing field's accessible name (default: the field asks for the name). */
  openerId?: string;
  typeLabel?: string;
};

/**
 * Part 24b-6, shared piece 4: the danger zone replaces the modal confirms for destructive actions. A danger-outlined button at
 * the bottom of its area opens the zone in place (240 ms), which shows the impact numbers. The biggest actions then ask for the
 * typed name and a 1.5 s hold (a fill runs across the button; letting go early starts over); smaller ones have one confirm button.
 * Server calls and their parameters are the caller's, unchanged.
 */
export function dangerZone(options: DangerZoneOptions) {
  const opener = h('button', {
    class: 'dz-open',
    text: options.open,
    attrs: { type: 'button', 'aria-expanded': 'false', ...(options.openerId ? { id: options.openerId } : {}) },
  });
  const impactHost = h('div', { class: 'dz-impact' });
  const note = options.note ? h('p', { class: 'dz-note', text: options.note }) : null;
  const typed = options.typeName
    ? h('input', { class: 'dz-type', attrs: { type: 'text', 'aria-label': options.typeLabel ?? '输入名字确认', autocomplete: 'off' } })
    : null;
  // The hold variant carries a fill that sweeps across the button and a label above it; the plain one is just its text.
  const label = h('span', { class: 'dz-label' });
  const go = h(
    'button',
    { class: `dz-go${options.typeName ? ' is-hold' : ''}`, attrs: { type: 'button' } },
    ...(options.typeName ? [h('i', { attrs: { 'aria-hidden': 'true' } }), label] : []),
  );
  const zone = h(
    'div',
    { class: 'dz', attrs: { 'data-open': 'false' } },
    opener,
    h(
      'div',
      { class: 'dz-panel' },
      h(
        'div',
        { class: 'dz-inner' },
        h(
          'div',
          { class: 'dz-body' },
          impactHost,
          note,
          typed
            ? h(
                'label',
                { class: 'dz-field' },
                h('span', { text: options.typeLabel ?? `输入 ${options.typeName}` }),
                typed,
              )
            : null,
          go,
        ),
      ),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const matches = () => !typed || typed.value.trim() === options.typeName;
  const paint = () => {
    const locked = !!options.busy?.() || running;
    opener.disabled = locked && zone.dataset.open !== 'true';
    if (typed) typed.disabled = locked;
    go.disabled = locked || !matches();
    const text = typed ? (matches() ? `按住 1.5 秒${options.confirm}` : '输入名字后才能按') : options.confirm;
    if (typed) label.textContent = text;
    else go.textContent = text;
  };
  const stopHold = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    delete go.dataset.hold;
  };
  const fire = async () => {
    running = true;
    paint();
    try {
      await options.run();
    } finally {
      running = false;
      stopHold();
      paint();
    }
  };
  const startHold = () => {
    if (go.disabled || timer) return;
    go.dataset.hold = 'on';
    timer = setTimeout(() => {
      timer = null;
      delete go.dataset.hold;
      void fire();
    }, options.holdMs ?? HOLD_MS);
  };
  if (typed) {
    typed.addEventListener('input', () => {
      stopHold();
      paint();
    });
    go.addEventListener('pointerdown', startHold);
    go.addEventListener('pointerup', stopHold);
    go.addEventListener('pointerleave', stopHold);
    go.addEventListener('pointercancel', stopHold);
    go.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        startHold();
      }
    });
    go.addEventListener('keyup', stopHold);
    go.addEventListener('blur', stopHold);
  } else go.addEventListener('click', () => void fire());
  const setOpen = async (open: boolean) => {
    zone.dataset.open = String(open);
    opener.setAttribute('aria-expanded', String(open));
    if (!open) {
      stopHold();
      if (typed) typed.value = '';
      paint();
      return;
    }
    if (options.impact) {
      impactHost.replaceChildren(h('span', { class: 'dz-wait', text: '…' }));
      try {
        const impact = await options.impact();
        impactHost.replaceChildren(
          ...impact.map((item) =>
            h('span', { class: 'dz-card' }, h('b', { text: item.n }), item.label),
          ),
        );
      } catch {
        impactHost.replaceChildren(h('span', { class: 'dz-wait', text: '影响范围暂时读不到' }));
      }
    }
    paint();
    (typed ?? go).focus?.();
  };
  opener.addEventListener('click', () => void setOpen(zone.dataset.open !== 'true'));
  paint();
  return {
    root: zone,
    paint,
    close: () => void setOpen(false),
    get isOpen() {
      return zone.dataset.open === 'true';
    },
    dispose: stopHold,
  };
}
