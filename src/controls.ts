// Driver controls, shared by every driver (keyboard, autopilot, gym), with no browser dependency.
// Pedals 0..1; steer -1 (full right) .. +1 (full left), as a share of the speed's steering lock.
export interface Controls {
  readonly throttle: number;
  readonly brake: number;
  readonly steer: number;
  readonly reverseKey: boolean; // brake at (nearly) a standstill reverses (keyboard S/Down only)
  readonly brakeOnly: boolean; // brake that never reverses (Space)
  readonly reset: boolean; // back to the grid (R)
}

// Autopilot commands, written by the autopilot at each fixed step while it is engaged.
export const auto = { on: false, throttle: 0, brake: 0, steer: 0, level: 3 };
