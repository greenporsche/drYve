import * as THREE from 'three/webgpu';
import type { Track } from './surface';

// Roller-coaster elevation view (V): a flat floor at the lap's lowest point and supports under the
// track every 50 m, coloured from blue (low) to red (high) with a darker band every 10 m of height,
// like a ruler. Visual only; the physics world is unchanged.
const SUPPORT_EVERY = 25; // m along the lap
const BAND = 10; // m of height per ruler band

export function buildCoaster(track: Track) {
  const group = new THREE.Group();
  group.visible = false;
  const pts = track.centerline.points, dist = track.centerline.distance;
  const ys = Array.from({ length: dist.length }, (_, i) => pts[i * 3 + 1]);
  const floorY = Math.min(...ys), topY = Math.max(...ys);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < dist.length; i++) {
    minX = Math.min(minX, pts[i * 3]); maxX = Math.max(maxX, pts[i * 3]);
    minZ = Math.min(minZ, pts[i * 3 + 2]); maxZ = Math.max(maxZ, pts[i * 3 + 2]);
  }

  // Floor: a large plane at the lowest point with a 50 m grid so distance and drop both read.
  const W = maxX - minX + 1200, D = maxZ - minZ + 1200;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4a5160, roughness: 1 }),
  );
  floor.position.set((minX + maxX) / 2, floorY - 0.05, (minZ + maxZ) / 2);
  floor.receiveShadow = true;
  group.add(floor);
  const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D) / 50), 0x9aa3b5, 0x6c7486);
  grid.position.set((minX + maxX) / 2, floorY, (minZ + maxZ) / 2);
  group.add(grid);

  // Supports: one column per 50 m, built from 10 m bands so the height can be counted.
  const colour = (h: number) => new THREE.Color().setHSL(0.66 * (1 - (h - floorY) / (topY - floorY)), 0.75, 0.5);
  const bandGeo = new THREE.BoxGeometry(1.4, 1, 1.4);
  const L = track.centerline.length ?? dist[dist.length - 1];
  for (let s = 0; s < L; s += SUPPORT_EVERY) {
    const i = Math.max(0, dist.findIndex((d) => d >= s));
    const x = pts[i * 3], top = pts[i * 3 + 1] - 0.3, z = pts[i * 3 + 2];
    for (let b = floorY, n = 0; b < top; b += BAND, n++) {
      const h = Math.min(BAND, top - b);
      const c = colour(b + h);
      if (n % 2) c.multiplyScalar(0.7);
      const m = new THREE.Mesh(bandGeo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
      m.scale.y = h;
      m.position.set(x, b + h / 2, z);
      m.castShadow = true;
      group.add(m);
    }
  }
  return { group, floorY, topY };
}
