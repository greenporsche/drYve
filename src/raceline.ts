import type { Track } from './surface';

// Racing line and speed profile, shared by the painted guide and the autopilot.
//
// Line: a minimum-curvature path across the road. Each centerline sample gets a lateral offset n
// (metres, + = left of travel) within the usable width; offsets are relaxed so every point moves
// toward the midpoint of its neighbours (an "elastic band"), which straightens the path and uses
// the full width through corners (wide entry, apex, wide exit).
// Speed: corner limit from the line's curvature and the available grip (with downforce), then a
// forward pass limited by acceleration and a backward pass limited by braking.
const HALF_ROAD = 6; // m
// Reference line's distance from the road edge, where the kerbs begin (EM #20901), shared by every
// level and both modes (PO #21026): half-track 0.95 m + half a tyre 0.2 m + a 1.2 m tracking reserve
// (the driver's measured off-line error: 0.8 m at Les Combes' apex, ~1.1 m at Pouhon's exit at
// 316 km/h, where 1 m wide put the outside wheels on the kerb).
export const REFERENCE_MARGIN = 0.95 + 0.2 + 1.2;
const ITERATIONS = 400; // per scale
const SCALES = [24, 12, 6, 3, 1]; // sample spacings for the curvature terms, coarse to fine
const STEP = 0.04; // gradient step (stable below 1/16 for this fourth-order smoothing)
const CURV_SPAN = 6; // samples each side (~12 m) for the heading change
const CURV_SMOOTH = 4; // samples each side for averaging curvature

export interface CarLimits {
  grip: number; // g of cornering at low speed (mechanical grip)
  aeroGrip: number; // extra g per (100 km/h)^2 from downforce
  brake: number; // g of braking at low speed
  aeroBrake: number; // extra braking g per (100 km/h)^2
  power: number; // W of drive power at the wheels
  mass: number; // kg
  topSpeed: number; // m/s
  drag?: number; // N per (m/s)^2 of aerodynamic drag
  brakeMax?: number; // g the brakes themselves can give (above this speed-dependent tyre limit, brakes cap)
  traction?: number; // g of drive the rear tyres hold at low speed
  aeroTraction?: number; // extra drive g per (100 km/h)^2 from downforce on the rears
  // Vertical load (Simulation, EM #20881): the tyre-limited terms use the road-normal load
  // N/m = g cos(grade) + v^2 kn + downforce/m, combined before clamping at zero (kn = signed
  // road-normal curvature of the line, + in a dip); gravity along the slope (-g sin(grade)) enters the
  // acceleration and braking passes once; brakeMax is then the brake hardware alone and drag is added
  // to braking separately. Without the flag (Accessible) the planner is the flat-road one, unchanged.
  verticalLoad?: boolean;
  driveForce?: number; // N, the drivetrain's force cap at the wheels below the power limit (Simulation planner)
  // The driver works to these limits (Simulation, where the car has no steering cap): brakes ahead of
  // the plan's deceleration (pedal from what the plan asks over the next 0.5 s against these limits)
  // rather than only on the speed error, and keeps the steering angle within what these limits say the
  // tyres can turn at this speed. Driver behaviour on the shared car state, not a car assist.
  limitAware?: boolean;
  // Tracking/model margin (EM #20889: named and reported separately from the measured envelope): the
  // planner uses this share of the lateral capacity, for the driver's path-tracking error. 1 = none.
  trackingMargin?: number;
}

export interface RaceLine {
  n: Float32Array; // lateral offset per sample
  x: Float32Array; y: Float32Array; z: Float32Array; // line positions
  s: Float32Array; // cumulative distance along the line
  curvature: Float32Array; // 1/m (Accessible planner)
  // Signed curvature (+ = heading increasing, atan2(x, z) frame) from the heading change over +-4
  // samples divided by the line's own arc length over that span: the Simulation driver steers on it
  // and the Simulation planner uses its magnitude (EM #20889/#20911).
  kappaArc: Float32Array;
  speed: Float32Array; // target speed per sample, m/s
  length: number;
}

