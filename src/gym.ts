// Headless driving gym (S5.2): reset() and step(action) on the shared fixed-step driving world, with no
// browser, DOM or renderer. One environment per process: the circuit and driving mode come from
// SETTINGS (set globalThis.F1_SETTINGS before importing this module; see scripts/gym-lap.ts).
//
// step(action) advances exactly one 1/120 s physics step through the same DrivingWorld.advance() the
// browser uses. Action: steer -1 (full right) .. +1 (full left), as a share of the speed's steering
// lock, reaching the wheels through the car's own steering rate; throttle and brake 0..1, applied
// together if both are given (as the car's pedal code does); a gym brake never selects reverse.
// Observations are privileged simulator state (pose, velocities, wheels, place on the lap), not pixels.
//
// Reward: signed metres of progress along the lap's centreline station this step (negative when going
// backward; unwrapped across the start/finish seam). No lap-time bonus or safety shaping.
// An episode terminates when a timed lap is completed, the lap is invalidated by track limits, or the
// car falls out of the world; it is truncated when the tick horizon runs out. Nothing re-places the car
// during an episode. reset() builds a fresh physical world from the loaded assets: t = 0 with the car
// at rest 1 m above the pole slot; its first 6 steps hold it still while it settles (Car.placeAt).
// Lap 1 is a standing start, timed from the car's first forward movement (the browser's grid rule);
// 'lap_complete' is the end of lap 1.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadTrack, type Track } from './surface';
import { asset, loadCircuit, CIRCUIT_ID } from './circuit';
import { CAR } from './carconfig';
import { DrivingWorld, PHYSICS_DT } from './world';

export interface Action {
  steer: number;
  throttle: number;
  brake: number;
}

export interface GymState {
  tick: number;
  time: number; // s since reset
  position: { x: number; y: number; z: number }; // m, local X east, Y up, Z south
  rotation: { x: number; y: number; z: number; w: number };
  linvel: { x: number; y: number; z: number }; // m/s
  angvel: { x: number; y: number; z: number }; // rad/s
  forwardSpeed: number; // m/s along the chassis, + forward
  steerAngle: number; // front-wheel angle actually applied, rad, + left
  applied: { throttle: number; brake: number }; // pedals the car applied this step
  wheels: { omega: number; slip: number; load: number }[]; // FL, FR, RL, RR: rad/s, slip ratio, N
  station: number; // m along the lap centreline
  offCentre: number; // m from the centreline (car centre)
  lap: number; // 0 before the first control-line crossing
}

export type EndReason = 'lap_complete' | 'track_limit' | 'fall' | 'time_limit';

export interface StepResult {
  state: GymState;
  reward: number;
  terminated: boolean;
  truncated: boolean;
  info: { reason: EndReason | null; lapTime: number | null; lapValid: boolean | null };
}

export class Gym {
  readonly circuit = CIRCUIT_ID;
  readonly mode = CAR.id;
  dw!: DrivingWorld;
  // The gym's action as the car's controls (never reverse, never brake-only, never reset).
  private controls = { throttle: 0, brake: 0, steer: 0, reverseKey: false, brakeOnly: false, reset: false };
  private lowestY: number;
  private nx: Float32Array; // centreline vertex normals (plan view), for a continuous station
  private nz: Float32Array;
  private prevStation = 0;
  private startLap = 0;

