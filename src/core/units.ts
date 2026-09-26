/**
 * Cosmoscope — fundamental constants and unit helpers.
 *
 * The simulation runs entirely in SI units (metres, kilograms, seconds).
 * Float64 gives ~16 significant digits of relative precision, which is ample
 * for every preset in the library (planetary 1e11 m / 1e24 kg up to galactic
 * 1e21 m / 1e42 kg), while keeping the physics quotable against any textbook.
 */

// ── Physical constants ────────────────────────────────────────────────────────
export const G = 6.67430e-11; // m^3 kg^-1 s^-2  (CODATA 2018)
export const C = 2.99792458e8; // m s^-1
export const C2 = C * C;
export const SIGMA_SB = 5.670374419e-8; // Stefan-Boltzmann, W m^-2 K^-4
export const AU = 1.495978707e11; // m
export const PARSEC = 3.0856775814913673e16; // m
export const LIGHT_YEAR = 9.4607304725808e15; // m
export const YEAR = 3.15576e7; // Julian year, s
export const DAY = 86400;
export const HOUR = 3600;
export const SOLAR_MASS = 1.98847e30; // kg
export const SOLAR_RADIUS = 6.957e8; // m
export const SOLAR_LUMINOSITY = 3.828e26; // W
export const EARTH_MASS = 5.97217e24;
export const EARTH_RADIUS = 6.371e6;
export const EARTH_LUMINOSITY = 1.7404e17; // W (internal heat flux × area, ~47 TW)
export const JUPITER_MASS = 1.89813e27;
export const JUPITER_RADIUS = 6.9911e7;
export const MOON_MASS = 7.342e22;
export const MOON_RADIUS = 1.7374e6;
export const KM = 1e3;

// Derived astrophysical thresholds
export const CHANDRASEKHAR_LIMIT = 1.44 * SOLAR_MASS;
export const TOV_LIMIT = 2.17 * SOLAR_MASS; // Tolman-Oppenheimer-Volkoff
export const SCHWARZSCHILD_RADIUS_PER_KG = (2 * G) / C2; // R_s = 2GM/c^2

/** Schwarzschild radius of a mass (m). */
export const schwarzschildRadius = (m: number) => (SCHWARZSCHILD_RADIUS_PER_KG * m);

/** Photon sphere radius: r = 1.5 R_s. */
export const photonSphere = (m: number) => 1.5 * schwarzschildRadius(m);

/** Critical impact parameter for photon capture: b_crit = (3√3/2) R_s ≈ 2.598 R_s. */
export const criticalImpactParameter = (m: number) => (3 * Math.sqrt(3) / 2) * schwarzschildRadius(m);

// ── Temperature / colour ──────────────────────────────────────────────────────

/**
 * Planck-locus approximation (Helland fit) mapping a blackbody temperature to
 * linear sRGB. Used for star colours, lava glow and hot impact ejecta.
 */
export function blackbodyColor(kelvin: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const t = Math.min(Math.max(kelvin, 500) / 100, 400); // 500K .. 40000K
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  out[0] = Math.min(1, Math.max(0, r / 255));
  out[1] = Math.min(1, Math.max(0, g / 255));
  out[2] = Math.min(1, Math.max(0, b / 255));
  return out;
}

