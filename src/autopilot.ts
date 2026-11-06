import type { Track } from './surface';
import { auto } from './controls';
import type { Car } from './car';
import type { LapTracker } from './lap';
import { computeLine, lineFromOffsets, speedProfile, lapTime, type CarLimits } from './raceline';
import { steerLock } from './car';

const WHEELBASE = 3.3;
const STEER_LAG = 0.28; // s, 1/STEER_IN in car.ts
const CROSS_GAIN = 1.6; // how hard it steers back toward the line per metre of offset (Stanley gain)
const YAW_GAIN = 0.06; // s: extra wheel angle (rad) per rad/s of yaw-rate shortfall (Simulation driver)

// Autopilot: follows the racing line at the planned speed for its level, through the same
// fractional throttle/brake/steer inputs a driver uses; the car physics is unchanged.
//
// One reference racing line per circuit (PO #21026, EM #21029): the same geometry at every level and
// in both modes, baked (spa-line.json) or computed once. A level's driver may hedge toward the middle
// of the road (blend < 1: its own path, the reference offsets scaled toward the centreline, with its
// own speed plan from that path); that is the driver's path, not a different optimal line. Each level
// drives at a fraction of the car's limit. Level 5 is the precise driver: the full line at the planner's limit, working the
// tyres at their peak, with no deliberate mistakes (PO #20818). Secret level 6 (key 6, not listed in
// the help) is the over-exuberant hammer: past the limit, late on the brakes, stabbing the pedals and
// letting the tyres spin and lock, and often over-cooking a braking zone; it pays for it.
// Each level is a driver (PO #20764, EM #20765): the car is the same at every level.
//   aggression: how close to the car's limits the planned speeds are; blend: how much of the racing
//   line is used. skill: pedal modulation on the tyres' slip feedback: slip = the slip the driver
//   lets the tyres reach before backing off (the tyre peak is ~0.12; above it they spin or lock),
//   react = how fast they correct (per second), stab = how hard the pedal is first applied.
const LEVELS = [
  { aggression: 0.62, blend: 0.4, slip: 0.35, react: 2, stab: 1.0 }, // amateur: stabs pedals, spins and locks
  { aggression: 0.72, blend: 0.6, slip: 0.25, react: 4, stab: 0.9 },
  { aggression: 0.82, blend: 0.8, slip: 0.18, react: 6, stab: 0.8 },
  { aggression: 0.87, blend: 1, slip: 0.14, react: 10, stab: 0.7 },
  { aggression: 1.0, blend: 1, slip: 0.12, react: 16, stab: 0.6 }, // pro: brakes and drives at the peak, no mistakes
  { aggression: 1.08, blend: 1, slip: 0.45, react: 3, stab: 1.0 }, // secret 6: the hammer
];
const MISTAKE_LEVEL = 6; // only the hammer over-cooks braking zones
const MISTAKE_CHANCE = 0.3; // chance that a braking zone is entered too fast
const MISTAKE_OVERSPEED = 1.1; // and by how much

export class Autopilot {
  readonly plans: { x: Float32Array; y: Float32Array; z: Float32Array; s: Float32Array; length: number; speed: Float32Array; predicted: number; heading: Float32Array; kappa: Float32Array; kappaArc: Float32Array }[];
  // The shared reference line (geometry fixed for the session) and its planned speeds at each level's
  // pace, for the guide.
  readonly reference: ReturnType<typeof computeLine>;
  readonly referenceSpeeds: Float32Array[];
  // Last step's steering trace (Simulation driver), for test harnesses: signed curvature used, target
  // and measured yaw rate (rad/s, + = yaw/heading increasing, same frame as atan2(x, z)), lateral
  // offset, requested and sent wheel angles (rad).
  debug = { kappa: 0, yawRateTarget: 0, yawRate: 0, side: 0, angleRequested: 0, angleSent: 0 };
  private lastYaw: number | null = null;
  private n: number;
  private mistake = 1; // current overspeed factor (level 6 mistakes)
  mistakesEnabled = true; // test hook: lets a harness measure a clean level-5 lap
  private lastBraking = false;
  private thrCap = 1; // pedal ceilings the driver has learned from the tyres this braking/drive phase
  private brkCap = 1;

