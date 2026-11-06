import * as THREE from 'three/webgpu';

// Racing-line guide painted on the road as a trail of chevrons pointing the way to drive (PO #20688),
// coloured against the car's current speed and blended smoothly: green where you could be going
// faster, through yellow and orange, to red where the planned speed is well below yours (brake by
// then). Drawn from the same plan the autopilot follows.
//
// Character (PO #20694): bold arrows with a brighter tip and a gentle pulse of light travelling forward
// along the line. One arrow per chevron (PO #20713: no glow arrow under it), all in one mesh.
const EVERY = 4; // samples (~8 m) between chevrons
const HALF_WIDTH = 0.45; // m, half the chevron's span across the road
const LENGTH = 0.8; // m, tip to the ends of the arms, along the line
const BAND = 0.8; // m, thickness of the painted band (along the line)
const LIFT = 0.035; // m above the road, above the paint and kerbs
const AHEAD = 450; // samples (~900 m) shown ahead of the car, fading out
const BEHIND = 40; // samples (~80 m) still shown behind it, fading out, so you drive over them
const PULSE_SPACING = 120; // m between pulse crests
const PULSE_SPEED = 90; // m/s the pulse travels forward
const VERTS = 6; // per chevron: outer left, tip, right; then the same shifted back by BAND

// Speed advice (planned minus current speed, m/s) to colour: a smooth ramp, not three flat colours.
const RAMP: [number, THREE.Color][] = [
  [-8, new THREE.Color(0xff1f2d)], // red: brake hard
  [-3, new THREE.Color(0xff7a1a)], // orange: brake
  [0, new THREE.Color(0xffd21f)], // yellow: hold
  [4, new THREE.Color(0xb6f03a)], // lime
  [8, new THREE.Color(0x2bd46a)], // green: go
];
const PASSED = new THREE.Color(0x8a8e98); // arrows behind the car
function advice(d: number, out: THREE.Color) {
  if (d <= RAMP[0][0]) return out.copy(RAMP[0][1]);
  for (let i = 1; i < RAMP.length; i++) {
    if (d <= RAMP[i][0]) return out.copy(RAMP[i - 1][1]).lerp(RAMP[i][1], (d - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]));
  }
  return out.copy(RAMP[RAMP.length - 1][1]);
}

function chevronGeometry(count: number) {
  const idx: number[] = [];
  for (let c = 0; c < count; c++) {
    const o = c * VERTS; // 0 left, 1 tip, 2 right (front edge); 3 left, 4 tip, 5 right (back edge)
    idx.push(o, o + 3, o + 1, o + 1, o + 3, o + 4, o + 1, o + 4, o + 2, o + 2, o + 4, o + 5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * VERTS * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * VERTS * 4), 4)); // rgba: alpha fades them
  g.setIndex(idx);
  return g;
}

export class RacingLineGuide {
  readonly mesh: THREE.Mesh; // toggled by G
  private arrows: THREE.Mesh;
  private n: number; // line samples
  private count: number; // chevrons
  private along: Float32Array; // distance of each chevron along the line, m
  private c = new THREE.Color();

  constructor(x: Float32Array, y: Float32Array, z: Float32Array) {
    this.n = x.length;
    this.count = Math.floor(this.n / EVERY);
    this.along = new Float32Array(this.count);
    this.arrows = new THREE.Mesh(chevronGeometry(this.count), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide }));
    this.arrows.renderOrder = 3;
    this.mesh = this.arrows;
    this.setLine(x, y, z);
  }

  // Lay the chevrons along a line (called when the level, and so the planned line, changes). Each one
  // sits in the plane of the road at its sample: forward follows the line's 3D direction (so it lies
  // on slopes), across is level (the road has no camber).
  setLine(x: Float32Array, y: Float32Array, z: Float32Array) {
    const n = this.n;
    const f = new THREE.Vector3(), l = new THREE.Vector3(), p = new THREE.Vector3(), v = new THREE.Vector3();
    const corners: [number, number][] = [[-LENGTH / 2, HALF_WIDTH], [LENGTH / 2, 0], [-LENGTH / 2, -HALF_WIDTH]];
    let s = 0;
    for (let c = 0; c < this.count; c++) {
      const i = c * EVERY, a = (i - 1 + n) % n, b = (i + 1) % n;
      if (c > 0) for (let k = i - EVERY; k < i; k++) s += Math.hypot(x[k + 1] - x[k], z[k + 1] - z[k]);
      this.along[c] = s;
      f.set(x[b] - x[a], y[b] - y[a], z[b] - z[a]).normalize();
      l.set(f.z, 0, -f.x).normalize(); // left of travel
      p.set(x[i], y[i] + LIFT, z[i]);
      const arr = (this.arrows.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let k = 0; k < VERTS; k++) {
        const [al, across] = corners[k % 3];
        v.copy(p).addScaledVector(f, al - (k >= 3 ? BAND : 0)).addScaledVector(l, across);
        arr.set([v.x, v.y, v.z], (c * VERTS + k) * 3);
      }
    }
    this.arrows.geometry.getAttribute('position').needsUpdate = true;
    this.arrows.geometry.computeBoundingSphere();
  }

  // Recolour against the car's speed; `plan` is the plan's target speed per sample, `time` in s.
  update(plan: Float32Array, carSpeed: number, carIndex: number, time: number) {
    const ac = this.arrows.geometry.getAttribute('color') as THREE.BufferAttribute;
    const a = ac.array as Float32Array, c = this.c;
    const carAlong = this.along[Math.min(this.count - 1, Math.floor(carIndex / EVERY))];
    const L = this.along[this.count - 1] + 8;
    for (let ch = 0; ch < this.count; ch++) {
      const i = ch * EVERY;
      const ahead = (i - carIndex + this.n) % this.n;
      const behind = this.n - ahead; // samples behind the car, when the chevron is not ahead
      const o = ch * VERTS * 4;
      if (ahead > AHEAD && behind > BEHIND) {
        for (let v = 0; v < VERTS; v++) a[o + v * 4 + 3] = 0; // hidden
        continue;
      }
      if (ahead > AHEAD) {
        // Passed arrows (PO #20706): dim grey, no pulse, fading out over the trailing stretch.
        const fadeBehind = 1 - behind / BEHIND;
        for (let v = 0; v < VERTS; v++) a.set([PASSED.r, PASSED.g, PASSED.b, 0.6 * fadeBehind], o + v * 4);
        continue;
      }
      advice(plan[i] - carSpeed, c);
      // Pulse: a crest of light every PULSE_SPACING m, travelling forward; arrows fade out far ahead.
      const dist = (this.along[ch] - carAlong + L) % L;
      const phase = (((dist - time * PULSE_SPEED) / PULSE_SPACING) % 1 + 1) % 1;
      const pulse = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);
      const alpha = 1 - (ahead / AHEAD) ** 2;
      const k = 0.8 + 0.35 * pulse;
      for (let v = 0; v < VERTS; v++) {
        // Brighter, whiter tip: reads as a lit arrow rather than flat paint.
        const w = v % 3 === 1 ? 0.35 : 0;
        a.set([(c.r * (1 - w) + w) * k, (c.g * (1 - w) + w) * k, (c.b * (1 - w) + w) * k, 0.92 * alpha], o + v * 4);
      }
    }
    ac.needsUpdate = true;
  }
}