// ── Unit conversion (display layer) ───────────────────────────────────────────
export const Unit = {
  /** Metres → human string with astronomy-aware scaling. */
  length(m: number): string {
    const a = Math.abs(m);
    if (a < 1e-3) return `${(m * 1e6).toFixed(2)} µm`;
    if (a < 1) return `${(m * 1e3).toFixed(2)} mm`;
    if (a < 1e3) return `${m.toFixed(2)} m`;
    if (a < 1e7) return `${(m / 1e3).toFixed(1)} km`;
    if (a < 0.02 * AU) return `${(m / 1e6).toFixed(1)} 1000 km`;
    if (a < 0.5 * LIGHT_YEAR) return `${(m / AU).toFixed(a < 10 * AU ? 3 : 1)} AU`;
    if (a < 0.5 * PARSEC) return `${(m / LIGHT_YEAR).toFixed(2)} ly`;
    if (a < 1e3 * PARSEC) return `${(m / PARSEC).toFixed(2)} pc`;
    return `${(m / (1e3 * PARSEC)).toFixed(2)} kpc`;
  },
  velocity(v: number): string {
    const a = Math.abs(v);
    if (a < 1e3) return `${v.toFixed(1)} m/s`;
    if (a < 0.05 * C) return `${(v / 1e3).toFixed(2)} km/s`;
    return `${(v / C).toFixed(4)} c`;
  },
  mass(kg: number): string {
    const a = Math.abs(kg);
    if (a < 1e3) return `${kg.toFixed(2)} kg`;
    if (a < 1e12) return `${(kg / 1e9).toFixed(2)} Mt`;
    if (a < 0.1 * EARTH_MASS) return `${(kg / 1e12).toFixed(2)} 10^12 kg`;
    if (a < 0.1 * JUPITER_MASS) return `${(kg / EARTH_MASS).toFixed(3)} M⊕`;
    if (a < 30 * JUPITER_MASS) return `${(kg / JUPITER_MASS).toFixed(3)} M♃`;
    if (a < 1e5 * SOLAR_MASS) return `${(kg / SOLAR_MASS).toFixed(3)} M☉`;
    return `${(kg / 1e12 * 0 + kg / 1e42).toFixed(3)} 10^42 kg`;
  },
  time(s: number): string {
    const a = Math.abs(s);
    if (a < 1) return `${(s * 1e3).toFixed(1)} ms`;
    if (a < 120) return `${s.toFixed(2)} s`;
    if (a < 3 * HOUR) return `${(s / 60).toFixed(1)} min`;
    if (a < 3 * DAY) return `${(s / HOUR).toFixed(1)} h`;
    if (a < 2 * YEAR) return `${(s / DAY).toFixed(2)} d`;
    if (a < 1e3 * YEAR) return `${(s / YEAR).toFixed(2)} yr`;
    if (a < 1e6 * YEAR) return `${(s / YEAR / 1e3).toFixed(2)} kyr`;
    if (a < 1e9 * YEAR) return `${(s / YEAR / 1e6).toFixed(2)} Myr`;
    return `${(s / YEAR / 1e9).toFixed(3)} Gyr`;
  },
  power(w: number): string {
    const a = Math.abs(w);
    if (a < 1e3) return `${w.toFixed(1)} W`;
    if (a < 1e6) return `${(w / 1e3).toFixed(2)} kW`;
    if (a < 1e9) return `${(w / 1e6).toFixed(2)} MW`;
    if (a < 1e12) return `${(w / 1e9).toFixed(2)} GW`;
    if (a < SOLAR_LUMINOSITY * 0.1) return `${(w / 1e15).toFixed(2)} PW`;
    return `${(w / SOLAR_LUMINOSITY).toFixed(4)} L☉`;
  },
  energy(j: number): string {
    const a = Math.abs(j);
    if (a < 1e3) return `${j.toFixed(1)} J`;
    if (a < 1e9) return `${(j / 1e6).toFixed(2)} MJ`;
    if (a < 1e15) return `${(j / 1e12).toFixed(2)} TJ`;
    if (a < 1e21) return `${(j / 1e18).toFixed(2)} EJ`;
    if (a < 1e27) return `${(j / 1e24).toFixed(2)} YJ`;
    return `${j.toExponential(3)} J`;
  },
  density(kgm3: number): string {
    if (kgm3 < 1e-3) return `${kgm3.toExponential(2)} kg/m³`;
    return `${kgm3.toFixed(kgm3 < 10 ? 3 : 1)} kg/m³`;
  },
  angle(rad: number): string {
    const deg = (rad * 180) / Math.PI;
    return `${deg.toFixed(2)}°`;
  },
  /** Compact exponent formatting for readouts. */
  sci(v: number, digits = 3): string {
    if (v === 0) return '0';
    const e = Math.floor(Math.log10(Math.abs(v)));
    if (e >= -3 && e <= 5) return v.toFixed(digits > 3 ? 3 : digits);
    return `${(v / Math.pow(10, e)).toFixed(2)}e${e}`;
  },
};
