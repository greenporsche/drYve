import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Controls } from './controls';
import { buildBodywork } from './bodywork';
import { CAR } from './carconfig';

// Chassis-local axes: +Z forward, +Y up, +X left (axle -X gives forward = up × axle = +Z).
const HALF = { x: 0.5, y: 0.25, z: 2.5 };
const BODY_HALF_Y = 0.18; // collision body half-height: floor 7 cm higher than the 0.25 box
const BODY_ROUND = 0.08; // m, rounded edges on the collision body
const CHASSIS_MASS = CAR.mass; // kg (driving mode: src/carconfig.ts)
const DRAG = CAR.drag; // N per (m/s)^2: 850 kW tops out near 345 km/h at Accessible's drag
const SPRING = CAR.spring; // suspension stiffness (Accessible 88: 40 bottomed out under F1-level downforce)
const COM_Y = CAR.comY; // m below the chassis origin: centre of mass ~0.3 m above the road

// What this car can do (used by the racing-line speed plan): calibrated against autopilot laps.
// Steering lock available at a speed (rad): full lock at low speed, capped by the cornering limit.
export function steerLock(v: number) {
  // Simulation has no G-based cap: the physical lock only (over-asking the tyres understeers or spins).
  if (!CAR.steerCap) return MAX_STEER;
  const maxLat = CAR.steerCap.low + CAR.steerCap.aero * (v / 27.78) ** 2;
  return Math.min(MAX_STEER, (WHEELBASE * maxLat) / Math.max(v * v, 1));
}

export const CAR_LIMITS = CAR.limits; // what the speed planner assumes (per driving mode)
export const TYRE_SLIP_PEAK = 0.12; // slip at the tyre's grip peak (see SLIP_B / SLIP_C below)
const WHEEL_RADIUS = 0.34;
const REST_LENGTH = 0.3;
const WHEELS = [
  { x: 0.95, z: 1.7, front: true },
  { x: -0.95, z: 1.7, front: true },
  { x: 0.95, z: -1.6, front: false },
  { x: -0.95, z: -1.6, front: false },
];
const ENGINE_FORCE = CAR.enginePeak; // per rear wheel, N, at low speed
const POWER = CAR.power; // W at the rear wheels; above ~70 km/h the drive force is power-limited
// Brakes: force at the contact patch per wheel at full pedal (brake torque / radius). 64% front bias (about the front axle's share of the load under hard braking),
// about 6 g at 300 km/h with drag; below that the tyres, not the brakes, set the limit, so a full
// pedal locks the wheels as the downforce falls away.
const BRAKE_FRONT = CAR.brakeFront; // N
const BRAKE_REAR = CAR.brakeRear; // N
// Tyre and wheel model (S1.9): each wheel spins at its own rate; the tyre's longitudinal force comes
// from its slip against the road. Floor the throttle and the rears spin up past the grip peak and
// push less; brake too hard and a wheel locks and slides with less grip, and less side grip too.
const WHEEL_INERTIA = CAR.wheelInertia; // kg m^2, wheel + tyre + brake disc
const MU_PEAK = CAR.muPeak; // longitudinal friction at the slip peak
const SLIP_B = CAR.slipB, SLIP_C = CAR.slipC; // mu(k) = MU_PEAK sin(C atan(B k)): Accessible peaks near k = 0.12, ~63% at full slip (assumed shape, not F1 tyre data)
const SUBSTEPS = 8; // Simulation: implicit wheel-spin sub-steps per physics step
const TYRE_BUDGET = CAR.tyreBudget; // shared friction budget mu, or null (see carconfig)
const SLIP_V_MIN = 3; // m/s: slip is measured against at least this speed so a standing start is stable
// A sliding tyre (past the slip peak, spinning up or locked): its friction is sliding friction acting
// against the patch's sliding velocity (lengthwise slide plus sideways velocity), not a rolling
// wheel's sideways grip. So a locked, steered front ploughs on instead of turning (PO #20820).
const M_EFF_DEFAULT = 150; // kg: first guess of the mass Rapier's side constraint acts on at one wheel
// Driven wheelspin keeps the S1.9 treatment for now (side grip falls to this share past the peak);
// applying the full sliding model to spinning rears too makes a floored keyboard start spin the car.
const SIDE_GRIP_SPINNING = CAR.sideGripSpinning;
// Rev limit: a spinning driven wheel can't outrun the engine. Drive torque fades to zero over the
// last REV_FADE rad/s below a spin limit just above the gear's road speed (a simple stand-in for
// the gearbox: about 37 km/h worth of spin at a standstill, 15% above road speed when rolling).
const REV_HEADROOM = CAR.revHeadroom, REV_BASE = CAR.revBase, REV_FADE = 8; // x road-speed spin, rad/s, rad/s
const SLIP_PEAK = Math.tan(Math.PI / (2 * SLIP_C)) / SLIP_B;
const muX = (k: number) => MU_PEAK * Math.sin(SLIP_C * Math.atan(SLIP_B * k));
const muXSlope = (k: number) => (MU_PEAK * Math.cos(SLIP_C * Math.atan(SLIP_B * k)) * SLIP_C * SLIP_B) / (1 + (SLIP_B * k) ** 2);
const MAX_STEER = CAR.maxSteer; // rad, physical steering lock
const WHEELBASE = 3.3; // m, front to rear axle
// Steering lock shrinks with speed so a full keyboard press asks for about this much
// cornering (m/s^2): roughly what a downforce car can hold, so a held key turns hard
// without spinning, and the keyboard's on/off input stays usable at 300 km/h.
// F1-like: about 2 g of mechanical grip plus downforce that grows with speed squared (~5 g at 300 km/h).
const STEER_IN = CAR.steerIn; // 1/s, how quickly the wheels turn toward the requested angle
const STEER_OUT = CAR.steerOut; // 1/s, how quickly they return to centre on release
const DOWNFORCE = CAR.downforce; // N per (m/s)^2 (Accessible 4.5: ~31 kN, 4.2x weight, at 300 km/h)
const RUMBLE = CAR.rumble; // Accessible 0.035; // m/s of vertical velocity per wheel per step while on a kerb, at speed
const WIDTH = 0.35; // m, tyre width
const RIM_RADIUS = 0.22; // m
const SPOKES = 5;
const TREAD_BARS = 5; // same spacing as the spokes, so one blur threshold suits both
// Spokes start to strobe once a wheel turns more than half the spoke spacing per frame
// (2*pi/5/2 = 0.63 rad). Fade them out between these per-frame angles and show a blurred rim.
const BLUR_FROM = 0.4, BLUR_TO = 0.6; // rad per rendered frame

