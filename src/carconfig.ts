// Driving modes (PO #20840, EM #20849): one immutable car configuration per mode, read by the car,
// the steering and the speed planner. The mode comes from the page URL (?mode=accessible|simulation,
// Accessible by default); the on-screen picker reloads the page with the circuit kept, so the
// session (and lap timing) restarts. Driver levels (autopilot 1-6) are separate from the car.
//
// Accessible: the car as built so far, forgiving: a G-based steering cap keeps a held key from
// asking more than the tyres can give.
// Simulation: the same solver and tyre model, but no steering help: the physical steering lock and
// the progressive key input only, so over-asking the tyres understeers or spins. Its values are
// being calibrated against 2025 F1 references (S1.13); this is not a reconstruction of a real car.
import type { CarLimits } from './raceline';

export interface CarConfig {
  id: 'accessible' | 'simulation';
  label: string;
  mass: number; // kg
  drag: number; // N per (m/s)^2
  downforce: number; // N per (m/s)^2
  spring: number; // suspension stiffness
  comY: number; // m, centre of mass below the chassis origin
  enginePeak: number; // N per rear wheel at low speed
  power: number; // W at the rear wheels
  brakeFront: number; // N at the contact patch per front wheel at full pedal
  brakeRear: number; // N per rear wheel
  wheelInertia: number; // kg m^2
  muPeak: number; // longitudinal friction at the slip peak
  slipB: number; // tyre curve shape: mu(k) = muPeak sin(slipC atan(slipB k))
  slipC: number;
  frictionSlip: { front: number; rear: number }; // Rapier controller grip parameter (not a literal mu)
  // Shared tyre-force budget: each wheel's combined lengthwise and sideways force stays within
  // budget x its load, by setting Rapier's per-wheel clamp each step from the lengthwise force in use.
  // null = Rapier's own clamp with the fixed frictionSlip above (Accessible's approximation).
  tyreBudget: number | null;
  sideGripSpinning: number; // side friction stiffness left on a driven wheel past the slip peak
  revHeadroom: number; // rev-limit stand-in: spin limit = headroom x road spin + base
  revBase: number; // rad/s
  maxSteer: number; // rad, physical steering lock
  steerCap: { low: number; aero: number } | null; // G-based lock cap (m/s^2 at low speed, + per (100 km/h)^2); null = none
  steerIn: number; // 1/s, how quickly the wheels turn toward the requested angle
  steerOut: number; // 1/s, how quickly they return to centre on release
  rumble: number; // m/s of vertical velocity kick per wheel per step on a kerb (felt rumble)
  limits: CarLimits; // what the speed planner assumes the car can do
}

const ACCESSIBLE: CarConfig = {
  id: 'accessible',
  label: 'Accessible',
  mass: 750,
  drag: 0.97,
  downforce: 4.5,
  spring: 88,
  comY: -0.28,
  enginePeak: 5250,
  power: 850000,
  brakeFront: 12300,
  brakeRear: 6900,
  wheelInertia: 1.2,
  muPeak: 1.8,
  slipB: 12,
  slipC: 1.65,
  frictionSlip: { front: 4.3, rear: 5.6 },
  tyreBudget: null,
  sideGripSpinning: 0.35,
  revHeadroom: 1.15,
  revBase: 30,
  maxSteer: 0.45,
  steerCap: { low: 2.6 * 9.81, aero: 0.42 * 9.81 },
  steerIn: 3.5,
  steerOut: 7,
  rumble: 0.035,
  limits: {
    grip: 2.3, aeroGrip: 0.38,
    brake: 1.55, aeroBrake: 0.83, brakeMax: 6.0, traction: 0.85, aeroTraction: 0.35,
    power: 850000, mass: 750, topSpeed: 96, drag: 0.97,
  },
};

// Simulation (S1.13, EM #20856): calibrated against 2025 references where they exist, labelled
// engineering assumptions where they don't; not a reconstruction of any team's car.
//  - mass: FIA 2025 minimum, 800 kg without fuel (fuel load and setup unknown).
//  - tyres: one shared friction budget, mu 1.8 on each wheel's load (assumed, inside the 1.6-2.0
//    effective lateral mu agreed with the EM; no 2025 tyre data is public). The lengthwise curve peaks
//    at the same mu, so braking, drive and cornering draw on one budget.
//  - downforce 3.4 N/(m/s)^2: about 3x the car's weight at 300 km/h (assumed typical figure).
//  - brakes: 29.7 kN at the patches (64% front), sized so full pedal at ~311 km/h gives Brembo's
//    2025 Spa peak of about 4.7 g with drag; below about 180 km/h full pedal can lock the tyres.
//  - drag and power unchanged from Accessible (top speed ~340 km/h, close to the 2025 Spa pole lap).
//  - steering: no G-based cap; the physical lock and the progressive key input only.
const MU = 1.8, DOWNFORCE_SIM = 3.4, MASS_SIM = 800;
const AERO_G = (MU * DOWNFORCE_SIM * 27.78 ** 2) / (MASS_SIM * 9.81); // g of grip added per (100 km/h)^2
const SIMULATION: CarConfig = {
  ...ACCESSIBLE,
  id: 'simulation',
  label: 'Simulation',
  mass: MASS_SIM,
  downforce: DOWNFORCE_SIM,
  brakeFront: 9500,
  brakeRear: 5350,
  muPeak: MU,
  frictionSlip: { front: MU, rear: MU },
  tyreBudget: MU,
  steerCap: null,
  // No synthetic kerb kick (EM #20892): the kerbs' raised, ridged collision geometry already reaches the
  // suspension; the extra alternating impulses (Accessible's felt rumble) have no physical reference.
  rumble: 0,
  // What the speed planner assumes: the car's measured envelope, not the tyre budget itself (the
  // whole car corners below mu because the fronts saturate first). Flat-pad ramp-steer plateaus
  // (S1.13 first pass): 2.08 / 2.92 / 3.90 / 5.14 / 6.65 g at 90 / 150 / 200 / 250 / 300 km/h, fitted
  // by 1.63 + 0.56 (v / 100 km/h)^2 within 0.05 g, on the road-normal load (verticalLoad: crests and
  // compressions, EM #20881). Braking the same, capped by the brake hardware; traction ~55% of the
  // load on the driven rears.
  limits: {
    ...ACCESSIBLE.limits,
    grip: 1.63, aeroGrip: 0.56,
    brake: 1.63, aeroBrake: 0.56, brakeMax: 3.78, // brakeMax: the brakes alone (29.7 kN / 800 kg); drag added by the planner
    traction: MU * 0.55, aeroTraction: AERO_G * 0.55,
    mass: MASS_SIM,
    verticalLoad: true,
    driveForce: 2 * 5250, // the car's two driven wheels at enginePeak (power-limited above ~290 km/h)
    limitAware: true,
    // Plan corners at 95% of the measured lateral envelope: a reserve for the driver's tracking error
    // through quick direction changes (EM #20889 named this margin). At 100% the GP Schumacher-S
    // flying lap stepped the rear out at ~5 g and went invalid (EM #21036); at 95% 9/9 GP laps valid
    // (flying 98.1-98.7 s, faster than the 102-104 s with slides) and Spa 108.7 s (was 107.4 s).
    trackingMargin: 0.95,
  },
};

export const MODES = [ACCESSIBLE, SIMULATION].map((c) => Object.freeze(c));
const requested = new URLSearchParams(location.search).get('mode');
export const CAR: Readonly<CarConfig> = MODES.find((m) => m.id === requested) ?? MODES[0];