export function computeLine(track: Track, blend = 1, margin = REFERENCE_MARGIN): Omit<RaceLine, 'speed'> {
  const c = track.centerline.points, N = track.centerline.distance.length;
  const wrap = (i: number) => ((i % N) + N) % N;
  const { nx, nz } = normals(track);
  // Bounds per sample: the road's half-widths (local corrections where baked) minus the margin.
  const hw = track.centerline.halfWidth;
  const limL = (i: number) => (hw ? hw[i * 2] : HALF_ROAD) - margin, limR = (i: number) => (hw ? hw[i * 2 + 1] : HALF_ROAD) - margin;
  const n = new Float32Array(N);
  // Minimum curvature: minimise the sum of squared second differences of the line points (its
  // bending), by gradient steps on the lateral offsets, clamped to the road. Coarse spacings first so
  // the whole corner settles (wide entry, apex, wide exit), then finer ones. (Pulling each point to
  // its neighbours' midpoint instead shrinks a hairpin onto its inside edge.)
  const px = new Float32Array(N), pz = new Float32Array(N), dx = new Float32Array(N), dz = new Float32Array(N);
  for (const h of SCALES) {
    for (let it = 0; it < ITERATIONS; it++) {
      for (let i = 0; i < N; i++) (px[i] = c[i * 3] + nx[i] * n[i]), (pz[i] = c[i * 3 + 2] + nz[i] * n[i]);
      for (let i = 0; i < N; i++) {
        const a = wrap(i - h), b = wrap(i + h);
        dx[i] = px[a] - 2 * px[i] + px[b];
        dz[i] = pz[a] - 2 * pz[i] + pz[b];
      }
      for (let i = 0; i < N; i++) {
        const a = wrap(i - h), b = wrap(i + h);
        const gx = dx[a] - 2 * dx[i] + dx[b], gz = dz[a] - 2 * dz[i] + dz[b];
        n[i] = Math.max(-limR(i), Math.min(limL(i), n[i] - STEP * (gx * nx[i] + gz * nz[i]))); // n + = left
      }
    }
  }
  for (let i = 0; i < N; i++) n[i] *= blend;
  return lineFromOffsets(track, n);
}

// Plan-view left normals of the centreline (+n = left of travel).
function normals(track: Track) {
  const c = track.centerline.points, N = track.centerline.distance.length;
  const wrap = (i: number) => ((i % N) + N) % N;
  const nx = new Float32Array(N), nz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = wrap(i - 1), b = wrap(i + 1);
    const tx = c[b * 3] - c[a * 3], tz = c[b * 3 + 2] - c[a * 3 + 2], l = Math.hypot(tx, tz) || 1;
    nx[i] = tz / l; nz[i] = -tx / l;
  }
  return { nx, nz };
}

// A line from lateral offsets n (m, + = left) at each centreline sample: positions, arc length,
// curvature and arc-length curvature. Used for the computed line, a baked reference line, and a
// driver's own path (a fraction of the reference offsets).
export function lineFromOffsets(track: Track, offsets: ArrayLike<number>): Omit<RaceLine, 'speed'> {
  const c = track.centerline.points, N = track.centerline.distance.length;
  const wrap = (i: number) => ((i % N) + N) % N;
  const { nx, nz } = normals(track);
  const n = Float32Array.from(offsets);
  const x = new Float32Array(N), y = new Float32Array(N), z = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = c[i * 3] + nx[i] * n[i];
    y[i] = c[i * 3 + 1];
    z[i] = c[i * 3 + 2] + nz[i] * n[i];
  }
  const s = new Float32Array(N);
  for (let i = 1; i < N; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  const length = s[N - 1] + Math.hypot(x[0] - x[N - 1], z[0] - z[N - 1]);
  // Curvature: heading change over +-CURV_SPAN samples divided by the arc length, then averaged over
  // +-CURV_SMOOTH samples. Short spans read sample noise as tight corners.
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = wrap(i - CURV_SPAN), b = wrap(i + CURV_SPAN), a1 = wrap(i - CURV_SPAN + 1), b1 = wrap(i + CURV_SPAN - 1);
    const h0 = Math.atan2(x[a1] - x[a], z[a1] - z[a]), h1 = Math.atan2(x[b] - x[b1], z[b] - z[b1]);
    const turn = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
    let arc = 0;
    for (let k = -CURV_SPAN; k < CURV_SPAN; k++) arc += Math.hypot(x[wrap(i + k + 1)] - x[wrap(i + k)], z[wrap(i + k + 1)] - z[wrap(i + k)]);
    raw[i] = Math.abs(turn) / Math.max(1, arc);
  }
  const curvature = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let k = -CURV_SMOOTH; k <= CURV_SMOOTH; k++) sum += raw[wrap(i + k)];
    curvature[i] = sum / (2 * CURV_SMOOTH + 1);
  }
  const heading = new Float32Array(N), kappaArc = new Float32Array(N);
  for (let i = 0; i < N; i++) heading[i] = Math.atan2(x[wrap(i + 1)] - x[wrap(i - 1)], z[wrap(i + 1)] - z[wrap(i - 1)]);
  const arcOf = (a: number, b: number) => (b >= a ? s[b] - s[a] : length - s[a] + s[b]);
  for (let i = 0; i < N; i++) {
    const a = heading[wrap(i - 4)], b = heading[wrap(i + 4)];
    kappaArc[i] = Math.atan2(Math.sin(b - a), Math.cos(b - a)) / Math.max(0.5, arcOf(wrap(i - 4), wrap(i + 4)));
  }
  return { n, x, y, z, s, curvature, kappaArc, length };
}

