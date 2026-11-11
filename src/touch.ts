// Touch driving (S1.27, PO #21362/#21368, EM #21364): on touch-first screens in landscape, a steering pad
// under the left thumb and brake/throttle pedals under the right. They feed the same driver controls as
// the keyboard (src/input.ts reads `touch`), so the car and its physics are unchanged.
// Steering: the thumb's horizontal travel from where it landed, over STEER_TRAVEL px, is the steering
// request (-1 full right .. +1 full left, as the keys and autopilot give); lifting the thumb re-centres it.
// Pedals: on while held. The brake reverses at a standstill, like S. Touching any of them takes over from
// the autopilot, as a driving key does.
import { auto } from './controls';

const STEER_TRAVEL = 90; // px of thumb travel for full steering

export const touch = { steer: 0, throttle: 0, brake: 0 };

export function setupTouchDriving() {
  const pad = document.getElementById('steer-pad')!;
  const knob = pad.querySelector<HTMLElement>('.knob')!;
  const brakeEl = document.getElementById('brake-pedal')!;
  const throttleEl = document.getElementById('throttle-pedal')!;

  let steerPointer: number | null = null;
  let originX = 0;
  const showSteer = (dx: number) => (knob.style.transform = `translateX(${dx}px)`);
  const endSteer = () => {
    steerPointer = null;
    touch.steer = 0;
    showSteer(0);
    pad.classList.remove('held');
  };
  pad.addEventListener('pointerdown', (e) => {
    if (steerPointer !== null) return;
    e.preventDefault();
    steerPointer = e.pointerId;
    originX = e.clientX;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('held');
    auto.on = false;
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== steerPointer) return;
    const dx = Math.max(-STEER_TRAVEL, Math.min(STEER_TRAVEL, e.clientX - originX));
    touch.steer = -dx / STEER_TRAVEL; // thumb to the right steers right (negative)
    showSteer(dx);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    pad.addEventListener(type, (e) => e.pointerId === steerPointer && endSteer());
  }

  const pedal = (el: HTMLElement, key: 'throttle' | 'brake') => {
    let pointer: number | null = null;
    const release = () => {
      pointer = null;
      touch[key] = 0;
      el.classList.remove('held');
    };
    el.addEventListener('pointerdown', (e) => {
      if (pointer !== null) return;
      e.preventDefault();
      pointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
      touch[key] = 1;
      el.classList.add('held');
      auto.on = false;
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      el.addEventListener(type, (e) => e.pointerId === pointer && release());
    }
    return release;
  };
  const releaseBrake = pedal(brakeEl, 'brake');
  const releaseThrottle = pedal(throttleEl, 'throttle');
  // No long-press menu or selection on the controls.
  for (const el of [pad, brakeEl, throttleEl]) el.addEventListener('contextmenu', (e) => e.preventDefault());

  // Let go of everything (the pause menu opening or closing, the page losing focus).
  const releaseTouch = () => {
    endSteer();
    releaseBrake();
    releaseThrottle();
  };
  window.addEventListener('blur', releaseTouch);
  return releaseTouch;
}
