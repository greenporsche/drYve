// Headless happy path (S5.2): reset the shared driving world in a Bun process (no browser, DOM or
// renderer) and drive one lap from the grid with the existing autopilot driver, whose commands go in
// through gym.step(action) like any other policy's.
// Usage: bun scripts/gym-lap.ts [spa|nurburgring-gp] [simulation|accessible] [level 1-5] [actions-out.json]
const [track = 'spa', mode = 'simulation', level = '5', out] = process.argv.slice(2);
(globalThis as { F1_SETTINGS?: object }).F1_SETTINGS = { track, mode, dataBase: new URL('../public/data/', import.meta.url).href };
const { Gym } = await import('../src/gym');
const { Autopilot } = await import('../src/autopilot');
const { auto } = await import('../src/controls');
const { CAR_LIMITS } = await import('../src/car');
const { loadReferenceLine, PHYSICS_DT } = await import('../src/world');

const t0 = performance.now();
const gym = await Gym.create();
const driver = new Autopilot(gym.track, CAR_LIMITS, await loadReferenceLine(gym.track));
auto.on = true;
auto.level = Number(level);
driver.mistakesEnabled = false;
let state = gym.reset();
let total = 0, ticks = 0, finite = true;
const actions: number[][] = [];
for (;;) {
  driver.drive(gym.dw.car, gym.dw.lap, PHYSICS_DT);
  const action = { steer: auto.steer, throttle: auto.throttle, brake: auto.brake };
  if (out) actions.push([action.steer, action.throttle, action.brake]);
  const r = gym.step(action);
  state = r.state;
  total += r.reward;
  ticks++;
  finite &&= Number.isFinite(r.reward) && [state.position.x, state.position.y, state.position.z, state.forwardSpeed].every(Number.isFinite);
  if (r.terminated || r.truncated) {
    console.log(JSON.stringify({ circuit: gym.circuit, mode: gym.mode, level: auto.level, reason: r.info.reason, terminated: r.terminated, truncated: r.truncated, lapTime: r.info.lapTime, lapValid: r.info.lapValid, ticks, simTime: +state.time.toFixed(4), progress_m: +total.toFixed(2), finite, wallSeconds: +((performance.now() - t0) / 1000).toFixed(1) }));
    break;
  }
}
if (out) await Bun.write(out, JSON.stringify({ circuit: gym.circuit, mode: gym.mode, actions }));
