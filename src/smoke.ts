import * as THREE from 'three/webgpu';
import type { Car } from './car';

// Tyre smoke from wheels sliding over the road (spinning up or locked), from the car's own wheel
// state: a puff per frame from each wheel whose tread rubs faster than SLIDE_MIN, more the faster it
// slides. Puffs drift up, grow and fade. Visual only.
const POOL = 260;
const SLIDE_MIN = 2.5; // m/s of tread sliding before it smokes
const LIFE = 1.4; // s

export class TyreSmoke {
  readonly mesh: THREE.InstancedMesh;
  private age = new Float32Array(POOL).fill(LIFE);
  private pos = new Float32Array(POOL * 3);
  private vel = new Float32Array(POOL * 3);
  private next = 0;
  private m = new THREE.Matrix4();
  private c = new THREE.Color();

  constructor() {
    this.mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.5, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }),
      POOL,
    );
    this.mesh.frustumCulled = false;
    for (let i = 0; i < POOL; i++) this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0)), this.mesh.setColorAt(i, this.c.set(0xdddddd));
  }

  update(car: Car, dt: number) {
    // Emit from sliding wheels at their contact points.
    const lv = car.body.linvel();
    car.tyre.forEach((t, i) => {
      if (t.slide < SLIDE_MIN || t.fz <= 0) return;
      const at = car.vehicle.wheelContactPoint(i);
      if (!at) return;
      const n = Math.random() < Math.min(1, (t.slide - SLIDE_MIN) / 8) ? 1 : 0; // up to one puff per wheel per frame
      for (let k = 0; k < n; k++) {
        const j = this.next++ % POOL;
        this.age[j] = 0;
        this.pos.set([at.x + (Math.random() - 0.5) * 0.3, at.y + 0.2, at.z + (Math.random() - 0.5) * 0.3], j * 3);
        // Smoke is left behind: it keeps a little of the car's motion and rises.
        this.vel.set([lv.x * 0.15 + (Math.random() - 0.5), 0.6 + Math.random() * 0.6, lv.z * 0.15 + (Math.random() - 0.5)], j * 3);
      }
    });
    // Age, drift, grow and fade (fade by shrinking towards the end and greying out).
    for (let j = 0; j < POOL; j++) {
      if (this.age[j] >= LIFE) continue;
      this.age[j] += dt;
      const life = this.age[j] / LIFE;
      for (let a = 0; a < 3; a++) this.pos[j * 3 + a] += this.vel[j * 3 + a] * dt;
      const s = life >= 1 ? 0 : 0.35 + 2.2 * life * (1 - 0.4 * life);
      this.m.makeScale(s, s, s).setPosition(this.pos[j * 3], this.pos[j * 3 + 1], this.pos[j * 3 + 2]);
      this.mesh.setMatrixAt(j, this.m);
      this.mesh.setColorAt(j, this.c.setScalar(0.92 - 0.25 * life));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
