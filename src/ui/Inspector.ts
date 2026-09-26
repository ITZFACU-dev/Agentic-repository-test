/**
 * Telemetry panel: everything the physics engine knows about the selected body,
 * in the units a student would actually use (AU, km/s, Earth masses, K).
 *
 * Nothing here is decorative: each row is a quantity that the engine computes
 * from the real equations — Keplerian elements from the state vector, the Roche
 * and Hill radii from the primary's mass, temperatures from the radiative
 * balance, and the HZ role from the star's luminosity.
 */

import { el, fmt, kvRow, section } from './dom';
import type { BodyTelemetry } from '../sim/protocol';
import { EnergyGraph } from './EnergyGraph';
import { AU, SOLAR_MASS } from '../core/units';

export class Inspector {
  readonly root: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private kindEl: HTMLDivElement;
  readonly energy: EnergyGraph;
  private orbitRows: Record<string, HTMLElement> = {};
  private physRows: Record<string, HTMLElement> = {};
  private thermalRows: Record<string, HTMLElement> = {};
  private systemRows: Record<string, HTMLElement> = {};
  private noteEl: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'panel');
    this.root.id = 'right';
    const head = el('div', 'head');
    this.nameEl = el('div', 'name', 'No body selected');
    this.kindEl = el('div', 'kind', 'click a body to inspect it');
    head.appendChild(this.nameEl);
    head.appendChild(this.kindEl);
    this.root.appendChild(head);

    const body = el('div', 'body scroll');
    this.root.appendChild(body);

    this.noteEl = el('div', 'lesson');
    this.noteEl.style.display = 'none';

    const orbit = section(body, 'Orbital elements');
    for (const [key, label] of [
      ['a', 'semi-major axis a'],
      ['e', 'eccentricity e'],
      ['i', 'inclination i'],
      ['peri', 'periapsis'],
      ['apo', 'apoapsis'],
      ['period', 'period T'],
      ['speed', 'speed |v|'],
      ['escape', 'escape speed'],
      ['energy', 'specific energy'],
      ['bound', 'orbit'],
    ] as const) {
      this.orbitRows[key] = kvRow(orbit, label).value;
    }

    const phys = section(body, 'Body');
    for (const [key, label] of [
      ['mass', 'mass'],
      ['radius', 'radius'],
      ['density', 'mean density'],
      ['gravity', 'surface gravity'],
      ['force', 'net force'],
      ['accel', 'acceleration'],
      ['composition', 'composition'],
    ] as const) {
      this.physRows[key] = kvRow(phys, label).value;
    }

    const thermal = section(body, 'Thermal & habitability');
    for (const [key, label] of [
      ['temp', 'surface temperature'],
      ['teq', 'equilibrium temperature'],
      ['albedo', 'bond albedo'],
      ['greenhouse', 'greenhouse forcing'],
      ['tidal', 'tidal heating'],
      ['hz', 'habitable zone'],
      ['atmos', 'atmosphere'],
      ['ring', 'ring system'],
    ] as const) {
      this.thermalRows[key] = kvRow(thermal, label).value;
    }

    const system = section(body, 'System');
    for (const [key, label] of [
      ['primary', 'primary'],
      ['distance', 'distance to primary'],
      ['hill', 'Hill radius'],
      ['rocheF', 'Roche limit (fluid)'],
      ['rocheR', 'Roche limit (rigid)'],
      ['spin', 'rotation period'],
      ['tilt', 'axial tilt'],
    ] as const) {
      this.systemRows[key] = kvRow(system, label).value;
    }
    body.appendChild(this.noteEl);

    const graph = section(body, 'Energy conservation');
    this.energy = new EnergyGraph(graph);
    this.root.appendChild(body);
    parent.appendChild(this.root);
  }

  setEmpty(message: string): void {
    this.nameEl.textContent = 'No body selected';
    this.kindEl.textContent = message;
    for (const rows of [this.orbitRows, this.physRows, this.thermalRows, this.systemRows]) {
      for (const row of Object.values(rows)) row.textContent = '—';
    }
    this.noteEl.style.display = 'none';
  }

  update(t: BodyTelemetry | null, primaryName: string): void {
    if (!t) {
      this.setEmpty('click a body to inspect it');
      return;
    }
    this.nameEl.textContent = t.name;
    this.kindEl.textContent = `${t.kind} · id ${t.id}`;
    const set = (bank: Record<string, HTMLElement>, key: string, text: string, cls?: string) => {
      const node = bank[key];
      if (!node) return;
      node.textContent = text;
      node.className = cls ?? '';
    };

    const e = t.elements;
    if (e) {
      set(this.orbitRows, 'a', `${(e.a / AU).toPrecision(5)} AU`);
      set(this.orbitRows, 'e', e.e.toPrecision(4));
      set(this.orbitRows, 'i', fmt.angle(e.i));
      set(this.orbitRows, 'peri', fmt.metres(e.periapsis));
      set(this.orbitRows, 'apo', Number.isFinite(e.apoapsis) ? fmt.metres(e.apoapsis) : '∞ (hyperbolic)');
      set(this.orbitRows, 'period', Number.isFinite(e.period) ? fmt.time(e.period) : '—');
      set(this.orbitRows, 'speed', fmt.speed(e.speed), e.speed * 1.0 > e.escapeSpeed ? 'bad' : undefined);
      set(this.orbitRows, 'escape', fmt.speed(e.escapeSpeed));
      set(
        this.orbitRows,
        'energy',
        `${(e.specificEnergy / 1e6).toPrecision(4)} MJ/kg`,
        e.bound ? 'good' : 'bad',
      );
      set(this.orbitRows, 'bound', e.bound ? 'bound (closed)' : 'unbound (escaping)', e.bound ? 'good' : 'bad');
    } else {
      for (const row of Object.values(this.orbitRows)) row.textContent = '—';
    }

    const volume = (4 / 3) * Math.PI * t.radius ** 3;
    set(this.physRows, 'mass', fmt.mass(t.mass));
    set(this.physRows, 'radius', fmt.metres(t.radius));
    set(this.physRows, 'density', `${(t.mass / Math.max(volume, 1)).toPrecision(4)} kg/m³`);
    set(this.physRows, 'gravity', `${((6.6743e-11 * t.mass) / Math.max(t.radius * t.radius, 1)).toPrecision(3)} m/s²`);
    set(this.physRows, 'force', fmt.energy(Math.hypot(t.force[0], t.force[1], t.force[2])) + '');
    set(this.physRows, 'accel', `${Math.hypot(t.acc[0], t.acc[1], t.acc[2]).toExponential(3)} m/s²`);
    set(this.physRows, 'composition', t.composition);

    set(this.thermalRows, 'temp', fmt.temp(t.surfaceTemp));
    set(this.thermalRows, 'teq', fmt.temp(t.equilibriumTemp));
    set(this.thermalRows, 'albedo', t.albedo.toFixed(3));
    set(this.thermalRows, 'greenhouse', t.greenhouse > 0 ? `+${(t.greenhouse * 100).toFixed(1)} %` : 'none');
    set(this.thermalRows, 'tidal', t.tidalHeating > 0 ? `${t.tidalHeating.toExponential(2)} W` : '—');
    set(
      this.thermalRows,
      'hz',
      t.surfaceTemp > 273 && t.surfaceTemp < 373 ? 'liquid water possible' : t.surfaceTemp >= 373 ? 'too hot' : 'too cold',
      t.surfaceTemp > 273 && t.surfaceTemp < 373 ? 'good' : 'warn',
    );
    set(this.thermalRows, 'atmos', t.atmosphere ? `H = ${(t.atmosphere.scaleHeight / 1000).toFixed(1)} km, β_r = ${t.atmosphere.betaR.toExponential(1)}` : 'none');
    set(this.thermalRows, 'ring', t.ring ? `${fmt.metres(t.ring.innerRadius)} – ${fmt.metres(t.ring.outerRadius)}` : 'none');

    set(this.systemRows, 'primary', primaryName);
    set(this.systemRows, 'distance', fmt.metres(t.distanceToPrimary));
    set(this.systemRows, 'hill', e && e.hillRadius > 0 ? fmt.metres(e.hillRadius) : '—');
    set(this.systemRows, 'rocheF', e && e.rocheFluid > 0 ? fmt.metres(e.rocheFluid) : '—');
    set(this.systemRows, 'rocheR', e && e.rocheRigid > 0 ? fmt.metres(e.rocheRigid) : '—');
    set(this.systemRows, 'spin', t.spinPeriod > 0 ? fmt.time(t.spinPeriod) : '—');
    set(this.systemRows, 'tilt', `${t.axialTilt.toFixed(1)}°`);

    const note = massNote(t);
    if (note) {
      this.noteEl.style.display = 'block';
      this.noteEl.textContent = note;
    } else {
      this.noteEl.style.display = 'none';
    }
  }
}

/** A short teaching note derived from the body's own numbers. */
function massNote(t: BodyTelemetry): string | null {
  const suns = t.mass / SOLAR_MASS;
  if (t.kind === 'blackhole') {
    const rs = (2 * 6.6743e-11 * t.mass) / (2.99792458e8 ** 2);
    return `Event horizon radius r_s = 2GM/c² = ${fmt.metres(rs)}. The photon sphere sits at 1.5 r_s and the shadow we see is 2.6 r_s across.`;
  }
  if (t.kind === 'star') {
    return `Luminosity from the mass: L ≈ M^3.5 for a ${suns.toFixed(2)} M☉ star. Its habitable zone scales as √L.`;
  }
  if (t.tidalHeating > 1e13) {
    return `Tidal dissipation is ${t.tidalHeating.toExponential(2)} W — enough to keep a subsurface ocean liquid far from the Sun (this is what happens at Io and Europa).`;
  }
  return null;
}
