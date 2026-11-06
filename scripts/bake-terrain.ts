// Offline bake of the ground around the Spa lap (scenery stage 1). Run after `bun scripts/bake.ts lap`:
//   bun scripts/bake-terrain.ts   -> public/data/spa-terrain.json
//
// One conforming terrain mesh in the lap's local frame (X east, Y up, Z south, metres, same origin):
// a constrained Delaunay triangulation of
//   - the lap ribbon's two outer shoulder edges (its exact vertices, as constraint loops), and
//   - a 10 m grid of true ground heights over the circuit extent plus 300 m, minus grid points on or
//     within 3 m of the ribbon,
// keeping the faces outside the ribbon (the infield and everything beyond). The terrain therefore
// shares the ribbon's edge vertices: no gap, step or overlap where a car leaves the road.
// Heights: the same SPW MNT 2021-2022 0.5 m DTM cells as the road (MapServer identify, cached in
// data/raw/), nearest cell per grid point.
import { existsSync } from "node:fs";
import cdt2d from "cdt2d";
import { rlpRaster } from "./lib/rlp";

// Circuit: `bun scripts/bake-terrain.ts [spa|nurburgring-gp]` (Spa by default).
const CIRCUIT = process.argv[2] ?? "spa";
const LAP = `public/data/${CIRCUIT}-lap.json`;
const OUT = `public/data/${CIRCUIT}-terrain.json`;
const CELL = 0.5;
const COLS = 7; // ribbon cross-section: [left shoulder, 5 road columns, right shoulder]
const GRID_STEP = 10, GRID_MARGIN = 300, CLEAR = 3; // m

const lap = JSON.parse(await Bun.file(LAP).text());
const meta = lap.meta;
const o = meta.localOrigin;
const service: string = meta.elevationSource.service;
const pos: number[] = lap.positions;
const cl: number[] = lap.centerline.points;
const N = cl.length / 3;
if (pos.length / 3 / COLS !== N) throw new Error("ribbon and centerline section counts differ");

// ---------- DTM cells (shared cache with the road bake) ----------
const cachePath = "data/raw/mnt-2021-2022-cells.json";
const cells: Record<string, number> = existsSync(cachePath) ? JSON.parse(await Bun.file(cachePath).text()) : {};
const keyOf = (x: number, z: number) => `${Math.floor((x + o.easting) / CELL)},${Math.floor((-z + o.northing) / CELL)}`;
async function identify(k: string): Promise<number> {
  const [i, j] = k.split(",").map(Number);
  const cx = (i + 0.5) * CELL, cy = (j + 0.5) * CELL;
  const ext = [cx - 1.5 * CELL, cy - 1.5 * CELL, cx + 1.5 * CELL, cy + 1.5 * CELL].join(",");
  const url = `${service}/identify?geometry=${cx},${cy}&geometryType=esriGeometryPoint&sr=3812&layers=all:0` +
    `&tolerance=0&mapExtent=${ext}&imageDisplay=3,3,96&returnGeometry=false&f=json`;
  for (let attempt = 0; ; attempt++) {
    try {
      const r: any = await (await fetch(url)).json();
      return parseFloat(r.results[0].attributes["Stretch.Pixel Value"]);
    } catch (e) {
      if (attempt >= 3) throw e;
      await Bun.sleep(500 * (attempt + 1));
    }
  }
}
async function fill(keys: string[]) {
  const todo = [...new Set(keys)].filter((k) => !(k in cells));
  console.log(`DTM: ${todo.length} cells to fetch (${Object.keys(cells).length} cached)`);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const k = todo[next++];
      cells[k] = await identify(k);
      if (++done % 1000 === 0) (console.log(`  ${done}/${todo.length}`), await Bun.write(cachePath, JSON.stringify(cells)));
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  await Bun.write(cachePath, JSON.stringify(cells));
}
let height = (x: number, z: number) => cells[keyOf(x, z)] - o.height;
const RLP = meta.sourceCrs === "EPSG:25832"; // Rhineland-Palatinate DGM1 tiles (scripts/lib/rlp.ts)

