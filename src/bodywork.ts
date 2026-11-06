import * as THREE from 'three/webgpu';

// Visible single-seater shell. Purely visual: the physics chassis stays the cuboid collider in
// car.ts. Car-local axes: +Z forward, +X left, +Y up; origin at the chassis centre.
// Front axle at z = +1.7, rear at z = -1.6, wheels 0.95 m either side.
export function buildBodywork(): { shell: THREE.Group; brakeLight: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.35, metalness: 0.2 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.6, metalness: 0.3 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.3 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  // A tube along Z, wider than tall, tapering from radius r0 (back) to r1 (front).
  const taper = (r0: number, r1: number, len: number, squash = 0.6) =>
    new THREE.CylinderGeometry(r1, r0, len, 20).rotateX(Math.PI / 2).scale(1, squash, 1);

  // Floor and plank, under everything.
  add(new THREE.BoxGeometry(1.4, 0.03, 3.4), carbon, 0, -0.23, -0.1);
  // Survival cell around the cockpit, and the nose tapering forward to the front wing.
  add(taper(0.38, 0.32, 1.6), red, 0, 0.0, 0.55);
  add(taper(0.32, 0.07, 1.6, 0.55), red, 0, -0.04, 2.15);
  // Front wing: main plane, flap and endplates.
  add(new THREE.BoxGeometry(1.95, 0.035, 0.42), carbon, 0, -0.2, 2.75);
  add(new THREE.BoxGeometry(1.75, 0.03, 0.22), white, 0, -0.14, 2.62, -0.25);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.03, 0.2, 0.5), red, s * 0.98, -0.12, 2.72);
  // Sidepods either side of the cockpit, tapering toward the rear.
  for (const s of [-1, 1]) {
    add(taper(0.16, 0.24, 1.5, 1.4), red, s * 0.55, -0.03, -0.15);
    add(new THREE.BoxGeometry(0.34, 0.26, 0.06), carbon, s * 0.55, -0.02, 0.6); // inlet
  }
  // Engine cover from behind the driver down to the gearbox, with the airbox above the driver.
  add(taper(0.12, 0.34, 1.9), red, 0, 0.08, -1.1);
  add(new THREE.BoxGeometry(0.26, 0.32, 0.4), red, 0, 0.38, -0.25);
  add(new THREE.BoxGeometry(0.03, 0.3, 1.1), white, 0, 0.25, -1.0); // shark fin
  // Cockpit opening, driver's helmet and the halo.
  add(new THREE.BoxGeometry(0.42, 0.06, 0.75), carbon, 0, 0.2, 0.3);
  add(new THREE.SphereGeometry(0.13, 20, 14), yellow, 0, 0.32, 0.12);
  const halo = add(new THREE.TorusGeometry(0.3, 0.025, 8, 24, Math.PI), carbon, 0, 0.38, 0.2, -Math.PI / 2, 0, 0);
  halo.scale.set(1, 1.4, 1);
  add(new THREE.BoxGeometry(0.04, 0.2, 0.04), carbon, 0, 0.3, 0.6); // halo centre pillar
  // Rear wing: main plane, upper flap, endplates and a pylon to the gearbox.
  add(new THREE.BoxGeometry(1.0, 0.04, 0.32), carbon, 0, 0.55, -2.25);
  add(new THREE.BoxGeometry(1.0, 0.03, 0.2), white, 0, 0.66, -2.32, 0.35);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.03, 0.45, 0.6), red, s * 0.51, 0.45, -2.25);
  add(new THREE.BoxGeometry(0.05, 0.4, 0.12), carbon, 0, 0.3, -2.1);
  // Suspension arms from the tub to each wheel.
  for (const [z, s] of [[1.7, 1], [1.7, -1], [-1.6, 1], [-1.6, -1]] as const) {
    add(new THREE.BoxGeometry(0.75, 0.025, 0.04), carbon, s * 0.55, -0.05, z + 0.08, 0, 0, s * 0.12);
    add(new THREE.BoxGeometry(0.75, 0.025, 0.04), carbon, s * 0.55, -0.15, z - 0.08, 0, 0, -s * 0.05);
  }
  // Rear rain/brake light at the back of the crash structure, under the rear wing.
  const brakeLight = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a1a, emissiveIntensity: 0 });
  add(new THREE.BoxGeometry(0.22, 0.09, 0.04), brakeLight, 0, 0.12, -2.24);
  return { shell: g, brakeLight };
}
