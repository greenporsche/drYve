// Offline bake of the trees and buildings around the lap (scenery stage 3). Run after the terrain bake:
//   bun scripts/bake-scenery.ts [spa|nurburgring-gp]   -> public/data/<circuit>-scenery.json
//
// Heights come from the same SPW LiDAR survey as the ground: the surface model (MNS 2021-2022, 0.5 m:
// tree tops and roofs) minus the terrain model (MNT 2021-2022: bare ground) gives what stands on the
// ground at a point. Both are sampled through the MapServer identify endpoints and cached in data/raw/.
//   - Trees: on the terrain's 10 m grid, within RANGE m of the lap and more than ROAD_CLEAR m from
//     its centreline (bridges, barriers, stands and cars near the road are left out), a point with
//     MIN_TREE..MAX_TREE m standing on it, outside every building footprint, is a tree that tall.
//   - Buildings: OpenStreetMap footprints (Overpass) in the terrain bounds, projected to EPSG:3812.
//     Height = median standing height sampled inside the footprint, else 3 m per building:levels,
//     else 6 m; base = lowest ground under its corners. Footprints reaching within ROAD_CLEAR m of
//     the centreline are dropped: over the road they are bridges or roofs the cars pass under, and an
//     extruded block there would wall off the track (PO #20734).
// Visual only: nothing here is collided with.
import { existsSync } from "node:fs";
import proj4 from "proj4";
import { rlpRaster } from "./lib/rlp";

const RANGE = 220, ROAD_CLEAR = 14, STEP = 10; // m
const MIN_TREE = 3, MAX_TREE = 45; // m
const MNS = "https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNS_2021_2022/MapServer";
const MNT = "https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer";
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const CELL = 0.5;

proj4.defs(
  "EPSG:3812",
  "+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333333333333 +lat_2=51.1666666666667 " +
    "+x_0=649328 +y_0=665262 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);

proj4.defs("EPSG:25832", "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
const CIRCUIT = process.argv[2] ?? "spa";
const lap = JSON.parse(await Bun.file(`public/data/${CIRCUIT}-lap.json`).text());
const terrain = JSON.parse(await Bun.file(`public/data/${CIRCUIT}-terrain.json`).text());
const CRS: string = terrain.meta.sourceCrs;
const RLP = CRS === "EPSG:25832"; // Rhineland-Palatinate: DOM1 - DGM1 from 1 km tiles (scripts/lib/rlp.ts)
const o = terrain.meta.localOrigin;
const cl: number[] = lap.centerline.points;
const N = cl.length / 3;
const tp: number[] = terrain.positions;
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < tp.length; i += 3) {
  minX = Math.min(minX, tp[i]); maxX = Math.max(maxX, tp[i]);
  minZ = Math.min(minZ, tp[i + 2]); maxZ = Math.max(maxZ, tp[i + 2]);
}

// ---------- LiDAR cells (cached; MNT cache shared with the road and terrain bakes) ----------
const keyOf = (x: number, z: number) => `${Math.floor((x + o.easting) / CELL)},${Math.floor((-z + o.northing) / CELL)}`;
type Cache = { path: string; service: string; cells: Record<string, number> };
const load = (path: string, service: string): Cache => ({ path, service, cells: existsSync(path) ? JSON.parse(require("node:fs").readFileSync(path, "utf8")) : {} });
const mnt = load("data/raw/mnt-2021-2022-cells.json", MNT);
const mns = load("data/raw/mns-2021-2022-cells.json", MNS);
async function identify(service: string, k: string): Promise<number> {
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
      if (attempt >= 4) return NaN;
      await Bun.sleep(500 * (attempt + 1));
    }
  }
}
async function fill(c: Cache, keys: string[]) {
  const todo = [...new Set(keys)].filter((k) => !(k in c.cells));
  console.log(`${c.path}: ${todo.length} cells to fetch (${Object.keys(c.cells).length} cached)`);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const k = todo[next++];
      c.cells[k] = await identify(c.service, k);
      if (++done % 2000 === 0) (console.log(`  ${done}/${todo.length}`), await Bun.write(c.path, JSON.stringify(c.cells)));
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  await Bun.write(c.path, JSON.stringify(c.cells));
}
let rlpMeta: { dgm: { name: string; acquired: string | null; heightDatum: string | null }[]; dom: { name: string; acquired: string | null; heightDatum: string | null }[] } | null = null;
let ground = (x: number, z: number) => mnt.cells[keyOf(x, z)] - o.height;
let standing = (x: number, z: number) => mns.cells[keyOf(x, z)] - mnt.cells[keyOf(x, z)];