// ---------- ribbon outer edges (constraint loops) ----------
const vert = (k: number, c: number): [number, number, number] => [pos[(k * COLS + c) * 3], pos[(k * COLS + c) * 3 + 1], pos[(k * COLS + c) * 3 + 2]];
const edgeL = Array.from({ length: N }, (_, k) => vert(k, 0));
const edgeR = Array.from({ length: N }, (_, k) => vert(k, COLS - 1));

// The triangulation needs non-crossing constraint loops. On the inside of the tightest hairpin the
// narrowed shoulder edge folds over itself; cut each fold out at its crossing point so the ground
// follows the outer envelope (the ribbon itself, which covers the fold, is unchanged).
type P3 = [number, number, number];
function crossAt(a: P3, b: P3, c: P3, d: P3): P3 | null {
  const r = [b[0] - a[0], b[2] - a[2]], q = [d[0] - c[0], d[2] - c[2]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * q[1] - (c[2] - a[2]) * q[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[2] - a[2]) * r[0]) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return [a[0] + t * r[0], a[1] + t * (b[1] - a[1]), a[2] + t * r[1]];
}
const foldBoxes: [number, number, number, number][] = []; // minX, minZ, maxX, maxZ of each cut fold
function unfold(loop: P3[]): { pts: P3[]; folds: number } {
  let pts = loop.slice(), folds = 0;
  for (let changed = true; changed; ) {
    changed = false;
    const n = pts.length;
    outer: for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < Math.min(n, i + 60); j++) {
        if ((j + 1) % n === i) continue;
        const x = crossAt(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]);
        if (!x) continue;
        // Keep ...i, X, j+1... (drop the folded vertices i+1..j).
        const cut = pts.slice(i, j + 2);
        foldBoxes.push([Math.min(...cut.map((p) => p[0])) - 3, Math.min(...cut.map((p) => p[2])) - 3, Math.max(...cut.map((p) => p[0])) + 3, Math.max(...cut.map((p) => p[2])) + 3]);
        pts = [...pts.slice(0, i + 1), x, ...pts.slice(j + 1)];
        folds++;
        changed = true;
        break outer;
      }
    }
  }
  return { pts, folds };
}
const loopL = unfold(edgeL), loopR = unfold(edgeR);
console.log(`unfolded ${loopL.folds} + ${loopR.folds} self-crossings in the ribbon edge loops`);

// Is (x, z) inside the ribbon or within CLEAR m of it? Test against ribbon quads (bucketed).
const B = 20;
const quadBuckets = new Map<string, number[]>();
for (let k = 0; k < N; k++) {
  const ps = [edgeL[k], edgeR[k], edgeL[(k + 1) % N], edgeR[(k + 1) % N]];
  const xs = ps.map((p) => p[0]), zs = ps.map((p) => p[2]);
  for (let bx = Math.floor((Math.min(...xs) - CLEAR) / B); bx <= Math.floor((Math.max(...xs) + CLEAR) / B); bx++)
    for (let bz = Math.floor((Math.min(...zs) - CLEAR) / B); bz <= Math.floor((Math.max(...zs) + CLEAR) / B); bz++) {
      const key = `${bx},${bz}`;
      if (!quadBuckets.has(key)) quadBuckets.set(key, []);
      quadBuckets.get(key)!.push(k);
    }
}
const segDist = (x: number, z: number, a: number[], b: number[]) => {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a[0] - t * dx, z - a[2] - t * dz);
};
const inTri = (x: number, z: number, a: number[], b: number[], c: number[]) => {
  const s1 = (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0]);
  const s2 = (c[0] - b[0]) * (z - b[2]) - (c[2] - b[2]) * (x - b[0]);
  const s3 = (a[0] - c[0]) * (z - c[2]) - (a[2] - c[2]) * (x - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};