export class Car {
  body: RAPIER.RigidBody;
  vehicle: RAPIER.DynamicRayCastVehicleController;
  group = new THREE.Group();
  wheels: THREE.Object3D[] = [];
  private wheelLooks: { spokeMat: THREE.MeshStandardMaterial; blurMat: THREE.MeshStandardMaterial; blur: THREE.Mesh; }[] = [];
  private lastVisualSync = performance.now();
  // Pose before the most recent physics step, for drawing the car between steps.
  private prevPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private snapVisuals = true;
  resets = 0;
  kerbHandle = -1; // collider handle of the kerbs, set by main.ts
  wheelsOnKerb = 0; // how many wheels touched a kerb at the last step (for sound and display)
  odometer = 0; // metres driven, for the kerb ridge rate (physics and sound)
  private settleSteps = 0;
  steer = 0; // front-wheel angle actually applied, rad (+ = left)
  private brakeLight!: THREE.MeshStandardMaterial;
  // Controls actually applied at the last physics step, for the driver display: 0..1.
  applied = { throttle: 0, brake: 0, reverse: false };
  // Per-wheel state (FL, FR, RL, RR): spin rate (rad/s), rotation angle, longitudinal slip, the tyre
  // force asked of Rapier and the share of it Rapier delivered at the last step (its friction clamp).
  // balance: the last step's angular-momentum residual, I dw - ((Td - Tb) dt - R J_delivered) (should be ~0).
  readonly tyre = WHEELS.map(() => ({ omega: 0, angle: 0, slip: 0, slide: 0, fz: 0, fx: 0, fxSolve: 0, delivered: 0, torque: 0, balance: 0, vc: 0, den: SLIP_V_MIN, vLat: 0, sliding: 0, sideStiffness: 1, sideImpulse: 0, mEff: M_EFF_DEFAULT, combinedSlide: 0, mEffUpdated: false }));
  // G-meter (sampled once per fixed step from the true physics velocity, in the car's frame): what the
  // driver feels, acceleration minus gravity. `g` is the sustained load (smoothed over ~0.1 s, the
  // corner/braking reading); `gRaw` the per-step value, where brief kerb and bump spikes show.
  readonly g = { lat: 0, lon: 0 };
  readonly gRaw = { lat: 0, lon: 0 };
  private prevVel: { x: number; y: number; z: number } | null = null;
  private dt = 1 / 120;

