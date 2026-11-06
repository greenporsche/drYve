import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';

export interface Track {
  meta: {
    name: string;
    localOrigin: { height: number };
    elevationSource: { attribution: string; license: string };
    crossSlope: string;
  };
  positions: Float32Array;
  indices: Uint32Array;
  groups: { name: string; start: number; count: number }[];
  // Closed loops also carry the lap length, including the closing step back to the first point.
  // halfWidth: per-sample road half-widths [left, right of travel] where the circuit has local width
  // corrections (otherwise the road is ROAD_WIDTH / 2 each side).
  centerline: { points: Float32Array; distance: number[]; closed?: boolean; length?: number; halfWidth?: number[] };
}

export async function loadTrack(url: string): Promise<Track> {
  const raw = await (await fetch(url)).json();
  return {
    ...raw,
    positions: new Float32Array(raw.positions),
    indices: new Uint32Array(raw.indices),
    centerline: raw.centerline ? { ...raw.centerline, points: new Float32Array(raw.centerline.points) } : undefined,
  };
}

// One positions/indices pair feeds BOTH the render mesh and the static
// Rapier trimesh, at the same identity transform (LAD geometry contract).
export function addSurface(
  scene: THREE.Object3D,
  world: RAPIER.World,
  positions: Float32Array,
  indices: Uint32Array,
  materials: THREE.Material | THREE.Material[],
  groups: { start: number; count: number }[] = [],
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.receiveShadow = true;
  scene.add(mesh);

  const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(1.0));
  mesh.userData.colliderHandle = collider.handle; // for contact diagnostics
  return mesh;
}

// Flat square ground (used before the baked track existed; kept for quick physics checks).
export function flatGround(halfSize: number): { positions: Float32Array; indices: Uint32Array } {
  const s = halfSize;
  return {
    positions: new Float32Array([-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s]),
    // CCW seen from +Y so normals point up.
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}

// Baked cross-section layout: [left shoulder, 5 road columns, right shoulder].
const COLS = 7;

// Painted road edges, corner kerbs and marker posts every 25 m so speed and slope read visually.
// Visual only: thin strips laid just above the baked surface, never part of the collider.
const EDGE_LINE = { from: 0.15, to: 0.45 }; // m inward from the road edge
const KERB_WIDTH = 1.2; // m outward from the road edge, onto the shoulder
const KERB_BLOCK = 2; // m per red or white block (one cross-section)
const LIFT = 0.025;

export function addRoadMarkings(scene: THREE.Object3D, track: Track, kerbStations: [number, number][] = []) {
  const p = track.positions;
  const sections = p.length / 3 / COLS;
  const closed = !!track.centerline.closed;
  const vert = (k: number, c: number) => new THREE.Vector3(p[(k * COLS + c) * 3], p[(k * COLS + c) * 3 + 1], p[(k * COLS + c) * 3 + 2]);
  // A point `d` metres from the road-edge vertex toward `towardCol` in section k (follows that column's height).
  const along = (k: number, edgeCol: number, towardCol: number, d: number) => {
    const e = vert(k, edgeCol), t = vert(k, towardCol);
    const len = Math.hypot(t.x - e.x, t.z - e.z);
    return e.lerp(t, Math.min(1, d / len)).add(new THREE.Vector3(0, LIFT, 0));
  };

  // One quad strip per run of sections, between two lateral offsets; optional per-quad colours.
  function strip(runs: [number, number][], edgeCol: number, inCol: number, a: number, b: number, colours?: (k: number) => THREE.Color) {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    for (const [k0, k1] of runs) {
      for (let k = k0; k < k1; k++) {
        const ka = ((k % sections) + sections) % sections, kb = (((k + 1) % sections) + sections) % sections;
        if (!closed && k + 1 >= sections) break;
        const base = pos.length / 3;
        for (const kk of [ka, kb]) for (const d of [a, b]) pos.push(...along(kk, edgeCol, inCol, d).toArray());
        const c = colours?.(k) ?? new THREE.Color(0xffffff);
        for (let i = 0; i < 4; i++) col.push(c.r, c.g, c.b);
        // Wind each quad counter-clockwise seen from above, so its front face (and normal) is up on
        // both sides of the road; a back face would be lit as if facing down and look black.
        const P = (i: number) => new THREE.Vector3(pos[(base + i) * 3], pos[(base + i) * 3 + 1], pos[(base + i) * 3 + 2]);
        const up = new THREE.Vector3().crossVectors(P(1).sub(P(0)), P(3).sub(P(0))).y > 0;
        idx.push(...(up ? [base, base + 1, base + 3, base, base + 3, base + 2] : [base, base + 3, base + 1, base, base + 2, base + 3]));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals(); // every quad is wound to face up, so these point up on both sides
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
    m.receiveShadow = true;
    scene.add(m);
  }

  // White lines just inside both road edges, the whole way round.
  const all: [number, number][] = [[0, closed ? sections : sections - 1]];
  strip(all, 1, 3, EDGE_LINE.from, EDGE_LINE.to);
  strip(all, COLS - 2, 3, EDGE_LINE.from, EDGE_LINE.to);

  // Red/white kerbs on both sides through each corner, from the edge out onto the shoulder.
  if (kerbStations.length) {
    const d = track.centerline.distance;
    const idxAt = (s: number) => {
      const L = track.centerline.length ?? d[d.length - 1];
      const w = ((s % L) + L) % L;
      return Math.max(0, d.findIndex((x) => x >= w));
    };
    const runs = kerbStations.map(([a, b]) => {
      const i0 = idxAt(a), i1 = idxAt(b);
      return [i0, i1 >= i0 ? i1 : i1 + sections] as [number, number];
    });
    const red = new THREE.Color(0xd8262c), white = new THREE.Color(0xf2f2f2);
    const blocks = (k: number) => (Math.floor(k / (KERB_BLOCK / 2)) % 2 ? red : white);
    strip(runs, 1, 0, -0.02, KERB_WIDTH, blocks);
    strip(runs, COLS - 2, COLS - 1, -0.02, KERB_WIDTH, blocks);
  }
}

// Spawn on the centerline at index i, facing along the track (chassis +Z forward).
export function spawnAt(track: Track, i: number) {
  const c = track.centerline.points;
  const a = new THREE.Vector3(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);
  const b = new THREE.Vector3(c[i * 3 + 3], c[i * 3 + 4], c[i * 3 + 5]);
  return { pos: a.clone().add(new THREE.Vector3(0, 1.0, 0)), yaw: Math.atan2(b.x - a.x, b.z - a.z) };
}