function nearRibbon(x: number, z: number) {
  for (const k of quadBuckets.get(`${Math.floor(x / B)},${Math.floor(z / B)}`) ?? []) {
    const a = edgeL[k], b = edgeR[k], c = edgeR[(k + 1) % N], d = edgeL[(k + 1) % N];
    if (inTri(x, z, a, b, c) || inTri(x, z, a, c, d)) return true;
    if (Math.min(segDist(x, z, a, d), segDist(x, z, b, c)) < CLEAR) return true;
  }
  return false;
}

// ---------- grid of true ground ----------
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let k = 0; k < N; k++) {
  minX = Math.min(minX, cl[k * 3]); maxX = Math.max(maxX, cl[k * 3]);
  minZ = Math.min(minZ, cl[k * 3 + 2]); maxZ = Math.max(maxZ, cl[k * 3 + 2]);
}
const gx0 = Math.floor((minX - GRID_MARGIN) / GRID_STEP) * GRID_STEP, gz0 = Math.floor((minZ - GRID_MARGIN) / GRID_STEP) * GRID_STEP;
const GW = Math.ceil((maxX + GRID_MARGIN - gx0) / GRID_STEP) + 1, GH = Math.ceil((maxZ + GRID_MARGIN - gz0) / GRID_STEP) + 1;
const gridPts: [number, number][] = [];
let dropped = 0;
for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
  const x = gx0 + i * GRID_STEP, z = gz0 + j * GRID_STEP;
  const boundary = i === 0 || j === 0 || i === GW - 1 || j === GH - 1;
  if (!boundary && nearRibbon(x, z)) dropped++;
  else gridPts.push([x, z]);
}
if (RLP) {
  const xs = gridPts.map((p) => p[0]), zs = gridPts.map((p) => p[1]);
  const r = await rlpRaster("dgm1", o.easting + Math.min(...xs) - 2, o.northing - Math.max(...zs) - 2, o.easting + Math.max(...xs) + 2, o.northing - Math.min(...zs) + 2);
  height = (x, z) => r.sample(x + o.easting, o.northing - z) - o.height;
} else await fill(gridPts.map(([x, z]) => keyOf(x, z)));

