const down = new Set<string>();
const DRIVING_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];

// Autopilot commands, written by the autopilot each frame while it is engaged.
// Pedals are 0..1 (fractional); keys give the endpoints.
export const auto = { on: false, throttle: 0, brake: 0, steer: 0, level: 3 };

window.addEventListener('keydown', (e) => {
  down.add(e.code);
  if (e.code === 'KeyP' && !e.repeat) auto.on = !auto.on;
  else if (/^Digit[1-6]$/.test(e.code)) auto.level = Number(e.code.slice(5)); // driver 1-5, and secret 6
  else if (DRIVING_KEYS.includes(e.code)) auto.on = false; // any driving key takes control back
});
window.addEventListener('keyup', (e) => down.delete(e.code));
window.addEventListener('blur', () => down.clear());

export const input = {
  // 0..1. Keys: 0 or 1; autopilot: any fraction.
  get throttle() { return auto.on ? auto.throttle : down.has('KeyW') || down.has('ArrowUp') ? 1 : 0; },
  get brake() { return auto.on ? auto.brake : down.has('KeyS') || down.has('ArrowDown') ? 1 : 0; },
  // S/Down at (nearly) a standstill reverses; automatic braking never does.
  get reverseKey() { return !auto.on && (down.has('KeyS') || down.has('ArrowDown')); },
  // Space brakes but never reverses, so holding it at a standstill keeps the car still.
  get brakeOnly() { return !auto.on && down.has('Space'); },
  // Steering request: -1 full right .. +1 full left. Keys give full lock; the autopilot is proportional.
  get steer() {
    if (auto.on) return auto.steer;
    return (down.has('KeyA') || down.has('ArrowLeft') ? 1 : 0) - (down.has('KeyD') || down.has('ArrowRight') ? 1 : 0);
  },
  get reset() { return down.has('KeyR'); },
};
