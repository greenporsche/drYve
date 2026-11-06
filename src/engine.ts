// Virtual engine and 8-speed gearbox, driven by road speed. It feeds the steering-wheel display
// (gear, rev lights, paddle flashes) and the engine sound; it does not change the drive force.
const GEAR_TOP_KMH = [80, 115, 145, 175, 205, 235, 270, 320]; // road speed at the rev limit per gear
const IDLE_RPM = 4000;
const LIMIT_RPM = 12500;
const UPSHIFT_RPM = 11900;
const DOWNSHIFT_BELOW = 9750; // shift down once the next gear down would be under this (hysteresis)
const SHIFT_FLASH_MS = 250;

export type ShiftDir = 'up' | 'down' | null;

export class Engine {
  gear = 1; // 1..8, 0 = reverse
  rpm = IDLE_RPM;
  lastShift: ShiftDir = null;
  private lastShiftAt = -Infinity;

  private rpmIn(gear: number, kmh: number) {
    return IDLE_RPM + (kmh / GEAR_TOP_KMH[gear - 1]) * (LIMIT_RPM - IDLE_RPM);
  }

  update(speedMs: number, reversing: boolean, now: number) {
    const kmh = Math.abs(speedMs) * 3.6;
    if (reversing && speedMs < -0.5) {
      this.gear = 0;
      this.rpm = Math.min(LIMIT_RPM, IDLE_RPM + kmh * 120);
      return;
    }
    if (this.gear === 0) this.gear = 1;
    // Upshift at the shift point; downshift once the next gear down would sit comfortably below it.
    if (this.gear < 8 && this.rpmIn(this.gear, kmh) > UPSHIFT_RPM) this.shift(+1, now);
    else if (this.gear > 1 && this.rpmIn(this.gear - 1, kmh) < DOWNSHIFT_BELOW) this.shift(-1, now);
    this.rpm = Math.min(LIMIT_RPM, this.rpmIn(this.gear, kmh));
  }

  private shift(dir: 1 | -1, now: number) {
    this.gear += dir;
    this.lastShift = dir > 0 ? 'up' : 'down';
    this.lastShiftAt = now;
  }

  // Which paddle is lit right now (for a short flash after each shift).
  paddle(now: number): ShiftDir {
    return now - this.lastShiftAt < SHIFT_FLASH_MS ? this.lastShift : null;
  }

  // Rev lights, 0..1 across the strip, starting at 9000 rpm; true near the limit to flash them.
  revLights() {
    return { fill: Math.max(0, Math.min(1, (this.rpm - 9000) / (UPSHIFT_RPM - 9000))), flash: this.rpm >= UPSHIFT_RPM - 150 };
  }
}