// ---------- distance to the lap centreline (bucketed) ----------
const BK = 50;
const buckets = new Map<string, number[]>();
for (let k = 0; k < N; k++) {
  const key = `${Math.floor(cl[k * 3] / BK)},${Math.floor(cl[k * 3 + 2] / BK)}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key)!.push(k);
}
function distToLap(x: number, z: number) {
  const bx = Math.floor(x / BK), bz = Math.floor(z / BK), r = Math.ceil(RANGE / BK);
  let best = Infinity;
  for (let i = bx - r; i <= bx + r; i++) for (let j = bz - r; j <= bz + r; j++)
    for (const k of buckets.get(`${i},${j}`) ?? []) {
      const n = (k + 1) % N;
      const ax = cl[k * 3], az = cl[k * 3 + 2], dx = cl[n * 3] - ax, dz = cl[n * 3 + 2] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
  return best;
}

// ---------- buildings (OSM) ----------
const toLocal = (lon: number, lat: number): [number, number] => {
  const [e, n] = proj4("EPSG:4326", CRS, [lon, lat]) as [number, number];
  return [e - o.easting, -(n - o.northing)];
};
const corners = [[minX, minZ], [maxX, maxZ]].map(([x, z]) => proj4(CRS, "EPSG:4326", [x + o.easting, o.northing - z]) as [number, number]);
const [s, w, nn, e] = [Math.min(corners[0][1], corners[1][1]), Math.min(corners[0][0], corners[1][0]), Math.max(corners[0][1], corners[1][1]), Math.max(corners[0][0], corners[1][0])];
const osmPath = CIRCUIT === "spa" ? "data/raw/osm-buildings.json" : `data/raw/osm-buildings-${CIRCUIT}.json`;
let osm: any;
if (existsSync(osmPath)) osm = JSON.parse(await Bun.file(osmPath).text());
else {
  const q = `[out:json][timeout:90];way["building"](${s},${w},${nn},${e});out tags geom;`;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q) });
      if (!r.ok) throw new Error(String(r.status));
      osm = await r.json();
      break;
    } catch (err) {
      console.log(`overpass ${url} failed: ${err}`);
    }
  }
  if (!osm) {
    // Overpass busy: the main OSM API's map call, in tiles under its node limit, rebuilt into the same
    // shape (building ways with tags and node geometry).
    const nodes = new Map<number, { lat: number; lon: number }>(), bways = new Map<number, any>();
    const T = 0.01;
    for (let la = s; la < nn; la += T) for (let lo = w; lo < e; lo += T) {
      const r = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${lo},${la},${Math.min(e, lo + T)},${Math.min(nn, la + T)}`, { headers: { "User-Agent": "spa-kinesthetic-map-bake/1.0" } });
      if (!r.ok) throw new Error(`OSM API ${r.status}`);
      for (const el of (await r.json()).elements) {
        if (el.type === "node") nodes.set(el.id, { lat: el.lat, lon: el.lon });
        else if (el.type === "way" && el.tags?.building) bways.set(el.id, el);
      }
    }
    osm = { elements: [...bways.values()].map((wy) => ({ type: "way", id: wy.id, tags: wy.tags, geometry: wy.nodes.map((id: number) => nodes.get(id)).filter(Boolean) })) };
  }
  await Bun.write(osmPath, JSON.stringify(osm));
}
type Building = { ring: [number, number][]; levels?: number; kind: string };
const footprints: Building[] = [];
let dropped = 0;
for (const el of osm.elements ?? []) {
  if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
  const ring = el.geometry.map((g: any) => toLocal(g.lon, g.lat)) as [number, number][];
  if (ring.every(([x, z]) => x < minX || x > maxX || z < minZ || z > maxZ)) continue;
  if (ring.some(([x, z]) => distToLap(x, z) <= ROAD_CLEAR) || inside(ring, cl[0], cl[2]) || Array.from({ length: N }, (_, k) => k).some((k) => k % 4 === 0 && inside(ring, cl[k * 3], cl[k * 3 + 2]))) {
    dropped++;
    continue;
  }
  const lv = parseFloat(el.tags?.["building:levels"]);
  footprints.push({ ring: ring.slice(0, -1), levels: Number.isFinite(lv) ? lv : undefined, kind: el.tags?.building ?? "yes" });
}
console.log(`${footprints.length} OSM building footprints (${dropped} on or over the road dropped)`);
function inside(ring: [number, number][], x: number, z: number) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
// Sample points inside each footprint: centroid plus points pulled 30% toward it from each corner.
const samplesOf = (b: Building) => {
  const cx = b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length, cz = b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length;
  return [[cx, cz], ...b.ring.map(([x, z]) => [x + (cx - x) * 0.3, z + (cz - z) * 0.3])].filter(([x, z]) => inside(b.ring, x, z));
};

