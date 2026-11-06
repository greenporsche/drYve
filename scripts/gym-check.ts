// S5.2 checks on the headless gym (same build, same host):
//  1. replay: drive one L5 lap and record its actions; reset (after that driven episode) and replay the
//     first N actions twice from fresh worlds; compare per-tick pose, velocity, steering and wheels.
//  2. reward/episode: forward progress, the seam and control-line crossing, braking to rest, rolling
//     backward (negative reward), time-limit truncation and a track-limit termination.
// Usage: bun scripts/gym-check.ts [spa|nurburgring-gp] [simulation|accessible] [replay ticks]
const [track = 'spa', mode = 'simulation', replayTicks = '3000'] = process.argv.slice(2);
(globalThis as { F1_SETTINGS?: object }).F1_SETTINGS = { track, mode, dataBase: new URL('../public/data/', import.meta.url).href };
const { Gym } = await import('../src/gym');
const { Autopilot } = await import('../src/autopilot');
const { auto } = await import('../src/controls');
const { CAR_LIMITS } = await import('../src/car');
const { loadReferenceLine, PHYSICS_DT } = await import('../src/world');
type Act = { steer: number; throttle: number; brake: number };

const gym = await Gym.create();
const driver = new Autopilot(gym.track, CAR_LIMITS, await loadReferenceLine(gym.track));
driver.mistakesEnabled = false;
const flat = (s: ReturnType<typeof gym.state>) => [s.position.x, s.position.y, s.position.z, s.linvel.x, s.linvel.y, s.linvel.z, s.steerAngle, ...s.wheels.map((w) => w.omega)];