// ---------- constrained Delaunay triangulation ----------
// Points: ribbon left edge, ribbon right edge, then grid points. Constraints: both ribbon edge loops
// and the grid's outer boundary loop. All faces are triangulated; the ones inside the ribbon (which
// the constraint loops bound exactly) are then removed by a centroid test.
const pts2: [number, number][] = [];
const heights: number[] = [];
for (const e of [...loopL.pts, ...loopR.pts]) (pts2.push([e[0], e[2]]), heights.push(e[1]));
const NL = loopL.pts.length, NR = loopR.pts.length;
const gridIndex = new Map<string, number>();
for (const [x, z] of gridPts) {
  gridIndex.set(`${x},${z}`, pts2.length);
  pts2.push([x, z]);
  heights.push(height(x, z));
}
const edges: [number, number][] = [];
for (let k = 0; k < NL; k++) edges.push([k, (k + 1) % NL]);
for (let k = 0; k < NR; k++) edges.push([NL + k, NL + ((k + 1) % NR)]);
const boundary: number[] = [];
for (let i = 0; i < GW; i++) boundary.push(gridIndex.get(`${gx0 + i * GRID_STEP},${gz0}`)!);
for (let j = 1; j < GH; j++) boundary.push(gridIndex.get(`${gx0 + (GW - 1) * GRID_STEP},${gz0 + j * GRID_STEP}`)!);
for (let i = GW - 2; i >= 0; i--) boundary.push(gridIndex.get(`${gx0 + i * GRID_STEP},${gz0 + (GH - 1) * GRID_STEP}`)!);
for (let j = GH - 2; j >= 1; j--) boundary.push(gridIndex.get(`${gx0},${gz0 + j * GRID_STEP}`)!);
for (let b = 0; b < boundary.length; b++) edges.push([boundary[b], boundary[(b + 1) % boundary.length]]);
console.log(`triangulating ${pts2.length} points with ${edges.length} constraint edges (${dropped} grid points cleared near the ribbon)`);
const allTris: [number, number, number][] = cdt2d(pts2, edges);
// "Inside the ribbon" means covered by one of the ribbon's actual triangles (as drawn and collided),
// not by its section quads: at the folded hairpin shoulder those differ, and quads left a hole.
const ribTris: number[][][] = [];
const ribBuckets = new Map<string, number[]>();
for (let t = 0; t < lap.indices.length; t += 3) {
  const tri = [0, 1, 2].map((k) => [pos[lap.indices[t + k] * 3], 0, pos[lap.indices[t + k] * 3 + 2]]);
  const id = ribTris.push(tri) - 1;
  const xs = tri.map((p) => p[0]), zs = tri.map((p) => p[2]);
  for (let bx = Math.floor(Math.min(...xs) / B); bx <= Math.floor(Math.max(...xs) / B); bx++)
    for (let bz = Math.floor(Math.min(...zs) / B); bz <= Math.floor(Math.max(...zs) / B); bz++) {
      const key = `${bx},${bz}`;
      if (!ribBuckets.has(key)) ribBuckets.set(key, []);
      ribBuckets.get(key)!.push(id);
    }
}
const insideRibbon = (x: number, z: number) => {
  for (const id of ribBuckets.get(`${Math.floor(x / B)},${Math.floor(z / B)}`) ?? []) {
    const [a, b, c] = ribTris[id];
    if (inTri(x, z, a, b, c)) return true;
  }
  return false;
};
// Drop a face only if it is fully under the ribbon (centroid, edge midpoints and points just inside
// each corner); faces only partly under it (at the folded hairpin shoulder) are kept, so no hole opens.
const covered = (a: number, b: number, c: number) => {
  const P = [pts2[a], pts2[b], pts2[c]];
  const cx = (P[0][0] + P[1][0] + P[2][0]) / 3, cz = (P[0][1] + P[1][1] + P[2][1]) / 3;
  const probes: [number, number][] = [[cx, cz]];
  for (let k = 0; k < 3; k++) {
    const p = P[k], q = P[(k + 1) % 3];
    probes.push([(p[0] + q[0]) / 2 * 0.9 + cx * 0.1, (p[1] + q[1]) / 2 * 0.9 + cz * 0.1]);
    probes.push([p[0] * 0.9 + cx * 0.1, p[1] * 0.9 + cz * 0.1]);
  }
  return probes.every(([x, z]) => insideRibbon(x, z));
};
const inFold = (a: number, b: number, c: number) => {
  const x = (pts2[a][0] + pts2[b][0] + pts2[c][0]) / 3, z = (pts2[a][1] + pts2[b][1] + pts2[c][1]) / 3;
  return foldBoxes.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
};
// Around a cut fold the ribbon's twisted shoulder doesn't cover what its outline suggests: keep every
// ground face there (overlapping the inner shoulder a little) so no hole can open.
const tris = allTris.filter(([a, b, c]) => inFold(a, b, c) || !covered(a, b, c));
console.log(`removed ${allTris.length - tris.length} faces inside the ribbon`);