  private constructor(readonly track: Track, readonly terrain: Track | null, readonly horizon: number) {
    this.lowestY = Math.min(...track.centerline.points.filter((_, i) => i % 3 === 1));
    const c = track.centerline.points, N = track.centerline.distance.length;
    this.nx = new Float32Array(N);
    this.nz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i + N - 1) % N, b = (i + 1) % N, dx = c[b * 3] - c[a * 3], dz = c[b * 3 + 2] - c[a * 3 + 2], l = Math.hypot(dx, dz) || 1;
      this.nx[i] = dz / l;
      this.nz[i] = -dx / l;
    }
  }

  // Station of the car's centre (m along the lap), continuous: the car lies on the line swept by the
  // centreline's vertex normals, interpolated along the segment either side of the nearest 2 m sample
  // (P - A - u E = t (Na + u (Nb - Na)), solved for u). A perpendicular foot would jump between
  // segments on the inside of a tight curve (La Source: car ~7 m inside an ~11 m centreline radius).
  private station() {
    const lap = this.dw.lap, D = this.track.centerline.distance, N = D.length, c = this.track.centerline.points;
    const L = this.track.centerline.length ?? lap.length, p = this.dw.car.body.translation(), i = lap.index;
    const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
    for (const a of [i, (i + N - 1) % N]) {
      const b = (a + 1) % N, ex = c[b * 3] - c[a * 3], ez = c[b * 3 + 2] - c[a * 3 + 2];
      const qx = p.x - c[a * 3], qz = p.z - c[a * 3 + 2];
      const nax = this.nx[a], naz = this.nz[a], dnx = this.nx[b] - nax, dnz = this.nz[b] - naz;
      // cross(Q - uE, Na + u dN) = 0  ->  k2 u^2 + k1 u + k0 = 0
      const k0 = cross(qx, qz, nax, naz), k1 = cross(qx, qz, dnx, dnz) - cross(ex, ez, nax, naz), k2 = -cross(ex, ez, dnx, dnz);
      let u: number;
      if (Math.abs(k2) < 1e-12) u = -k0 / k1;
      else {
        const disc = k1 * k1 - 4 * k2 * k0;
        if (disc < 0) continue;
        const r1 = (-k1 + Math.sqrt(disc)) / (2 * k2), r2 = (-k1 - Math.sqrt(disc)) / (2 * k2);
        u = Math.abs(r1 - 0.5) < Math.abs(r2 - 0.5) ? r1 : r2;
      }
      if (u >= -1e-9 && u <= 1 + 1e-9) {
        const s = D[a] + Math.max(0, Math.min(1, u)) * (b > a ? D[b] - D[a] : L - D[a]);
        return ((s % L) + L) % L;
      }
    }
    return D[i];
  }

  // horizon: ticks before an episode is truncated (default 10 minutes of simulation).
  static async create(opts: { horizon?: number } = {}) {
    const [track, terrain] = await Promise.all([loadTrack(asset('lap.json')), loadTrack(asset('terrain.json')).catch(() => null), RAPIER.init(), loadCircuit()]);
    return new Gym(track, terrain, opts.horizon ?? 600 / PHYSICS_DT);
  }

  reset(): GymState {
    this.dw?.free();
    Object.assign(this.controls, { throttle: 0, brake: 0, steer: 0 });
    this.dw = new DrivingWorld(new THREE.Group(), this.track, this.terrain, this.controls);
    this.dw.lap.armStandingStart(); // as the browser does on the grid: lap 1 is timed from the first move
    this.prevStation = this.station();
    this.startLap = this.dw.lap.lap;
    return this.state();
  }

  step(a: Action): StepResult {
    const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
    this.controls.steer = clamp(a.steer, -1, 1);
    this.controls.throttle = clamp(a.throttle, 0, 1);
    this.controls.brake = clamp(a.brake, 0, 1);
    const lap = this.dw.lap, before = lap.lap;
    this.dw.advance();
    const L = this.track.centerline.length ?? lap.length;
    const station = this.station();
    let reward = station - this.prevStation;
    if (reward > L / 2) reward -= L;
    else if (reward < -L / 2) reward += L;
    this.prevStation = station;
    const state = this.state();
    // Falling out of the world: the browser's recovery rule, here ending the episode instead.
    const c = this.track.centerline.points, i = lap.index;
    const gone = this.terrain ? state.offCentre > 280 : state.offCentre > 15 && state.position.y < c[i * 3 + 1] - 3;
    let reason: EndReason | null = null;
    if (gone || state.position.y < this.lowestY - 30) reason = 'fall';
    else if (lap.lap > before && before > this.startLap) reason = 'lap_complete'; // a timed lap finished
    else if (lap.invalid) reason = 'track_limit';
    else if (this.dw.tick >= this.horizon) reason = 'time_limit';
    return {
      state,
      reward,
      terminated: reason !== null && reason !== 'time_limit',
      truncated: reason === 'time_limit',
      info: { reason, lapTime: reason === 'lap_complete' ? lap.lastLap : null, lapValid: reason === 'lap_complete' ? !lap.lastInvalid : null },
    };
  }

  state(): GymState {
    const car = this.dw.car, b = car.body, lap = this.dw.lap;
    const t = b.translation(), r = b.rotation(), v = b.linvel(), w = b.angvel();
    const c = this.track.centerline.points, i = lap.index;
    return {
      tick: this.dw.tick,
      time: this.dw.time,
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      linvel: { x: v.x, y: v.y, z: v.z },
      angvel: { x: w.x, y: w.y, z: w.z },
      forwardSpeed: car.speed,
      steerAngle: car.steer,
      applied: { throttle: car.applied.throttle, brake: car.applied.brake },
      wheels: car.tyre.map((wh) => ({ omega: wh.omega, slip: wh.slip, load: wh.fz })),
      station: this.station(),
      offCentre: Math.hypot(t.x - c[i * 3], t.z - c[i * 3 + 2]),
      lap: lap.lap,
    };
  }
}
