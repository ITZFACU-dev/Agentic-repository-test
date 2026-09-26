/** Minimal DOM helpers — no framework, no virtual DOM, no dependencies. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function panel(className: string, parent: HTMLElement): HTMLDivElement {
  const p = el('div', `panel ${className}`);
  parent.appendChild(p);
  return p;
}

export function section(parent: HTMLElement, title: string): HTMLDivElement {
  const s = el('div', 'section');
  s.appendChild(el('h2', undefined, title));
  parent.appendChild(s);
  return s;
}

export function kvRow(parent: HTMLElement, label: string, value = '—'): { row: HTMLDivElement; value: HTMLElement } {
  const row = el('div', 'kv');
  row.appendChild(el('span', undefined, label));
  const v = el('b', undefined, value);
  row.appendChild(v);
  parent.appendChild(row);
  return { row, value: v };
}

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  value: number;
  label: string;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

export function slider(parent: HTMLElement, opts: SliderOptions): { row: HTMLDivElement; set: (v: number) => void } {
  const row = el('div', 'row');
  const wrap = el('div');
  wrap.style.flex = '1';
  const label = el('label', undefined, opts.label);
  label.style.display = 'block';
  label.style.marginBottom = '1px';
  const input = el('input');
  input.type = 'range';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  const value = el('span', 'value', opts.format ? opts.format(opts.value) : String(opts.value));
  const head = el('div', 'row');
  head.style.margin = '0';
  head.appendChild(label);
  head.appendChild(value);
  wrap.appendChild(head);
  wrap.appendChild(input);
  row.appendChild(wrap);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.textContent = opts.format ? opts.format(v) : String(v);
    opts.onInput(v);
  });
  parent.appendChild(row);
  return {
    row,
    set(v: number) {
      input.value = String(v);
      value.textContent = opts.format ? opts.format(v) : String(v);
    },
  };
}

export function toggle(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): HTMLDivElement {
  const row = el('div', 'row');
  row.appendChild(el('label', undefined, label));
  const sw = el('div', `switch${value ? ' on' : ''}`);
  sw.addEventListener('click', () => {
    const next = !sw.classList.contains('on');
    sw.classList.toggle('on', next);
    onChange(next);
  });
  row.appendChild(sw);
  parent.appendChild(row);
  return row;
}

export function segmented<T extends string>(
  parent: HTMLElement,
  label: string,
  options: { id: T; label: string; title?: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLDivElement {
  const wrap = el('div');
  wrap.style.margin = '8px 0';
  if (label) {
    const l = el('label', undefined, label);
    l.style.display = 'block';
    l.style.marginBottom = '4px';
    wrap.appendChild(l);
  }
  const seg = el('div', 'seg');
  const buttons: HTMLButtonElement[] = [];
  for (const opt of options) {
    const b = el('button', opt.id === value ? 'active' : undefined, opt.label);
    if (opt.title) b.title = opt.title;
    b.addEventListener('click', () => {
      for (const other of buttons) other.classList.remove('active');
      b.classList.add('active');
      onChange(opt.id);
    });
    buttons.push(b);
    seg.appendChild(b);
  }
  wrap.appendChild(seg);
  parent.appendChild(wrap);
  return wrap;
}

export function button(parent: HTMLElement, label: string, onClick: () => void, className?: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

/** Human-readable numbers for the HUD. */
export const fmt = {
  metres(v: number): string {
    const a = Math.abs(v);
    // 0.01 AU is about where "kilometres" stops being the natural unit.
    if (a >= 1.495978707e9) return `${(v / 1.495978707e11).toPrecision(4)} AU`;
    if (a >= 1e9) return `${(v / 1e9).toPrecision(4)} Gm`;
    if (a >= 1e4) return `${(v / 1e3).toPrecision(4)} km`;
    return `${v.toPrecision(4)} m`;
  },
  mass(v: number): string {
    const a = Math.abs(v);
    if (a >= 1.98847e30) return `${(v / 1.98847e30).toPrecision(4)} M☉`;
    if (a >= 5.97217e24) return `${(v / 5.97217e24).toPrecision(4)} M⊕`;
    if (a >= 1e21) return `${(v / 1e21).toPrecision(4)} Zg`;
    if (a >= 1e3) return `${(v / 1e3).toPrecision(4)} t`;
    return `${v.toPrecision(4)} kg`;
  },
  speed(v: number): string {
    const a = Math.abs(v);
    if (a >= 1e8) return `${(v / 299792458).toPrecision(4)} c`;
    if (a >= 1e3) return `${(v / 1e3).toPrecision(4)} km/s`;
    return `${v.toPrecision(4)} m/s`;
  },
  time(v: number): string {
    const a = Math.abs(v);
    if (a >= 3.15576e7 * 1e6) return `${(v / (3.15576e7 * 1e6)).toPrecision(4)} Myr`;
    if (a >= 3.15576e7) return `${(v / 3.15576e7).toPrecision(4)} yr`;
    if (a >= 86400) return `${(v / 86400).toPrecision(4)} d`;
    if (a >= 3600) return `${(v / 3600).toPrecision(4)} h`;
    if (a >= 60) return `${(v / 60).toPrecision(4)} min`;
    return `${v.toPrecision(4)} s`;
  },
  energy(v: number): string {
    const a = Math.abs(v);
    if (a >= 1e40) return `${(v / 1e40).toPrecision(3)}×10⁴⁰ J`;
    return `${v.toExponential(3)} J`;
  },
  /** Power: watts up to a solar luminosity, then L☉ (quasars need it). */
  power(v: number): string {
    const a = Math.abs(v);
    if (!(a > 0)) return '—';
    if (a >= 1e26) return `${(v / 3.828e26).toPrecision(4)} L☉`;
    if (a >= 1e9) return `${(v / 1e9).toPrecision(4)} GW`;
    if (a >= 1e3) return `${(v / 1e3).toPrecision(4)} kW`;
    return `${v.toPrecision(4)} W`;
  },
  temp(v: number): string {
    return `${v.toPrecision(4)} K`;
  },
  angle(v: number): string {
    return `${((v * 180) / Math.PI).toPrecision(4)}°`;
  },
  num(v: number, digits = 4): string {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(digits - 1);
    return v.toPrecision(digits);
  },
};

/**
 * Logarithmic time-warp ladder. Each rung is a factor of the previous one, so
 * the slider feels uniform: one second of wall time becomes one second of
 * simulated time at the bottom, one million years at the top.
 */
export const WARP_LADDER = [
  1, 5, 30, 300, 3600, 21600, 86400, 604800, 2.6298e6, 3.15576e7, 3.15576e8, 3.15576e9, 3.15576e10, 3.15576e11,
  3.15576e12, 3.15576e13,
];

export function warpLabel(warp: number): string {
  if (warp <= 1) return '1 s = 1 s (real time)';
  return `1 s = ${fmt.time(warp)}`;
}
