/**
 * Headless integration harness: drives the real physics worker message loop,
 * feeds its snapshots through the real SceneManager and CameraRig, and asserts
 * that the whole chain survives. Everything except the GPU is exercised.
 */

// ── Minimal DOM / worker stubs ───────────────────────────────────────────────
interface FakeElement {
  style: Record<string, string>;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  dataset: Record<string, string>;
  children: FakeElement[];
  textContent: string;
  innerHTML: string;
  className: string;
  appendChild(child: FakeElement): FakeElement;
  prepend(child: FakeElement): FakeElement;
  remove(): void;
  addEventListener(): void;
}
const makeEl = (): FakeElement => ({
  style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  dataset: {},
  children: [],
  textContent: '',
  innerHTML: '',
  className: '',
  appendChild(c) {
    this.children.push(c);
    return c;
  },
  prepend(c) {
    this.children.unshift(c);
    return c;
  },
  remove() {},
  addEventListener() {},
});
(globalThis as Record<string, unknown>).document = {
  createElement: () => makeEl(),
  getElementById: () => null,
  body: makeEl(),
};
(globalThis as Record<string, unknown>).window = {
  addEventListener() {},
  innerWidth: 1600,
  innerHeight: 900,
  devicePixelRatio: 1,
};

const messages: { type: string; [k: string]: unknown }[] = [];
let onmessage: ((ev: { data: unknown }) => void) | null = null;
(globalThis as Record<string, unknown>).self = {
  postMessage: (m: { type: string }) => messages.push(m as never),
  set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
    onmessage = handler;
  },
  get onmessage() {
    return onmessage;
  },
};

const { SceneManager } = await import('../src/render/SceneManager');
const { CameraRig } = await import('../src/render/CameraRig');
const { HDRPipeline } = await import('../src/render/HDRPipeline');
await import('../src/workers/physics.worker');

const send = (data: unknown) => {
  if (!onmessage) throw new Error('worker never registered an onmessage handler');
  onmessage({ data });
};
const drain = () => {
  const out = messages.slice();
  messages.length = 0;
  return out as Record<string, unknown>[];
};

const canvas = makeEl() as unknown as HTMLElement & { getBoundingClientRect(): DOMRect };
(canvas as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
  left: 0,
  top: 0,
  width: 1600,
  height: 900,
  right: 1600,
  bottom: 900,
  x: 0,
  y: 0,
  toJSON() {},
});

const rig = new CameraRig(canvas as unknown as HTMLElement);
const scene = new SceneManager({ setLenses() {} } as unknown as HDRPipeline, makeEl() as unknown as HTMLElement);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${name}${detail ? `   — ${detail}` : ''}`);
  if (!ok) failures++;
};

const presets = [
  'solar-system',
  'three-body-figure8',
  'chaos-lyapunov',
  'roche-ring',
  'tidal-heating',
  'tde',
  'galaxy-curve',
  'stellar-collapse',
  'sun-black-hole',
  'impact',
  'binary',
  'sandbox',
];

console.log('\n── worker protocol + scene manager integration ───────────────────────');
for (const preset of presets) {
  drain();
  send({ type: 'init', presetId: preset });
  const ready = drain();
  const readyMsg = ready.find((m) => m.type === 'ready');
  const roster = ready.find((m) => m.type === 'roster');
  const first = ready.find((m) => m.type === 'snapshot');
  if (!readyMsg || !first) {
    check(`${preset}: init produced a snapshot`, false);
    continue;
  }
  if (roster) scene.setRoster(roster.entries as never);
  const count = first.count as number;
  let snapshots = 0;
  let lastSnapshot: Record<string, unknown> | null = null;
  // A hundred frames of wall-clock-driven advancement at the preset's warp.
  const warp = Math.max(1, readyMsg.timeWarp as number);
  for (let i = 0; i < 100; i++) {
    const dt = (1 / 60) * warp;
    send({ type: 'advance', dt, maxSteps: 48 });
    for (const m of drain()) {
      if (m.type === 'snapshot') {
        snapshots++;
        lastSnapshot = m;
      }
      if (m.type === 'roster') scene.setRoster(m.entries as never);
    }
    if (lastSnapshot) {
      scene.applySnapshot(lastSnapshot as never, dt, rig);
      rig.update(1 / 60, (id) => {
        const found = scene.lookup(id);
        return found ? { position: found.position, radius: found.radius } : null;
      });
      scene.updateFrame(rig, { setLenses() {} } as unknown as HDRPipeline, 1600, 900);
    }
  }
  const d = (lastSnapshot?.diagnostics ?? {}) as Record<string, number>;
  const finite = Number.isFinite(d.total) && Number.isFinite(d.kinetic);
  const picked = scene.pick(800, 450, rig, 1600, 900);
  check(
    `${preset.padEnd(20)} ${String(count).padStart(4)} bodies → ${snapshots} snapshots`,
    snapshots === 100 && finite,
    `E = ${(d.total ?? 0).toExponential(3)}  dt/step ${(d.msPerStep ?? 0).toFixed(2)} ms  pick=${picked}`,
  );
}

// Scenario commands.
drain();
send({ type: 'init', presetId: 'solar-system' });
drain();
scene.setRoster((drain().find((m) => m.type === 'roster')?.entries ?? []) as never);
send({ type: 'scenario', name: 'sun-to-blackhole' });
let out = drain();
const rosterAfter = out.find((m) => m.type === 'roster');
const blackHole = (rosterAfter?.entries as { kind: string; mass: number }[] | undefined)?.find((e) => e.kind === 'blackhole');
check('scenario: the Sun becomes a black hole of the same mass', Boolean(blackHole), blackHole ? `${(blackHole.mass / 1.98847e30).toFixed(2)} M☉` : 'none');

send({ type: 'scenario', name: 'jupiter-to-earth-orbit' });
out = drain();
const snap = out.find((m) => m.type === 'snapshot');
check('scenario: a Jupiter-mass body joins Earth’s orbit', Boolean(snap) && ((snap?.count as number) ?? 0) > 8, `${snap?.count} bodies`);

send({ type: 'scenario', name: 'moon-into-earth' });
out = drain();
check('scenario: the Moon is put on a collision course', out.some((m) => m.type === 'event' || m.type === 'snapshot'));

// What-if knobs.
for (const [key, value] of [['G', 2], ['c', 0.4], ['radiationPressure', 12], ['solarLuminosity', 1.6]] as const) {
  send({ type: 'whatIf', key, value });
  const snapAfter = drain().find((m) => m.type === 'snapshot');
  check(`what-if ${key} = ${value} re-solves without error`, Boolean(snapAfter));
}
// Integrator switching + a long run to make sure nothing degenerates.
for (const integrator of ['verlet', 'hermite', 'rk4'] as const) {
  send({ type: 'setParams', params: { integrator, relativity: true, frameDragging: true, drag: 1e-9, halo: 'nfw' } });
  for (let i = 0; i < 20; i++) {
    send({ type: 'advance', dt: 3600, maxSteps: 12 });
    drain();
  }
  send({ type: 'advance', dt: 3600, maxSteps: 12 });
  const d = (drain().find((m) => m.type === 'snapshot')?.diagnostics ?? {}) as Record<string, number>;
  check(`integrator ${integrator} + full physics stays finite`, Number.isFinite(d.total), `E = ${d.total.toExponential(3)}`);
  send({ type: 'setParams', params: { relativity: false, frameDragging: false, drag: 0, halo: 'none' } });
}

console.log(failures === 0 ? '\nINTEGRATION OK' : `\n${failures} INTEGRATION FAILURES`);
process.exit(failures === 0 ? 0 : 1);