  private limits: CarLimits;
  // reference: baked lateral offsets of the reference line (m, + = left) at each centreline sample;
  // without one the line is computed (minimum curvature by gradient steps, REFERENCE_MARGIN).
  constructor(track: Track, limits: CarLimits, reference?: ArrayLike<number>) {
    this.limits = limits;
    this.n = track.centerline.distance.length;
    this.reference = reference ? lineFromOffsets(track, reference) : computeLine(track, 1);
    const ref = this.reference;
    const lines = new Map<number, ReturnType<typeof computeLine>>([[1, ref]]);
    this.referenceSpeeds = LEVELS.map(({ aggression }) => speedProfile(ref, limits, aggression));
    this.plans = LEVELS.map(({ aggression, blend }, k) => {
      if (!lines.has(blend)) lines.set(blend, lineFromOffsets(track, Array.from(ref.n, (v) => v * blend)));
      const line = lines.get(blend)!;
      const speed = line === ref ? this.referenceSpeeds[k] : speedProfile(line, limits, aggression);
      // Heading and signed curvature of the line, for the steering controller.
      const N = line.x.length, w = (i: number) => ((i % N) + N) % N;
      const heading = new Float32Array(N), kappa = new Float32Array(N);
      for (let i = 0; i < N; i++) heading[i] = Math.atan2(line.x[w(i + 1)] - line.x[w(i - 1)], line.z[w(i + 1)] - line.z[w(i - 1)]);
      for (let i = 0; i < N; i++) {
        const a = heading[w(i - 4)], b = heading[w(i + 4)];
        kappa[i] = Math.atan2(Math.sin(b - a), Math.cos(b - a)) / 16; // 8 samples of ~2 m (Accessible driver)
      }
      // Simulation driver: the line module's arc-length curvature, shared with the Simulation planner.
      return { x: line.x, y: line.y, z: line.z, s: line.s, length: line.length, speed, predicted: lapTime(line, speed), heading, kappa, kappaArc: line.kappaArc };
    });
  }

  // The driver's plan (path and speeds) at the current level.
  get plan() {
    return this.plans[auto.level - 1];
  }

  // The reference line's planned speeds at the current level's pace (the guide's colours).
  get referenceSpeed() {
    return this.referenceSpeeds[auto.level - 1];
  }

