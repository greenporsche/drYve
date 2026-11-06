import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Track } from './surface';

// Raised, ridged kerbs through each corner. One geometry is both drawn and added to the physics
// world as a fixed trimesh (same positions/indices, identity transform), so wheels ride up onto
// the kerb and the suspension feels the ridges.
const COLS = 7; // baked cross-section: [left shoulder, 5 road columns, right shoulder]
const WIDTH = 1.2; // m, from the road edge outward onto the shoulder
const CREST_AT = 0.45; // m from the road edge where the kerb is highest
const SUBDIV = 2; // ridges per 2 m cross-section, i.e. one every metre (finer ridges alias at 120 Hz)
const RIDGE_LOW = 0.02, RIDGE_HIGH = 0.05; // m above the surface at the crest, alternating
const EDGE_LIFT = 0.006; // m: the kerb's edges sit just above road/shoulder so it never hides
const BLOCK_SECTIONS = 1; // red/white block length in cross-sections (2 m)

export function addKerbs(scene: THREE.Object3D, world: RAPIER.World, track: Track, stations: [number, number][]) {
  const p = track.positions;
  const sections = p.length / 3 / COLS;
  const d = track.centerline.distance;
  const L = track.centerline.length ?? d[d.length - 1];
  const at = (s: number) => Math.max(0, d.findIndex((x) => x >= (((s % L) + L) % L)));
  const vert = (k: number, c: number) => {
    const i = ((((k % sections) + sections) % sections) * COLS + c) * 3;
    return new THREE.Vector3(p[i], p[i + 1], p[i + 2]);
  };

  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const red = new THREE.Color(0xd8262c), white = new THREE.Color(0xf2f2f2);

  for (const [a, b] of stations) {
    const k0 = at(a);
    let k1 = at(b);
    if (k1 < k0) k1 += sections;
    for (const [edgeCol, outCol] of [[1, 0], [COLS - 2, COLS - 1]]) {
      // Rows of 3 points across the kerb (road edge, crest, outer edge) at each sub-step along it.
      const rows: THREE.Vector3[][] = [];
      for (let k = k0; k < k1; k++) {
        for (let j = 0; j < SUBDIV; j++) {
          const t = j / SUBDIV;
          const e = vert(k, edgeCol).lerp(vert(k + 1, edgeCol), t);
          const o = vert(k, outCol).lerp(vert(k + 1, outCol), t);
          const w = Math.hypot(o.x - e.x, o.z - e.z);
          const across = (m: number) => e.clone().lerp(o, Math.min(1, m / w));
          const ridge = j % 2 === 0 ? RIDGE_HIGH : RIDGE_LOW;
          rows.push([
            across(-0.02).add(new THREE.Vector3(0, EDGE_LIFT, 0)),
            across(CREST_AT).add(new THREE.Vector3(0, ridge, 0)),
            across(WIDTH).add(new THREE.Vector3(0, EDGE_LIFT, 0)),
          ]);
        }
      }
      // Quads between consecutive rows, coloured in 2 m blocks, wound to face up.
      for (let r = 0; r + 1 < rows.length; r++) {
        const block = Math.floor(r / (SUBDIV * BLOCK_SECTIONS)) % 2 ? red : white;
        for (let c = 0; c < 2; c++) {
          const quad = [rows[r][c], rows[r][c + 1], rows[r + 1][c], rows[r + 1][c + 1]];
          const base = pos.length / 3;
          for (const v of quad) {
            pos.push(v.x, v.y, v.z);
            col.push(block.r, block.g, block.b);
          }
          const up = new THREE.Vector3().crossVectors(quad[1].clone().sub(quad[0]), quad[3].clone().sub(quad[0])).y > 0;
          idx.push(...(up ? [base, base + 1, base + 3, base, base + 3, base + 2] : [base, base + 3, base + 1, base, base + 2, base + 3]));
        }
      }
    }
  }

  const positions = new Float32Array(pos), indices = new Uint32Array(idx);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, flatShading: true }));
  mesh.receiveShadow = true;
  scene.add(mesh);
  const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(1.0));
  return { positions, indices, handle: collider.handle };
}