// ---------- fetch heights ----------
const grid: [number, number][] = [];
for (let x = Math.ceil(minX / STEP) * STEP; x <= maxX; x += STEP)
  for (let z = Math.ceil(minZ / STEP) * STEP; z <= maxZ; z += STEP) {
    const d = distToLap(x, z);
    if (d > ROAD_CLEAR && d <= RANGE) grid.push([x, z]);
  }
console.log(`${grid.length} tree grid points within ${RANGE} m of the lap`);
const bPoints = footprints.flatMap((b) => [...samplesOf(b), ...b.ring]);
if (RLP) {
  const box = [o.easting + minX - 2, o.northing - maxZ - 2, o.easting + maxX + 2, o.northing - minZ + 2] as const;
  const dgm = await rlpRaster("dgm1", ...box), dom = await rlpRaster("dom1", ...box);
  ground = (x, z) => dgm.sample(x + o.easting, o.northing - z) - o.height;
  standing = (x, z) => dom.sample(x + o.easting, o.northing - z) - dgm.sample(x + o.easting, o.northing - z);
  rlpMeta = { dgm: dgm.metas, dom: dom.metas };
} else {
  await fill(mnt, [...grid, ...bPoints].map(([x, z]) => keyOf(x, z)));
  await fill(mns, [...grid, ...footprints.flatMap(samplesOf)].map(([x, z]) => keyOf(x, z)));
}

// ---------- assemble ----------
const r1 = (v: number) => Math.round(v * 10) / 10;
const buildings = footprints.map((b) => {
  const hs = samplesOf(b).map(([x, z]) => standing(x, z)).filter((h) => Number.isFinite(h) && h > 1).sort((a, c) => a - c);
  const height = hs.length ? hs[Math.floor(hs.length / 2)] : b.levels ? b.levels * 3 : 6;
  const base = Math.min(...b.ring.map(([x, z]) => ground(x, z)).filter(Number.isFinite));
  return { ring: b.ring.flatMap(([x, z]) => [r1(x), r1(z)]), base: r1(base), height: r1(Math.min(60, Math.max(2.5, height))), kind: b.kind };
}).filter((b) => Number.isFinite(b.base));
const trees: number[] = [];
for (const [x, z] of grid) {
  const h = standing(x, z), y = ground(x, z);
  if (!Number.isFinite(h) || !Number.isFinite(y) || h < MIN_TREE || h > MAX_TREE) continue;
  if (footprints.some((b) => inside(b.ring, x, z))) continue;
  trees.push(x, r1(y), z, r1(h));
}
console.log(`${trees.length / 4} trees, ${buildings.length} buildings`);

await Bun.write(
  `public/data/${CIRCUIT}-scenery.json`,
  JSON.stringify({
    meta: {
      localOrigin: o,
      sources: rlpMeta ? {
        heights: "LVermGeo RLP DOM1 minus DGM1, 1 m (dl-de/by-2-0)",
        dom: `https://geobasis-rlp.de/data/dom1/current/tif/ (${[...new Set(rlpMeta.dom.map((m) => m.acquired))].join(", ")}; ${[...new Set(rlpMeta.dom.map((m) => m.heightDatum))].join(", ")})`,
        dgm: `https://geobasis-rlp.de/data/dgm1/current/tif/ (${[...new Set(rlpMeta.dgm.map((m) => m.acquired))].join(", ")}; ${[...new Set(rlpMeta.dgm.map((m) => m.heightDatum))].join(", ")})`,
        tiles: [...rlpMeta.dgm, ...rlpMeta.dom].map((m) => m.name),
        footprints: "© OpenStreetMap contributors (ODbL), building ways",
      } : {
        heights: "SPW Relief de la Wallonie MNS 2021-2022 minus MNT 2021-2022, 0.5 m (CC BY 4.0)",
        mns: MNS,
        mnt: MNT,
        footprints: "© OpenStreetMap contributors (ODbL), building ways via Overpass",
      },
      notes: [
        `Trees: ${STEP} m grid points ${ROAD_CLEAR}-${RANGE} m from the lap centreline with ${MIN_TREE}-${MAX_TREE} m standing height (MNS - MNT), outside building footprints.`,
        "Buildings: OSM footprints; height = median MNS - MNT inside the footprint, else 3 m per level, else 6 m; base = lowest ground under the corners. Footprints within ${ROAD_CLEAR} m of the centreline (bridges, roofs over the road) are dropped.",
        "Visual only; nothing here is collided with.",
      ],
      tree: "[x, groundY, z, height] per tree, local metres",
    },
    trees,
    buildings,
  }),
);
console.log(`wrote public/data/${CIRCUIT}-scenery.json`);