// ---------- geometry ----------
const r2 = (v: number) => Math.round(v * 100) / 100;
const positions: number[] = [];
for (let i = 0; i < pts2.length; i++) positions.push(r2(pts2[i][0]), r2(heights[i]), r2(pts2[i][1]));
const indices: number[] = [];
for (const [a, b, c] of tris) {
  // Wind so the normal points up (+Y) in X-east/Z-south.
  const [ax, az] = pts2[a], [bx, bz] = pts2[b], [cx, cz] = pts2[c];
  const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0;
  indices.push(...(up ? [a, b, c] : [a, c, b]));
}
// Fold patch: a 1 m grid under each cut fold, 5 cm below the nearby shoulder heights (inverse-distance
// from the ribbon's edge vertices), so the sliver the triangulation leaves uncovered there is ground.
const cdtIndexCount = indices.length;
let patchTris = 0;
for (const [x0, z0, x1, z1] of foldBoxes) {
  const near = [...edgeL, ...edgeR].filter((p) => p[0] > x0 - 10 && p[0] < x1 + 10 && p[2] > z0 - 10 && p[2] < z1 + 10);
  const hAt = (x: number, z: number) => {
    let w = 0, h = 0;
    for (const p of near) { const d = Math.hypot(p[0] - x, p[2] - z) + 0.5; w += 1 / d ** 2; h += p[1] / d ** 2; }
    return h / w - 0.05;
  };
  const W = Math.ceil(x1 - x0), D = Math.ceil(z1 - z0), base = positions.length / 3;
  for (let j = 0; j <= D; j++) for (let i = 0; i <= W; i++) positions.push(r2(x0 + i), r2(hAt(x0 + i, z0 + j)), r2(z0 + j));
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const a = base + j * (W + 1) + i, b = a + 1, c = a + W + 1, d = c + 1;
    // a(x0,z0) b(x+1) c(z+1): (b-a)=(1,0,0), (c-a)=(0,0,1) -> y of cross = 0*0 - 1*1 < 0, so a,c,b faces up.
    indices.push(a, c, b, b, c, d);
    patchTris += 2;
  }
}
console.log(`fold patch: ${patchTris} triangles`);
// Report: terrain triangles whose centroid lies under a ribbon triangle (kept partial covers only).
let inside = 0;
for (let t = 0; t < cdtIndexCount; t += 3) {
  const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
  if (insideRibbon((pts2[a][0] + pts2[b][0] + pts2[c][0]) / 3, (pts2[a][1] + pts2[b][1] + pts2[c][1]) / 3)) inside++;
}
const note = `Constrained Delaunay terrain: ${tris.length} triangles sharing the ribbon's outer edge vertices (${NL + NR} after cutting ${loopL.folds + loopR.folds} shoulder folds${RLP ? "" : " at La Source"}); ${inside} kept faces partly under the ribbon (at ${RLP ? "a" : "the hairpin"} fold; all fully covered faces removed).`;
console.log(note);

await Bun.write(OUT, JSON.stringify({
  meta: {
    name: `${String(meta.name).split(":")[0]}: surrounding ground`,
    elevationSource: meta.elevationSource,
    sourceCrs: meta.sourceCrs,
    heightDatum: meta.heightDatum,
    localOrigin: meta.localOrigin,
    axes: meta.axes,
    notes: [
      `Grid ${GRID_STEP} m spacing over the circuit extent plus ${GRID_MARGIN} m (${GW} x ${GH}); ${dropped} grid points on or within ${CLEAR} m of the ribbon removed.`,
      "Triangulated together with the lap ribbon's outer shoulder edges as constraints (cdt2d), keeping faces outside the ribbon, so road -> shoulder -> ground is one continuous surface.",
      RLP
        ? "Heights: DGM1 1 m tiles, bilinear between cell centres, per grid point (bare earth: no trees or buildings); ribbon edge vertices keep their baked heights."
        : "Heights: nearest 0.5 m DTM cell per grid point (bare earth: no trees or buildings); ribbon edge vertices keep their baked heights.",
      `Fold patch: ${RLP ? "where a narrowed inner shoulder folds over itself" : "at the La Source hairpin the narrowed inner shoulder folds over itself"}; that edge-loop crossing is cut before triangulating, and a 1 m grid patch (${patchTris} triangles) lies under the fold at heights interpolated (inverse distance) from nearby ribbon edge vertices, 0.05 m below them, so no hole remains.`,
      note,
    ],
  },
  positions,
  indices,
  groups: [{ name: "ground", start: 0, count: indices.length }],
}));
console.log(`wrote ${OUT}: ${(Bun.file(OUT).size / 1024).toFixed(0)} KB, ${positions.length / 3} vertices, ${indices.length / 3} triangles`);