// 1. Replay
auto.on = true; auto.level = 5;
gym.reset();
const actions: Act[] = [];
for (;;) {
  driver.drive(gym.dw.car, gym.dw.lap, PHYSICS_DT);
  const a = { steer: auto.steer, throttle: auto.throttle, brake: auto.brake };
  actions.push(a);
  const r = gym.step(a);
  if (r.terminated || r.truncated) { console.log('driven episode:', r.info.reason, 'lap', r.info.lapTime?.toFixed(3), 'valid', r.info.lapValid, 'ticks', actions.length); break; }
}
auto.on = false;
const N = Math.min(Number(replayTicks), actions.length);
const run = () => { gym.reset(); const rows: number[][] = []; for (let k = 0; k < N; k++) rows.push(flat(gym.step(actions[k]).state)); return rows; };
const A = run(), B = run();
let dPos = 0, dVel = 0, dSteer = 0, dOmega = 0;
for (let k = 0; k < N; k++) {
  const a = A[k], b = B[k];
  dPos = Math.max(dPos, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  dVel = Math.max(dVel, Math.hypot(a[3] - b[3], a[4] - b[4], a[5] - b[5]));
  dSteer = Math.max(dSteer, Math.abs(a[6] - b[6]));
  for (let j = 7; j < 11; j++) dOmega = Math.max(dOmega, Math.abs(a[j] - b[j]));
}
const vEnd = Math.hypot(A[N - 1][3], A[N - 1][4], A[N - 1][5]);
console.log(`replay ${N} ticks (${(N * PHYSICS_DT).toFixed(1)} s, ending at ${(vEnd * 3.6).toFixed(0)} km/h) twice after the driven episode: max |dpos| ${dPos} m, |dvel| ${dVel} m/s, |dsteer| ${dSteer} rad, |domega| ${dOmega} rad/s`);
// Replay the recorded lap in full: does it reproduce the driven episode's outcome?
gym.reset();
let full: ReturnType<typeof gym.step> | null = null;
for (const a of actions) { full = gym.step(a); if (full.terminated || full.truncated) break; }
console.log('full replay of the recorded actions:', full!.info.reason, 'lap', full!.info.lapTime?.toFixed(3), 'valid', full!.info.lapValid, 'tick', full!.state.tick);

// 2. Reward and episode outcomes
const L = gym.track.centerline.length!;
{ // forward driving and the seam: per-tick reward vs distance travelled, largest |reward|
  gym.reset(); let maxR = 0, sumR = 0, seamTick = -1, prevSt = gym.state().station, maxErr = 0, prevPos = gym.state().position;
  for (let k = 0; k < actions.length; k++) {
    const r = gym.step(actions[k]); sumR += r.reward; maxR = Math.max(maxR, Math.abs(r.reward));
    if (r.state.station < prevSt - L / 2) seamTick = r.state.tick;
    const moved = Math.hypot(r.state.position.x - prevPos.x, r.state.position.z - prevPos.z);
    if (moved > 0.05) maxErr = Math.max(maxErr, Math.abs(r.reward - moved));
    prevSt = r.state.station; prevPos = r.state.position;
    if (r.terminated || r.truncated) { console.log(`forward lap: total reward ${sumR.toFixed(1)} m, largest single-step |reward| ${maxR.toFixed(3)} m (top speed ${(maxR / PHYSICS_DT * 3.6).toFixed(0)} km/h equivalent), seam (station wraps) at tick ${seamTick}, largest |reward - plan-view distance moved| ${maxErr.toFixed(3)} m per step; end ${r.info.reason}`); break; }
  }
}
{ // braking to rest: full throttle 3 s down the start straight, then full brake until stopped; reward then ~0
  gym.reset(); let k = 0, r = gym.step({ steer: 0, throttle: 0, brake: 0 });
  for (; k < 3 / PHYSICS_DT; k++) r = gym.step({ steer: 0, throttle: 1, brake: 0 });
  const vTop = r.state.forwardSpeed; let ticks = 0;
  while (r.state.forwardSpeed > 0.05 && ticks < 2000) { r = gym.step({ steer: 0, throttle: 0, brake: 1 }); ticks++; }
  let rest = 0; for (let j = 0; j < 120; j++) { r = gym.step({ steer: 0, throttle: 0, brake: 1 }); rest += r.reward; }
  console.log(`braking to rest: ${(vTop * 3.6).toFixed(0)} km/h -> ${(r.state.forwardSpeed * 3.6).toFixed(2)} km/h in ${(ticks * PHYSICS_DT).toFixed(2)} s; reward over the next 1 s at rest ${rest.toFixed(4)} m; never reversed: ${r.state.forwardSpeed >= -0.05}; ended ${r.info.reason ?? 'no'}`);
}
{ // rolling backward (test harness sets a backward velocity once after reset): reward is negative
  gym.reset(); for (let k = 0; k < 10; k++) gym.step({ steer: 0, throttle: 0, brake: 0 });
  const b = gym.dw.car.body, q = b.rotation(); const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  b.setLinvel({ x: -Math.sin(yaw) * 5, y: 0, z: -Math.cos(yaw) * 5 }, true);
  let s = 0; for (let k = 0; k < 60; k++) s += gym.step({ steer: 0, throttle: 0, brake: 0 }).reward;
  console.log(`rolling backward at ~5 m/s for 0.5 s: reward ${s.toFixed(3)} m (negative expected)`);
}
{ // time limit: truncation, not termination
  const short = await Gym.create({ horizon: 240 }); short.reset(); let r = short.step({ steer: 0, throttle: 0, brake: 0 });
  while (!r.terminated && !r.truncated) r = short.step({ steer: 0, throttle: 0.3, brake: 0 });
  console.log(`horizon 240 ticks: tick ${r.state.tick}, reason ${r.info.reason}, terminated ${r.terminated}, truncated ${r.truncated}`);
}
{ // track limit: drive the L5 lap but steer full left from 20 s
  auto.on = true; gym.reset(); let r = gym.step({ steer: 0, throttle: 0, brake: 0 });
  while (!r.terminated && !r.truncated) { driver.drive(gym.dw.car, gym.dw.lap, PHYSICS_DT); r = gym.step({ steer: r.state.time > 20 ? 1 : auto.steer, throttle: auto.throttle, brake: auto.brake }); }
  auto.on = false;
  console.log(`steering off the road at 20 s: reason ${r.info.reason}, terminated ${r.terminated}, at ${r.state.time.toFixed(2)} s, station ${r.state.station.toFixed(0)} m, ${r.state.offCentre.toFixed(2)} m from centre, no recovery (car still where it left: ${r.state.offCentre > 5})`);
}
