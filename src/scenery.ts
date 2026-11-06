import * as THREE from 'three/webgpu';

// Trees and buildings around the lap (scenery stage 3), from public/data/<circuit>-scenery.json
// (scripts/bake-scenery.ts: heights from the SPW LiDAR surface minus ground model; footprints from
// OpenStreetMap). Two visual layers, each one draw: an instanced low-poly tree and one merged mesh of
// extruded buildings. Visual only; nothing here has a collider.
export interface SceneryData {
  meta: { sources: Record<string, string> };
  trees: number[]; // [x, groundY, z, height] per tree
  buildings: { ring: number[]; base: number; height: number; kind: string }[];
}

const JITTER = 3.5; // m: trees sit on a 10 m grid; nudge each off it so forests don't look planted
const SINK = 0.4; // m: trunks start a little below the ground so slopes don't show a gap

// Deterministic pseudo-random in [0, 1) from an integer (same scenery every load).
const rand = (i: number, salt: number) => {
  const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

// A unit tree, 1 m tall: short trunk and a two-tier conifer-ish crown, coloured per vertex.
function treeGeometry() {
  const parts: [THREE.BufferGeometry, number][] = [
    [new THREE.CylinderGeometry(0.035, 0.05, 0.25, 5).translate(0, 0.125, 0), 0x5a4330],
    [new THREE.ConeGeometry(0.32, 0.55, 7).translate(0, 0.45, 0), 0x2f5a2a],
    [new THREE.ConeGeometry(0.24, 0.45, 7).translate(0, 0.75, 0), 0x3a6a30],
  ];
  const pos: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  for (const [g, hex] of parts) {
    const p = g.toNonIndexed().getAttribute('position');
    c.set(hex);
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i)), col.push(c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildTrees(data: SceneryData) {
  const t = data.trees, count = t.length / 4;
  const mesh = new THREE.InstancedMesh(treeGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const h = t[i * 4 + 3];
    const crown = THREE.MathUtils.clamp(h * 0.42, 2.2, 7); // crown diameter scale, m per unit width
    p.set(t[i * 4] + (rand(i, 1) - 0.5) * 2 * JITTER, t[i * 4 + 1] - SINK, t[i * 4 + 2] + (rand(i, 2) - 0.5) * 2 * JITTER);
    q.setFromAxisAngle(up, rand(i, 3) * Math.PI * 2);
    s.set(crown * (0.85 + 0.3 * rand(i, 4)), h + SINK, crown * (0.85 + 0.3 * rand(i, 5)));
    mesh.setMatrixAt(i, m.compose(p, q, s));
    // Slight per-tree colour variation (darker conifers, lighter broadleaf greens).
    tint.setHSL(0.27 + 0.06 * rand(i, 6), 0.35 + 0.25 * rand(i, 7), 0.75 + 0.35 * rand(i, 8));
    mesh.setColorAt(i, tint);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.computeBoundingSphere();
  return mesh;
}

// Buildings: walls extruded from each footprint from its base to base + height, plus a flat roof.
export function buildBuildings(data: SceneryData) {
  const pos: number[] = [], col: number[] = [];
  const wall = new THREE.Color(), roof = new THREE.Color();
  data.buildings.forEach((b, bi) => {
    const ring: THREE.Vector2[] = [];
    for (let i = 0; i < b.ring.length; i += 2) ring.push(new THREE.Vector2(b.ring[i], b.ring[i + 1]));
    if (ring.length < 3) return;
    if (THREE.ShapeUtils.isClockWise(ring)) ring.reverse();
    const y0 = b.base - 0.5, y1 = b.base + b.height;
    wall.setHSL(0.08 + 0.05 * rand(bi, 1), 0.12, 0.72 + 0.12 * rand(bi, 2));
    roof.setHSL(0.02 + 0.04 * rand(bi, 3), 0.25, 0.32 + 0.12 * rand(bi, 4));
    const push = (x: number, y: number, z: number, c: THREE.Color) => (pos.push(x, y, z), col.push(c.r, c.g, c.b));
    // Footprint coordinates are (x, z); counter-clockwise in (x, z) means clockwise seen from above
    // (+Y up, Z south), so wind the wall quads accordingly to face outward.
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      push(a.x, y0, a.y, wall); push(a.x, y1, a.y, wall); push(c.x, y0, c.y, wall);
      push(c.x, y0, c.y, wall); push(a.x, y1, a.y, wall); push(c.x, y1, c.y, wall);
    }
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(ring, [])) {
      push(ring[i].x, y1, ring[i].y, roof); push(ring[k].x, y1, ring[k].y, roof); push(ring[j].x, y1, ring[j].y, roof);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  // Winding varies with footprint orientation; draw both sides rather than risk inside-out walls.
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, flatShading: true }));
}
