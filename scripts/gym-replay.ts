// Replay a recorded action file through the headless gym and write the per-tick state (S5.2
// browser/headless agreement; the browser side runs the same Gym inside the page, see
// scripts/gym-browser.ts). Usage: bun scripts/gym-replay.ts <actions.json> <states-out.json>
const [actionsFile, out] = process.argv.slice(2);
const rec = await Bun.file(actionsFile).json();
(globalThis as { F1_SETTINGS?: object }).F1_SETTINGS = { track: rec.circuit, mode: rec.mode, dataBase: new URL('../public/data/', import.meta.url).href };
const { Gym } = await import('../src/gym');
const gym = await Gym.create();
gym.reset();
const rows: number[][] = [];
for (const [steer, throttle, brake] of rec.actions as number[][]) {
  const s = gym.step({ steer, throttle, brake }).state;
  rows.push([s.position.x, s.position.y, s.position.z, s.linvel.x, s.linvel.y, s.linvel.z, s.steerAngle, ...s.wheels.map((w) => w.omega)]);
}
await Bun.write(out, JSON.stringify({ runtime: `bun ${Bun.version}`, rows }));
console.log('replayed', rows.length, 'ticks');
