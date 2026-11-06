import * as THREE from 'three/webgpu';
import type { Track } from './surface';
import { CONTROL_LINE, ROAD_WIDTH, SECTOR_LINES, START_LINE } from './circuit';

const LIFT = 0.03; // m above the road so markings don't z-fight with it
export const GRID_SLOTS = 20;
const GRID_FIRST = 6; // m from the start line back to the pole slot's front bar
const GRID_PITCH = 8; // m between consecutive (staggered) slots
const GRID_SIDE = 2.6; // m either side of the centreline

// A point on the road at a station, with the heading of the track there. The returned frame
// matches the car's chassis: local +Z forward along the track, local +X to the left.
export function roadFrame(track: Track, station: number) {
  const d = track.centerline.distance, p = track.centerline.points;
  let i = d.findIndex((x) => x >= station);
  if (i < 1) i = 1;
  const t = (station - d[i - 1]) / (d[i] - d[i - 1]);
  const a = new THREE.Vector3(p[i * 3 - 3], p[i * 3 - 2], p[i * 3 - 1]);
  const b = new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  return { pos: a.clone().lerp(b, t), yaw: Math.atan2(b.x - a.x, b.z - a.z) };
}

// Grid slot k (0 = pole, on the right), staggered behind the start line.
const slotSide = (k: number) => (k % 2 === 0 ? -1 : 1); // +X is left of travel, so -1 = right
export function gridSlot(track: Track, slot: number) {
  const f = roadFrame(track, START_LINE - GRID_FIRST - slot * GRID_PITCH - 2.5);
  const side = slotSide(slot);
  f.pos.add(new THREE.Vector3(Math.cos(f.yaw) * side * GRID_SIDE, 0, -Math.sin(f.yaw) * side * GRID_SIDE));
  return f;
}

function placed(track: Track, station: number, mesh: THREE.Object3D) {
  const f = roadFrame(track, station);
  const g = new THREE.Group();
  g.position.copy(f.pos).add(new THREE.Vector3(0, LIFT, 0));
  g.rotation.y = f.yaw;
  g.add(mesh);
  return g;
}

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 24 * 8;
  c.height = 2 * 8;
  const ctx = c.getContext('2d')!;
  for (let x = 0; x < 24; x++)
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      ctx.fillRect(x * 8, y * 8, 8, 8);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Start/finish line, grid boxes and sector stripes painted on the road.
export function addStartFinish(scene: THREE.Object3D, track: Track) {
  const flat = (w: number, l: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), mat);
    m.receiveShadow = true;
    return m;
  };

  // Chequered control (timing/finish) line, 1 m deep across the full road width, and the separate
  // white start line the grid forms up behind.
  scene.add(placed(track, CONTROL_LINE, flat(ROAD_WIDTH, 1, new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.8 }))));
  scene.add(placed(track, START_LINE, flat(ROAD_WIDTH, 0.5, new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.8 }))));

  // Grid boxes: an open "U" facing the line for each slot, staggered left/right.
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.8 });
  for (let k = 0; k < GRID_SLOTS; k++) {
    const front = START_LINE - GRID_FIRST - k * GRID_PITCH;
    const box = new THREE.Group();
    const side = slotSide(k);
    box.position.x = side * GRID_SIDE;
    const bar = flat(2.4, 0.2, white);
    box.add(bar);
    for (const sx of [-1.1, 1.1]) {
      const leg = flat(0.2, 1.4, white);
      leg.position.set(sx, 0, -0.6);
      box.add(leg);
    }
    scene.add(placed(track, front, box));
  }

  // Sector lines: thin stripes across the road where the sector times split.
  const sectorMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.8 });
  for (const s of SECTOR_LINES.slice(1)) scene.add(placed(track, s, flat(ROAD_WIDTH, 0.4, sectorMat)));
}