  // controls: the driver's inputs (keyboard/autopilot in the browser, the gym's action headless).
  constructor(scene: THREE.Object3D, world: RAPIER.World, private spawn: { pos: THREE.Vector3; yaw: number }, private controls: Controls) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setLinearDamping(0) // aerodynamic drag is applied explicitly (DRAG), matching the speed planner
        .setAngularDamping(1.5)
        .setCanSleep(false)
        // Mass and inertia of the original 1 x 0.5 x 5 m, 750 kg box, but with the centre of mass low,
        // near axle height as on an F1 car. With F1-level grip, a centre of mass at the box centre
        // let the tyre forces roll the car over at speed (e.g. through Raidillon at 315 km/h).
        .setAdditionalMassProperties(CHASSIS_MASS, { x: 0, y: COM_Y, z: 0 }, { x: 1578, y: 1625, z: 78 }, { x: 0, y: 0, z: 0, w: 1 }),
    );
    world.createCollider(
      // Chassis body for collisions only (the wheels are ray casts). Rounded and slightly thinner so
      // its floor rides over slope breaks, frictionless (MIN combine) so bottoming out slides rather
      // than stopping the car dead, and mass pinned to the original 750 kg box so handling is unchanged.
      RAPIER.ColliderDesc.roundCuboid(HALF.x - BODY_ROUND, BODY_HALF_Y - BODY_ROUND, HALF.z - BODY_ROUND, BODY_ROUND)
        .setMass(0) // mass comes from the body's own mass properties above
        .setFriction(0)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );

    this.vehicle = world.createVehicleController(this.body);
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;
    WHEELS.forEach((w, i) => {
      this.vehicle.addWheel({ x: w.x, y: 0, z: w.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, REST_LENGTH, WHEEL_RADIUS);
      this.vehicle.setWheelSuspensionStiffness(i, SPRING); // carries weight + downforce without bottoming at 330 km/h
      this.vehicle.setWheelSuspensionCompression(i, 2.5);
      this.vehicle.setWheelSuspensionRelaxation(i, 3.0);
      this.vehicle.setWheelMaxSuspensionTravel(i, 0.25);
      this.vehicle.setWheelMaxSuspensionForce(i, 200000);
      // More rear grip than front: the car pushes wide at the limit instead of snapping round.
      this.vehicle.setWheelFrictionSlip(i, w.front ? CAR.frictionSlip.front : CAR.frictionSlip.rear);
    });

    // Visible single-seater shell; the physics chassis is still the cuboid collider above.
    const body = buildBodywork();
    this.group.add(body.shell);
    this.brakeLight = body.brakeLight;
    scene.add(this.group);

    // Wheel: black tyre, grey rim and five bright spokes on both faces so rotation reads clearly.
    // A translucent disc over the rim fades in as the spokes start to strobe at speed.
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WIDTH, 24).rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const rimGeo = new THREE.CylinderGeometry(RIM_RADIUS, RIM_RADIUS, WIDTH + 0.01, 24).rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.4 });
    const spokeGeo = new THREE.BoxGeometry(WIDTH + 0.02, 0.05, RIM_RADIUS * 0.95).translate(0, 0, RIM_RADIUS * 0.475);
    // Tread bars: the chase camera mostly sees the top of the tyre, so rotation has to read there too.
    const treadGeo = new THREE.BoxGeometry(WIDTH * 0.9, 0.012, 0.06).translate(0, WHEEL_RADIUS + 0.004, 0);
    const blurGeo = new THREE.CylinderGeometry(RIM_RADIUS, RIM_RADIUS, WIDTH + 0.03, 24).rotateZ(Math.PI / 2);
    // Open band just outside the tread: the smeared tread bars as seen from the chase camera.
    const treadBlurGeo = new THREE.CylinderGeometry(WHEEL_RADIUS + 0.008, WHEEL_RADIUS + 0.008, WIDTH * 0.9, 24, 1, true).rotateZ(Math.PI / 2);
    for (let i = 0; i < WHEELS.length; i++) {
      const pivot = new THREE.Object3D();
      const spin = new THREE.Mesh(wheelGeo, wheelMat);
      spin.add(new THREE.Mesh(rimGeo, rimMat));
      const spokeMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, transparent: true });
      for (let k = 0; k < SPOKES; k++) {
        const spoke = new THREE.Mesh(spokeGeo, spokeMat);
        spoke.rotation.x = (k * 2 * Math.PI) / SPOKES;
        spin.add(spoke);
      }
      for (let k = 0; k < TREAD_BARS; k++) {
        const bar = new THREE.Mesh(treadGeo, spokeMat);
        bar.rotation.x = (k * 2 * Math.PI) / TREAD_BARS;
        spin.add(bar);
      }
      const blurMat = new THREE.MeshStandardMaterial({ color: 0x9a9070, transparent: true, opacity: 0, depthWrite: false });
      const blur = new THREE.Mesh(blurGeo, blurMat);
      blur.add(new THREE.Mesh(treadBlurGeo, blurMat));
      blur.visible = false;
      pivot.add(blur); // on the pivot, not the spinning mesh: a blurred rim looks the same at any angle
      this.wheelLooks.push({ spokeMat, blurMat, blur });
      spin.castShadow = true;
      pivot.add(spin);
      this.group.add(pivot);
      this.wheels.push(pivot);
    }
    this.reset();
  }

  onGrid = true; // false after a track recovery, until the next grid reset
  reset() {
    this.placeAt(this.spawn.pos, this.spawn.yaw);
    this.onGrid = true;
  }

  // Put the car at rest at a position, facing yaw (used for the grid and for track recovery).
  placeAt(pos: { x: number; y: number; z: number }, yaw: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation(pos, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.snapVisuals = true; // don't draw a blend from the old position to the spawn
    this.settleSteps = 6; // hold still briefly so suspension state left over from before can't launch it
    this.rollWheels(0); // and no spin left over from before, so a reset creates no false slip
    this.prevVel = null; // nor a false G spike
    Object.assign(this.g, { lat: 0, lon: 0 });
    Object.assign(this.gRaw, { lat: 0, lon: 0 });
    this.resets++;
  }

  // Call after each physics world step: updates the G-meter from the change in true velocity.
  sampleG(dt: number) {
    const v = this.body.linvel();
    const prev = this.prevVel;
    this.prevVel = { x: v.x, y: v.y, z: v.z };
    if (!prev || this.settleSteps > 0) return;
    // Felt acceleration = a - gravity (gravity is -9.81 in Y), into the car's frame (+X left, +Z forward).
    const q = this.body.rotation();
    const inv = new THREE.Quaternion(q.x, q.y, q.z, q.w).invert();
    const a = new THREE.Vector3((v.x - prev.x) / dt, (v.y - prev.y) / dt + 9.81, (v.z - prev.z) / dt).applyQuaternion(inv);
    this.gRaw.lat = a.x / 9.81; // + = toward the car's left (turning left)
    this.gRaw.lon = a.z / 9.81; // + = accelerating, - = braking
    const k = Math.min(1, dt / 0.12); // ~0.1 s: holds a corner or braking load, drops single-step bumps
    this.g.lat += (this.gRaw.lat - this.g.lat) * k;
    this.g.lon += (this.gRaw.lon - this.g.lon) * k;
  }

  // Set every wheel rolling at road speed v (m/s) with no slip (placement; tests that start at speed).
  rollWheels(v: number) {
    this.tyre.forEach((t, i) => {
      Object.assign(t, { omega: v / WHEEL_RADIUS, slip: 0, fx: 0, delivered: 0, torque: 0, balance: 0, vc: v, den: Math.max(Math.abs(v), SLIP_V_MIN) });
      this.prevOmega[i] = v / WHEEL_RADIUS;
    });
  }

  // Height of the drawn car's origin above the road under it: the average vertical drop from the
  // origin to the bottoms of the four wheels, in the current (drawn) orientation.
  heightAboveRoad() {
    let sum = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < WHEELS.length; i++) {
      const conn = this.vehicle.wheelChassisConnectionPointCs(i)!;
      const len = this.vehicle.wheelSuspensionLength(i) ?? REST_LENGTH;
      p.set(conn.x, conn.y - len - WHEEL_RADIUS, conn.z).applyQuaternion(this.group.quaternion);
      sum -= p.y;
    }
    return sum / WHEELS.length;
  }

  // Call before each physics step: remembers the pose the step starts from.
  capturePrev() {
    const t = this.body.translation(), r = this.body.rotation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.set(r.x, r.y, r.z, r.w);
  }

  // Forward speed along chassis +Z, m/s.
  get speed() {
    return this.vehicle.currentVehicleSpeed();
  }

  step(dt: number) {
    const input = this.controls;
    if (input.reset) this.reset();
    if (this.settleSteps > 0) {
      this.settleSteps--;
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    const v = this.speed;
    const drive = Math.min(ENGINE_FORCE, POWER / 2 / Math.max(Math.abs(v), 1)); // per wheel
    let engine = drive * input.throttle;
    let brake = 0;
    if (input.brakeOnly) {
      brake = 1;
      engine = 0;
    } else if (input.brake > 0) {
      if (v > 1 || !input.reverseKey) brake = input.brake;
      else engine = -ENGINE_FORCE * 0.4; // S at (nearly) a standstill: reverse
    }
    // Throttle readout as a share of the drive force available at this speed (full throttle reads
    // 100% even where power limits the force); powered reverse shows as 40%.
    this.applied.throttle = engine < 0 ? 0.4 : engine / drive;
    this.applied.brake = brake;
    this.applied.reverse = engine < 0;
    const target = input.steer;
    // Bicycle model: lateral accel = v^2 * steer / wheelbase, so cap steer at the angle
    // that gives MAX_LATERAL at the current speed.
    const lock = steerLock(v);
    const want = target * lock;
    const rate = target !== 0 && Math.sign(want - this.steer) === Math.sign(target) ? STEER_IN : STEER_OUT;
    this.steer += (want - this.steer) * Math.min(1, dt * rate);

    this.dt = dt;
    this.updateTyres(dt, engine, brake);

    // Simple aerodynamic downforce along chassis down.
    const rot = this.body.rotation();
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w));
    const f = DOWNFORCE * v * v * dt;
    this.body.applyImpulse({ x: down.x * f, y: down.y * f, z: down.z * f }, true);
    // Aerodynamic drag, opposite the direction of travel.
    const lv = this.body.linvel(), sp = Math.hypot(lv.x, lv.y, lv.z);
    if (sp > 0.5) {
      const d = (DRAG * sp * dt) ; // impulse per unit velocity component: DRAG * sp^2 * dt along -v
      this.body.applyImpulse({ x: -lv.x * d, y: -lv.y * d, z: -lv.z * d }, true);
    }

    // Rumble: a wheel on a kerb gets small alternating up/down pushes at the ridge rate (one ridge
    // per metre, capped at 30 Hz so the 120 Hz physics can resolve it), felt through the suspension.
    this.odometer += Math.abs(v) * dt;
    this.wheelsOnKerb = 0;
    const pitch = Math.max(1, Math.abs(v) / 30);
    const phase = Math.sin((this.odometer / pitch) * Math.PI * 2) > 0 ? 1 : -1;
    const kick = this.body.mass() * RUMBLE * Math.min(1, Math.abs(v) / 15);
    for (let i = 0; i < WHEELS.length; i++) {
      if (this.vehicle.wheelGroundObject(i)?.handle !== this.kerbHandle) continue;
      this.wheelsOnKerb++;
      const at = this.vehicle.wheelContactPoint(i);
      if (at) this.body.applyImpulseAtPoint({ x: 0, y: phase * kick, z: 0 }, at, true);
    }

    this.vehicle.updateVehicle(dt);
    // Same-step reconciliation: the spin update assumed the road pushed back with the requested force;
    // Rapier's combined friction clamp may have delivered less. Give the wheel the difference now, so
    // its angular momentum balances the impulse actually applied: I dw = (Td - Tb) dt - R J_delivered.
    for (let i = 0; i < WHEELS.length; i++) {
      const t = this.tyre[i];
      const j = this.vehicle.wheelForwardImpulse(i) ?? 0;
      // Mass Rapier's side constraint acts on at this wheel (side impulse per unit sideways speed at
      // full stiffness), for sizing the next step's sliding side force.
      t.sideImpulse = this.vehicle.wheelSideImpulse(i) ?? 0;
      // Simulation (EM #20938): learn only from an unclamped contact. If Rapier delivered materially less
      // forward impulse than was sent, or the wheel is at its combined limit, the side impulse is a
      // clamped value, not the constraint's response; keep the last reliable estimate.
      const sent = t.fx * dt, clampedFwd = Math.abs(j - sent) > 0.1 * Math.max(Math.abs(sent), 0.5);
      const atLimit = TYRE_BUDGET !== null && Math.hypot(j, t.sideImpulse) >= 0.97 * TYRE_BUDGET * t.fz * dt;
      t.mEffUpdated = t.sideStiffness > 0.05 && Math.abs(t.vLat) > 0.2 && t.fz > 0 && (TYRE_BUDGET === null || (!clampedFwd && !atLimit));
      if (t.mEffUpdated) {
        const m = Math.abs(t.sideImpulse) / (t.sideStiffness * Math.abs(t.vLat));
        if (Number.isFinite(m)) t.mEff += (THREE.MathUtils.clamp(m, 20, 2000) - t.mEff) * 0.3;
      }
      t.delivered = j / dt;
      t.omega += (WHEEL_RADIUS * (t.fxSolve * dt - j)) / WHEEL_INERTIA;
      t.balance = WHEEL_INERTIA * (t.omega - this.prevOmega[i]) - (t.torque * dt - WHEEL_RADIUS * j);
      // Publish the state of the reconciled spin (EM #20782): slip and the drawn wheel angle follow
      // the final omega, against the same rolling speed the step used.
      t.slip = (t.omega * WHEEL_RADIUS - t.vc) / t.den;
      t.slide = Math.abs(t.omega * WHEEL_RADIUS - t.vc); // m/s the tread rubs over the road (smoke, screech)
      t.angle = (t.angle + t.omega * dt) % (Math.PI * 2);
    }
  }
  private prevOmega = WHEELS.map(() => 0);

  // Wheel spin, slip and tyre force for each wheel, from drive and brake torque and the road's grip.
  // Rapier stays the one place tyre forces are applied: the force goes in as the wheel's
  // engine force (no Rapier brake), and sliding lowers the wheel's side grip.
  private updateTyres(dt: number, engine: number, brake: number) {
    const q = this.body.rotation();
    const rot = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    for (let i = 0; i < WHEELS.length; i++) {
      const w = WHEELS[i], t = this.tyre[i];
      const steer = w.front ? this.steer : 0;
      this.vehicle.setWheelSteering(i, steer);
      // Rolling speed of the road under the tyre, along the wheel's heading.
      const contact = this.vehicle.wheelContactPoint(i);
      const inContact = this.vehicle.wheelIsInContact(i) && contact;
      const fwd = new THREE.Vector3(Math.sin(steer), 0, Math.cos(steer)).applyQuaternion(rot);
      const axle = new THREE.Vector3(Math.cos(steer), 0, -Math.sin(steer)).applyQuaternion(rot); // wheel's sideways axis (+ left)
      let vc = 0, vLat = 0;
      if (inContact) {
        // Velocity of the chassis at the contact point (about its true centre of mass, which sits
        // COM_Y below the body origin), along the wheel's heading and sideways.
        const pv = this.body.velocityAtPoint(contact);
        vc = pv.x * fwd.x + pv.y * fwd.y + pv.z * fwd.z;
        vLat = pv.x * axle.x + pv.y * axle.y + pv.z * axle.z;
      } else vc = t.omega * WHEEL_RADIUS; // in the air: no slip
      t.vLat = vLat;
      t.fz = inContact ? Math.max(0, this.vehicle.wheelSuspensionForce(i) ?? 0) : 0;
      const den = Math.max(Math.abs(vc), SLIP_V_MIN);
      const revLimit = (Math.abs(vc) / WHEEL_RADIUS) * REV_HEADROOM + REV_BASE;
      const drive = w.front ? 0 : engine * WHEEL_RADIUS * THREE.MathUtils.clamp((revLimit - Math.abs(t.omega)) / REV_FADE, 0, 1); // N m
      const brakeT = brake * (w.front ? BRAKE_FRONT : BRAKE_REAR) * WHEEL_RADIUS; // N m, opposes spin
      // Implicit step for the spin rate, with the tyre force linearised around the current slip
      // (stable at 120 Hz even near standstill, where the tyre is very stiff relative to the wheel).
      this.prevOmega[i] = t.omega;
      const I = WHEEL_INERTIA, R = WHEEL_RADIUS;
      // One implicit solve over `h` seconds from spin `om`, with drive, brake and tyre torque together.
      // Past the grip peak the curve's slope is negative; only the stiffening part goes in the implicit
      // denominator (a falling force there is what lets a wheel run away into wheelspin or a lock).
      // The brake opposes the spin and can at most stop the wheel: if it would reverse it, the wheel is
      // held at zero (locked) as long as the brake can hold it there against the drive and the road.
      const solveStep = (om: number, h: number) => {
        const k0 = (om * R - vc) / den;
        const f0 = t.fz * muX(k0), df = Math.max(0, (t.fz * muXSlope(k0) * R) / den);
        const stiff = 1 + (h * df * R) / I;
        const spinWith = (brakeSigned: number) => om + (h * (drive + brakeSigned - f0 * R)) / I / stiff;
        const dir = om > 1e-6 ? 1 : om < -1e-6 ? -1 : 0;
        let omega: number, brakeUsed: number;
        const rolling = dir !== 0 ? spinWith(-dir * brakeT) : 0;
        if (dir !== 0 && Math.sign(rolling) === dir) (omega = rolling), (brakeUsed = -dir * brakeT);
        else {
          // Try holding the wheel at zero: the brake torque that needs, with the road force of a locked tyre.
          const fLock = t.fz * muX(-vc / den);
          const hold = (-I * om) / h - drive + fLock * R;
          if (Math.abs(hold) <= brakeT) (omega = 0), (brakeUsed = hold);
          else {
            // The brake can't hold it: it turns the way the net torque pushes, with the brake against it.
            const push = Math.sign(drive - fLock * R + (I * om) / h) || 1;
            brakeUsed = -push * brakeT;
            omega = spinWith(brakeUsed);
          }
        }
        // The road force this solve implies (from the wheel's torque balance).
        return { omega, brakeUsed, f0, fRoad: (drive + brakeUsed - ((omega - om) * I) / h) / R };
      };
      // Simulation (EM #20953): the step is solved in SUBSTEPS implicit sub-steps (car velocity held for
      // the physics step), and the force sent is their average. One 1/120 s linearisation could swing
      // the slip across zero (e.g. -0.1 -> +1.0 at a standing start) with the force still pointing the
      // old way, so the contact did positive work; sub-steps let the force follow the slip through it.
      let omega: number, brakeUsed: number, fLo: number, fHi: number;
      const first = solveStep(t.omega, TYRE_BUDGET !== null ? dt / SUBSTEPS : dt);
      if (TYRE_BUDGET === null) {
        (omega = first.omega), (brakeUsed = first.brakeUsed), (fLo = fHi = first.f0);
        t.fxSolve = first.fRoad;
      } else {
        let om = first.omega, impulse = first.fRoad, braking = first.brakeUsed;
        fLo = Math.min(first.f0, t.fz * muX((om * R - vc) / den)), fHi = Math.max(first.f0, t.fz * muX((om * R - vc) / den));
        for (let n = 1; n < SUBSTEPS; n++) {
          const sub = solveStep(om, dt / SUBSTEPS);
          om = sub.omega, impulse += sub.fRoad, braking += sub.brakeUsed;
          const fEnd = t.fz * muX((om * R - vc) / den);
          fLo = Math.min(fLo, sub.f0, fEnd), fHi = Math.max(fHi, sub.f0, fEnd);
        }
        (omega = om), (brakeUsed = braking / SUBSTEPS);
        t.fxSolve = impulse / SUBSTEPS; // average road force over the step
      }
      t.torque = drive + brakeUsed;
      t.omega = omega;
      t.vc = vc; // rolling speed and slip denominator for this step, reused after reconciliation
      t.den = den;
      t.slip = (omega * WHEEL_RADIUS - vc) / den; // trial slip for the force bound below
      // The force sent to Rapier is the one the implicit solve used (re-evaluating the curve at the new
      // slip would be an explicit step again, unstable near standstill), kept between the curve's
      // values over the step: when a wheel spins up or down fast the linearised force can overshoot
      // past the curve (even pushing the wrong way). Same-step reconciliation below then gives the
      // wheel the impulse actually applied.
      const f1 = t.fz * muX(t.slip);
      t.fx = THREE.MathUtils.clamp(t.fxSolve, Math.min(fLo, f1), Math.max(fHi, f1));
      // Sliding (blending in from the slip peak to twice it): one friction force of sliding size
      // against the patch's sliding velocity. Its lengthwise part goes to Rapier as the wheel's engine
      // force; its sideways part through the wheel's side stiffness, scaled so Rapier's sideways
      // impulse (which would otherwise cancel all sideways motion) delivers just that much.
      // Simulation (EM #20938): the sliding vector and the sliding measure both come from the start-of-step
      // state (spin before the implicit solve). Mixing them with the post-solve spin fed back: the solve
      // had already pulled the spin most of the way to road speed, so the lengthwise sliding force came
      // out small, the reconciliation returned the spin, and in a sideways slide the wheel stayed
      // over-spun through a lift (S1.13 exit test).
      const sLong = (TYRE_BUDGET !== null ? this.prevOmega[i] : omega) * WHEEL_RADIUS - vc, vS = Math.hypot(sLong, vLat);
      // Combined slide (Simulation): lengthwise and sideways patch slip, dimensionless, so a tyre sliding
      // sideways is treated as sliding too (published separately; driver feedback stays lengthwise).
      const combined = Math.hypot(sLong / den, vLat / den);
      t.combinedSlide = combined;
      // Braking slip (locking) only: see SIDE_GRIP_SPINNING for driven wheelspin.
      // (Rolling forward: a throttled wheel on a car rolling back down a slope from rest isn't locking.
      // A wheel still locked just after the brake is released keeps sliding until it spins back up.)
      // Simulation applies the same continuous sliding law to positive slip too (wheelspin, or a wheel left
      // over-spinning after a lift), whatever the drive torque (EM #20892): one friction force against
      // the patch velocity inside the shared budget, so tyre behaviour doesn't switch with the throttle.
      const b = TYRE_BUDGET !== null
        ? (vS > 0.05 && vc > 1 ? THREE.MathUtils.clamp((combined - SLIP_PEAK) / SLIP_PEAK, 0, 1) : 0)
        : (vS > 0.05 && t.slip < 0 && vc > 1 ? THREE.MathUtils.clamp((-t.slip - SLIP_PEAK) / SLIP_PEAK, 0, 1) : 0);
      t.sliding = b;
      let sideStiffness = 1, fxSend = t.fx;
      // (Accessible's explicit wheelspin approximation; Simulation uses the sliding law below instead.)
      if (t.slip > 0 && TYRE_BUDGET === null) sideStiffness = 1 - (1 - SIDE_GRIP_SPINNING) * THREE.MathUtils.clamp((t.slip - SLIP_PEAK) / (3 * SLIP_PEAK), 0, 1);
      if (b > 0) {
        const fTotal = t.fz * Math.abs(muX(TYRE_BUDGET !== null ? combined : vS / den));
        fxSend = (1 - b) * t.fx + b * fTotal * (sLong / vS);
        const latWanted = fTotal * (Math.abs(vLat) / vS) * dt; // N s this step
        const latCancel = t.mEff * Math.abs(vLat); // N s Rapier's constraint would apply at full stiffness
        sideStiffness = (1 - b) + b * (latCancel > 1e-6 ? Math.min(1, latWanted / latCancel) : 1);
      }
      t.fx = fxSend;
      t.sideStiffness = sideStiffness;
      // Shared tyre-force budget (Simulation): Rapier clamps each wheel to (0.5 Fx)^2 + Fy^2 <=
      // (frictionSlip Fz)^2 and scales both parts together when it slides; with frictionSlip^2 =
      // mu^2 - 0.75 (Fx/Fz)^2 that becomes Fx^2 + Fy^2 <= (mu Fz)^2, so grip used braking or driving
      // is grip the corner no longer has.
      if (TYRE_BUDGET !== null) {
        const u = t.fz > 1 ? Math.min(TYRE_BUDGET, Math.abs(t.fx) / t.fz) : 0;
        this.vehicle.setWheelFrictionSlip(i, Math.sqrt(Math.max(0.01, TYRE_BUDGET * TYRE_BUDGET - 0.75 * u * u)));
      }
      this.vehicle.setWheelEngineForce(i, t.fx);
      this.vehicle.setWheelBrake(i, 0);
      this.vehicle.setWheelSideFrictionStiffness(i, sideStiffness);
    }
  }

  // Suspension compression per wheel: 0 = at rest length, 1 = max travel used up.
  compression(i: number) {
    const len = this.vehicle.wheelSuspensionLength(i) ?? REST_LENGTH;
    return THREE.MathUtils.clamp((REST_LENGTH - len) / 0.25, 0, 1);
  }

  // Draw the car at `alpha` (0..1) of the way from the previous physics pose to the current one,
  // so motion is smooth however many fixed steps ran this frame. Physics state is untouched.
  syncVisuals(alpha = 1) {
    const t = this.body.translation();
    const r = this.body.rotation();
    if (this.snapVisuals) {
      alpha = 1;
      this.snapVisuals = false;
    }
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(r.x, r.y, r.z, r.w);
    if (alpha < 1) {
      this.group.position.lerpVectors(this.prevPos, this.group.position, alpha);
      this.group.quaternion.slerpQuaternions(this.prevQuat, this.group.quaternion, alpha);
    }
    // Brake light follows the brake actually applied (keys, Space or autopilot, including partial).
    this.brakeLight.emissiveIntensity = this.applied.brake * 4;
    this.brakeLight.color.setRGB(0.25 + 0.75 * this.applied.brake, 0, 0);
    // Wheel angle turned since the last rendered frame, from road speed (rolling without slip).
    const now = performance.now();
    const frame = Math.min(0.1, (now - this.lastVisualSync) / 1000);
    this.lastVisualSync = now;
    for (let i = 0; i < WHEELS.length; i++) {
      const pivot = this.wheels[i];
      const conn = this.vehicle.wheelChassisConnectionPointCs(i)!;
      const len = this.vehicle.wheelSuspensionLength(i) ?? REST_LENGTH;
      pivot.position.set(conn.x, conn.y - len, conn.z);
      pivot.rotation.set(0, this.vehicle.wheelSteering(i) ?? 0, 0);
      // Rotation from the wheel's own spin (it can spin up or lock, not just roll with the road).
      pivot.children[1].rotation.x = this.tyre[i].angle;
      // Each wheel blurs from its own spin: a locked front stays sharp while the rears spin.
      const blur = THREE.MathUtils.smoothstep(Math.abs(this.tyre[i].omega) * frame, BLUR_FROM, BLUR_TO);
      const look = this.wheelLooks[i];
      look.spokeMat.opacity = 1 - blur;
      look.blurMat.opacity = 0.6 * blur;
      look.blur.visible = blur > 0;
    }
  }
}