  // One fixed step of driving (browser loop and gym alike): read the car and its place on the lap,
  // write the commands into `auto`. Reseeds when the autopilot engages or the car is placed.
  private wasOn = false;
  private seenResets = -1;
  drive(car: Car, lap: LapTracker, dt: number) {
    if (auto.on) {
      const p = car.body.translation(), r = car.body.rotation();
      const yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.z * r.z));
      if (!this.wasOn || car.resets !== this.seenResets) this.reseed();
      // Simulation driver: its line position from the chassis each fixed step, and horizontal speed
      // for its horizontal-curvature terms (EM #20892).
      const lv = car.body.linvel();
      const idx = this.limits.limitAware ? lap.locate(p.x, p.z).index : lap.index;
      this.update(idx, p.x, p.z, yaw, Math.abs(car.speed), car.tyre.map((t) => t.slip), dt, Math.hypot(lv.x, lv.z));
    }
    this.wasOn = auto.on;
    this.seenResets = car.resets;
  }

  // Forget the last heading (call when the autopilot engages or the car is placed), so the yaw-rate
  // feedback can't read a jump as rotation.
  reseed() {
    this.lastYaw = null;
  }

  // `speed`: true speed (pedals, against path distance); `hSpeed`: horizontal speed, for the Simulation
  // driver's horizontal curvature, yaw-rate and preview terms.
  update(index: number, x: number, z: number, yaw: number, speed: number, slips: number[] = [0, 0, 0, 0], dt = 1 / 120, hSpeed = speed) {
    if (!auto.on) return;
    const p = this.plan, n = this.n;
    const wrap = (i: number) => ((i % n) + n) % n;
    // Steering (Stanley-style, at the front axle ~2 m ahead): the line's curvature as feed-forward,
    // plus the heading error, plus a correction toward the line for any sideways offset. Holding the
    // line itself, rather than aiming at a far point, stops it cutting in or running wide.
    const i = wrap(index + 1);
    const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const headingErr = wrapA(p.heading[i] - yaw);
    const dx = p.x[i] - x, dz = p.z[i] - z;
    const side = Math.hypot(dx, dz) * Math.sin(wrapA(Math.atan2(dx, dz) - yaw)); // + = line is on the steer+ side
    // The wheels take ~0.3 s to reach a requested angle (car STEER_IN), so the curvature feed-forward
    // reads the line that far ahead; otherwise it turns in late through quick direction changes.
    // Index `metres` along the line from `from` (the line's own distances; Simulation driver).
    const ahead = (from: number, metres: number) => {
      let k = from, d = 0;
      while (d < metres && d < p.length) { const k2 = wrap(k + 1); d += k2 > k ? p.s[k2] - p.s[k] : p.length - p.s[k]; k = k2; }
      return k;
    };
    const sv = this.limits.limitAware ? hSpeed : speed; // speed for the steering terms
    const ff = this.limits.limitAware ? ahead(i, sv * STEER_LAG) : wrap(index + 1 + Math.round((speed * STEER_LAG) / 2));
    let angle = Math.atan(WHEELBASE * p.kappa[ff]) + headingErr + Math.atan2(CROSS_GAIN * side, speed + 2);
    const yawRate = this.lastYaw === null ? 0 : wrapA(yaw - this.lastYaw) / dt;
    this.lastYaw = yaw;
    let yawRateTarget = 0;
    if (this.limits.limitAware) {
      // Simulation driver: the arc-length curvature as feed-forward, plus yaw-rate feedback toward the
      // line's yaw rate v * kappa at the car (horizontal path speed; car frame yaw as atan2(x, z)).
      yawRateTarget = sv * p.kappaArc[i];
      angle = Math.atan(WHEELBASE * p.kappaArc[ff]) + headingErr + Math.atan2(CROSS_GAIN * side, sv + 2) + YAW_GAIN * (yawRateTarget - yawRate);
    }
    let wheelAngle = angle;
    if (this.limits.limitAware) {
      // Keep the wheels within ~15% past the kinematic angle for the lateral grip the limits give at
      // this speed, plus a tyre slip-angle allowance that shrinks with speed (1.5 deg at 100 km/h):
      // at 300+ km/h a degree or two more asks for several g and spins the car.
      const L = this.limits, lat = (L.grip + L.aeroGrip * (sv / 27.78) ** 2) * 9.81;
      const grip = 1.15 * Math.atan((WHEELBASE * lat) / Math.max(sv * sv, 1)) + 0.026 * (27.78 / Math.max(sv, 10));
      // ...but never less than the line itself needs here (kinematic angle for its curvature).
      const most = Math.max(grip, 1.1 * Math.abs(Math.atan(WHEELBASE * p.kappaArc[ff])));
      // Only steering further into the car's rotation is limited; countersteer (against the measured
      // yaw rate) is never held back.
      const intoRotation = Math.abs(yawRate) < 0.02 || Math.sign(angle) === Math.sign(yawRate);
      if (intoRotation) wheelAngle = Math.max(-most, Math.min(most, angle));
    }
    auto.steer = Math.max(-1, Math.min(1, wheelAngle / steerLock(speed)));
    this.debug = { kappa: this.limits.limitAware ? p.kappaArc[i] : p.kappa[i], yawRateTarget, yawRate, side, angleRequested: angle, angleSent: auto.steer * steerLock(speed) };
    const err = headingErr;

    // Target speed a little ahead (the time it takes the pedals and car to respond).
    let target = p.speed[this.limits.limitAware ? ahead(index, speed * 0.25) : wrap(index + Math.round((speed * 0.25) / 2))];
    // Level 6 mistakes: on entering a braking zone, sometimes carry too much speed.
    const braking = target < speed - 1;
    if (auto.level === MISTAKE_LEVEL && braking && !this.lastBraking) this.mistake = this.mistakesEnabled && Math.random() < MISTAKE_CHANCE ? MISTAKE_OVERSPEED : 1;
    if (!braking && target > speed + 3) this.mistake = 1;
    this.lastBraking = braking;
    if (auto.level === MISTAKE_LEVEL) target *= this.mistake;

    // Fractional pedals: proportional to the speed error, never both at once.
    const e = target - speed;
    auto.throttle = e > 0 ? Math.min(1, e * 1.2 + 0.4) : 0;
    auto.brake = e < -0.5 ? Math.min(1, -e * 0.6) : 0;
    let holdShare = 0; // Simulation driver: throttle share that cancels drag (maintenance throttle)
    if (this.limits.limitAware) {
      // Brake for the deceleration the plan asks over the next 0.5 s, as a share of what the limits
      // say the car can do at this speed, so the pedal leads the plan instead of lagging the error.
      const L = this.limits, q = (speed / 27.78) ** 2, look = Math.max(4, speed * 0.5);
      const vAhead = p.speed[ahead(index, look)] * (auto.level === MISTAKE_LEVEL ? this.mistake : 1);
      const need = (speed * speed - vAhead * vAhead) / (2 * look) - ((L.drag ?? 0) * speed * speed) / L.mass;
      const can = Math.min(L.brakeMax ?? Infinity, L.brake + L.aeroBrake * q) * 9.81;
      if (need > 0) auto.brake = Math.max(auto.brake, Math.min(1, need / can));
      if (auto.brake > 0) auto.throttle = 0;
      else {
        // Throttle for the acceleration the plan asks over the same distance (plus drag), as a share of
        // the drive force, and only out of the grip the corner leaves (friction ellipse on the lateral
        // acceleration the car is pulling, from its yaw rate).
        const want = (vAhead * vAhead - speed * speed) / (2 * look) + ((L.drag ?? 0) * speed * speed) / L.mass;
        const drive = Math.min(L.driveForce ?? Infinity, L.power / Math.max(speed, 5)) / L.mass;
        // (the larger of what the car is pulling and what the line asks here: at the apex both are near
        // the limit, so only the drag-holding throttle below is left until the corner opens)
        const latCap = (L.grip + L.aeroGrip * q) * 9.81, latNow = Math.max(Math.abs(yawRate * sv), sv * sv * Math.abs(p.kappaArc[i]));
        const room = Math.sqrt(Math.max(0, 1 - (latNow / latCap) ** 2));
        const tractionLeft = ((L.traction ?? 1.4) + (L.aeroTraction ?? 0) * q) * 9.81 * room;
        // At the limit a driver still holds the throttle that cancels drag (a lift there pitches the car
        // forward and steps the rear out); that much drive costs only a few % of the rears' side grip.
        const hold = ((L.drag ?? 0) * speed * speed) / L.mass;
        holdShare = Math.min(1, hold / drive);
        auto.throttle = want <= 0 ? 0 : Math.min(1, Math.min(want, Math.max(tractionLeft, hold)) / drive);
      }
    }
    // Pedal modulation on the tyres' slip (the same wheel state the car uses; no hidden assistance):
    // when the rears spin past the driver's tolerance they ease the throttle, when a wheel locks they
    // ease the brake; how far they let it go and how fast they react is the driver's skill.
    const lv = LEVELS[auto.level - 1];
    const spin = Math.max(slips[2], slips[3]), lock = -Math.min(...slips);
    this.thrCap = Math.max(0, Math.min(1, this.thrCap + dt * lv.react * (spin > lv.slip ? -1 : 0.6)));
    this.brkCap = Math.max(0, Math.min(1, this.brkCap + dt * lv.react * (lock > lv.slip ? -1 : 0.6)));
    if (auto.brake === 0) this.brkCap = Math.max(this.brkCap, lv.stab); // a new braking zone starts at the driver's first-stab pressure
    const asked = auto.throttle;
    auto.throttle = Math.min(auto.throttle, this.thrCap);
    auto.brake = Math.min(auto.brake, this.brkCap);
    // Simulation driver at the limit: rear slip near the tyre's peak doesn't make them lift below the
    // throttle that holds speed against drag (a lift there steps the rear out); only clear wheelspin
    // (beyond twice their tolerance) does.
    if (this.limits.limitAware && auto.brake === 0 && spin < 2 * lv.slip) auto.throttle = Math.max(auto.throttle, Math.min(asked, holdShare));
    // At or near full steering lock, feed the throttle in (as a driver does on a slow exit) so the
    // rear tyres keep grip for turning instead of sliding wide.
    const lockUse = Math.abs(auto.steer);
    if (lockUse > 0.8) auto.throttle = Math.min(auto.throttle, 1 - 2.5 * (lockUse - 0.8));
    // Far off line at speed: ease off rather than accelerating the wrong way.
    if (Math.abs(err) > 0.5 && speed > 15) auto.throttle = Math.min(auto.throttle, 0.3);
  }
}