// Target speed along the line for the given car limits (scaled by `aggression` 0..1 of the limit).
export function speedProfile(line: Omit<RaceLine, 'speed'>, car: CarLimits, aggression: number): Float32Array {
  const N = line.x.length, g = 9.81;
  if (car.verticalLoad) return speedProfileVertical(line, car, aggression);
  const lat = (v: number) => (car.grip + car.aeroGrip * (v / 27.78) ** 2) * g * aggression;
  const dec = (v: number) => Math.min(car.brakeMax ?? Infinity, car.brake + car.aeroBrake * (v / 27.78) ** 2) * g * aggression;
  const grip = (v: number) => (car.traction === undefined ? 1.4 : car.traction + (car.aeroTraction ?? 0) * (v / 27.78) ** 2) * g;
  const acc = (v: number) => Math.max(0.05, Math.min(grip(v), car.power / (car.mass * Math.max(v, 5))) - ((car.drag ?? 0) * v * v) / car.mass);
  // Corner limit: v^2 * k <= lat(v); solve by fixed-point iteration (lat grows with v).
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // The smoothed curvature, or the arc-length curvature where it is tighter: the +-12 m smoothing
    // reads a short tight arc (the Bus Stop's second part) about 20% wider than the car must drive it.
    const k = Math.max(line.curvature[i], Math.abs(line.kappaArc[i]), 1e-5);
    let s = 30;
    for (let it = 0; it < 30; it++) s = Math.min(car.topSpeed, Math.sqrt(lat(s) / k));
    v[i] = s;
  }
  const step = (i: number) => {
    const j = (i + 1) % N;
    return Math.hypot(line.x[j] - line.x[i], line.z[j] - line.z[i]);
  };
  // Two laps of forward (acceleration) and backward (braking) passes so the seam settles.
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N, d = step(i);
      v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * acc(v[i]) * d));
    }
    for (let i = N - 1; i >= 0; i--) {
      const j = (i + 1) % N, d = step(i);
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * dec(v[j]) * d));
    }
  }
  return v;
}

// Grade and road-normal curvature of the line's height profile (true metres, unexaggerated): slope
// h' and its change h'' against horizontal distance over +-10 samples (~20 m, so survey noise
// doesn't read as bumps); kn = h'' / (1 + h'^2)^(3/2), + in a dip / compression, - over a crest.
export function verticalProfile(line: Omit<RaceLine, 'speed'>) {
  const N = line.y.length, H = 10, kn = new Float32Array(N), cos = new Float32Array(N), sin = new Float32Array(N);
  const wrap = (i: number) => ((i % N) + N) % N;
  const dist = (a: number, b: number) => { let d = 0; for (let k = a; k < b; k++) d += Math.hypot(line.x[wrap(k + 1)] - line.x[wrap(k)], line.z[wrap(k + 1)] - line.z[wrap(k)]); return Math.max(d, 1e-3); };
  for (let i = 0; i < N; i++) {
    const a = wrap(i - H), b = wrap(i + H), d1 = dist(i - H, i), d2 = dist(i, i + H);
    const g1 = (line.y[i] - line.y[a]) / d1, g2 = (line.y[b] - line.y[i]) / d2;
    const h1 = (line.y[b] - line.y[a]) / (d1 + d2), h2 = (g2 - g1) / ((d1 + d2) / 2);
    const q = Math.sqrt(1 + h1 * h1);
    kn[i] = h2 / q ** 3;
    cos[i] = 1 / q;
    sin[i] = h1 / q; // + uphill in the direction of travel
  }
  return { kn, cos, sin };
}

// The Simulation planner (verticalLoad): limits from the road-normal load, gravity along the slope,
// drag and the hardware limits each counted once. Corner speeds by bisection on the inequality
// v^2 k <= lateral capacity(v) (the capacity can fall with speed over a crest, where a fixed-point
// iteration can misbehave), then checked.
function speedProfileVertical(line: Omit<RaceLine, 'speed'>, car: CarLimits, aggression: number): Float32Array {
  const N = line.x.length, g = 9.81, { kn, cos, sin } = verticalProfile(line);
  const q = (v: number) => (v / 27.78) ** 2;
  const normal = (v: number, i: number) => cos[i] + (v * v * kn[i]) / g; // mechanical load factor (signed)
  const lat = (v: number, i: number) => Math.max(0, car.grip * normal(v, i) + car.aeroGrip * q(v)) * g * aggression * (car.trackingMargin ?? 1);
  const k = (i: number) => Math.abs(line.kappaArc[i]); // the same curvature the driver steers on
  const drag = (v: number) => ((car.drag ?? 0) * v * v) / car.mass;
  // One shared tyre budget: grip used turning is not available for braking or driving (friction
  // ellipse on the lateral demand v^2 k against the lateral capacity at that speed and load).
  const left = (v: number, i: number) => {
    const cap = lat(v, i), need = v * v * k(i);
    return cap > 0 ? Math.sqrt(Math.max(0, 1 - (need / cap) ** 2)) : 0;
  };
  const dec = (v: number, i: number) => {
    const tyre = Math.max(0, car.brake * normal(v, i) + car.aeroBrake * q(v)) * left(v, i);
    return Math.min(car.brakeMax ?? Infinity, tyre) * g * aggression + drag(v) + g * sin[i]; // uphill helps
  };
  const acc = (v: number, i: number) => {
    const tyre = Math.max(0, (car.traction ?? 1.4) * normal(v, i) + (car.aeroTraction ?? 0) * q(v)) * g * left(v, i);
    const engine = Math.min(car.driveForce ?? Infinity, car.power / Math.max(v, 5)) / car.mass;
    return Math.max(0.05, Math.min(tyre, engine) - drag(v) - g * sin[i]); // uphill costs
  };
  const v = new Float32Array(N);
  const ok = (s: number, i: number, k: number) => s * s * k <= lat(s, i) + 1e-6;
  for (let i = 0; i < N; i++) {
    const ki = Math.max(k(i), 1e-5);
    if (ok(car.topSpeed, i, ki)) { v[i] = car.topSpeed; continue; }
    let lo = 0, hi = car.topSpeed;
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if (ok(m, i, ki)) lo = m; else hi = m; }
    v[i] = lo;
  }
  const step = (i: number) => { const j = (i + 1) % N; return Math.hypot(line.x[j] - line.x[i], line.z[j] - line.z[i]); };
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      v[j] = Math.min(v[j], Math.sqrt(Math.max(0, v[i] * v[i] + 2 * acc(v[i], i) * step(i))));
    }
    for (let i = N - 1; i >= 0; i--) {
      const j = (i + 1) % N;
      v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[j] * v[j] + 2 * Math.max(0.05, dec(v[j], j)) * step(i))));
    }
  }
  // Check: every planned speed satisfies its corner/load inequality.
  let worst = 0;
  for (let i = 0; i < N; i++) worst = Math.max(worst, v[i] * v[i] * k(i) - lat(v[i], i));
  if (worst > 0.01) console.warn(`speed plan exceeds lateral capacity by ${worst.toFixed(3)} m/s^2`);
  return v;
}

// Predicted lap time for a speed profile (for comparing levels and against real pole times).
export function lapTime(line: Omit<RaceLine, 'speed'>, v: Float32Array) {
  let t = 0;
  const N = v.length;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    t += Math.hypot(line.x[j] - line.x[i], line.z[j] - line.z[i]) / ((v[i] + v[j]) / 2);
  }
  return t;
}
