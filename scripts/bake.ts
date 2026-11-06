// Offline bake of a circuit's road surface from OSM centerline + public LiDAR terrain heights.
// Run: bun scripts/bake.ts lap              Spa full closed lap -> public/data/spa-lap.json
//      bun scripts/bake.ts eau-rouge        Spa La Source -> Les Combes stretch -> public/data/eau-rouge.json
//      bun scripts/bake.ts nurburgring-gp   Nürburgring GP circuit -> public/data/nurburgring-gp-lap.json
// Height sources: Spa = SPW Wallonia MNT (below); Nürburgring = LVermGeo RLP DGM1 tiles
// (scripts/lib/rlp.ts).
// Raw downloads are cached under data/raw/.
//
// Centerline: OpenStreetMap highway=raceway ways (Overpass), chained in race direction.
// Heights: SPW Wallonia LiDAR DTM (MNT) 2021-2022, 0.5 m, EPSG:3812, Ostend heights (EPSG:5710).
// SPW publishes this DTM only as whole-province ZIPs (no range requests) or as an ArcGIS MapServer
// whose export is a rendered image. The MapServer `identify` operation returns the raw cell value,
// so we read exactly the 0.5 m cells we need (4 per sample, for bilinear interpolation).

import proj4 from "proj4";
import { mkdirSync, existsSync } from "node:fs";
import { rlpRaster, RLP_LICENCE, RLP_ATTRIBUTION } from "./lib/rlp";

const RAW = "data/raw";
mkdirSync(RAW, { recursive: true });
mkdirSync("public/data", { recursive: true });

// ---------- constants ----------
const SPACING = 2; // m, centerline sample spacing
let ROAD_W = 12; // m (per circuit below)
const SHOULDER_W = 8; // m each side

const CELL = 0.5; // DTM cell size, m (grid edges at multiples of 0.5 in EPSG:3812)

// OSM highway=raceway ways in race direction, each starting where the previous one ends.
const STRETCH_WAYS = [613486590, 126807099, 175178443, 175178448, 126807110, 126835639, 126835637, 126835638];
const CONFIGS = {
  // Pit straight (Bus Stop exit -> La Source), La Source, N62 descent, Eau Rouge, Raidillon, Kemmel
  // (ends where the "Les Combes" way starts, i.e. the turn-in). Starts 200 m before La Source braking.
  "eau-rouge": {
    out: "public/data/eau-rouge.json",
    name: "Spa-Francorchamps: La Source to Les Combes",
    ways: STRETCH_WAYS,
    closed: false,
    runUp: 200,
    tileNote: "; tile LIDAR_2021_2022_500mN6260E7635 (Eau Rouge) flown 2022-02-28 to 2022-03-03",
    source: "spw",
    roadWidth: 12,
    bacinger: "be-1925",
  },
  // Grand Prix layout, closed loop from the Bus Stop chicane exit: the stretch above, then Les Combes,
  // Malmedy, Bruxelles, Speaker's Corner (not the "Moto layout" variant), Double Gauche (Pouhon),
  // Fagnes, Campus, Courbe Paul Frère, Blanchimont and the Chicane (Bus Stop).
  lap: {
    out: "public/data/spa-lap.json",
    name: "Spa-Francorchamps: Grand Prix circuit",
    ways: [
      ...STRETCH_WAYS, 1430527230, 24449918, 126807113, 175195997, 126807111, 126807112, 1359025268, 126807106,
      1359025267, 126807103, 126807101, 126807109, 126807116, 175371353, 175371365, 126807100, 176133746,
      126807114, 176133745, 178964809, 126807105, 637268672,
    ],
    closed: true,
    runUp: 0,
    tileNote: "; per-tile flight dates vary across the circuit",
    source: "spw",
    roadWidth: 12,
    bacinger: "be-1925",
    // Local road-boundary correction at La Source (EM #20901; the explicit exception to the unchanged-
    // geometry baseline). Half-widths [station m, left, right] (left/right of travel) to the white
    // line / kerb inner edge, NOT the paved run-off beyond it, read off the SPW 2023 summer
    // orthophoto (0.65 m/px; a dated-image estimate, +-~0.7 m) by sampling the photo across the road
    // every 0.25 m (dark grey = asphalt) and checking the ladders by eye. Linear between knots; the
    // first and last knots are the default 6 m, so the correction blends into the existing road.
    widthKnots: [
      [500, 6, 6], [530, 7.75, 6.25], [590, 7.75, 6.25], [600, 8.25, 6.5], [610, 9.75, 8], [620, 10.5, 11.5],
      [630, 11, 12], [640, 8.75, 11.5], [650, 7.5, 10.5], [660, 7.5, 10.25], [670, 7, 10.25], [680, 6.25, 10],
      [690, 6, 8.75], [710, 6, 6],
    ] as [number, number, number][],
  },
  // Nürburgring GP-Strecke (OSM relation 38567, members already in race order), closed loop from the
  // relation's first member. Road width 12 m is an assumption, as at Spa.
  "nurburgring-gp": {
    out: "public/data/nurburgring-gp-lap.json",
    name: "Nürburgring: Grand Prix circuit",
    relation: 38567,
    ways: [] as number[],
    closed: true,
    runUp: 0,
    tileNote: "",
    source: "rlp",
    roadWidth: 12,
    bacinger: "de-1927",
  },
};
const CFG = CONFIGS[(process.argv[2] ?? "lap") as keyof typeof CONFIGS];
if (!CFG) throw new Error(`unknown config ${process.argv[2]}; use one of ${Object.keys(CONFIGS)}`);
const OUT = CFG.out;
ROAD_W = CFG.roadWidth;
const ROAD_COLS = [-1, -0.5, 0, 0.5, 1].map((f) => (f * ROAD_W) / 2); // lateral offsets, + = right of travel
const RLP = CFG.source === "rlp";
const RELATION: number | undefined = (CFG as { relation?: number }).relation;
let WAY_IDS: number[] = [...CFG.ways];
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const BACINGER_URL = `https://raw.githubusercontent.com/bacinger/f1-circuits/master/circuits/${CFG.bacinger}.geojson`;
const MNT_SERVICE = "https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer";

proj4.defs(
  "EPSG:3812",
  "+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333333333333 +lat_2=51.1666666666667 " +
    "+x_0=649328 +y_0=665262 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);
proj4.defs("EPSG:25832", "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
const CRS = RLP ? "EPSG:25832" : "EPSG:3812";
// Geographic to the circuit's metric CRS (Belgian Lambert 2008 at Spa, UTM 32N at the Nürburgring).
const toLambert = (lon: number, lat: number) => proj4("EPSG:4326", CRS, [lon, lat]) as [number, number];

type P = [number, number]; // easting, northing

// ---------- downloads (cached) ----------
async function cached(file: string, fetcher: () => Promise<string>): Promise<any> {
  const path = `${RAW}/${file}`;
  if (!existsSync(path)) await Bun.write(path, await fetcher());
  return JSON.parse(await Bun.file(path).text());
}

const osmQuery = RELATION
  ? `[out:json][timeout:60];relation(${RELATION});out body;way(r);out tags geom;`
  : `[out:json][timeout:60];way(id:${WAY_IDS.join(",")});out tags geom;`;
const osmFile = RELATION ? `osm-${process.argv[2]}-rel.json` : CFG.closed ? "osm-spa-raceway-lap.json" : "osm-spa-raceway.json";
const osm = await cached(osmFile, async () => {
  for (const ep of OVERPASS) {
    const r = await fetch(ep, { method: "POST", body: new URLSearchParams({ data: osmQuery }), headers: { "User-Agent": "formula1-tracks-bake/0.1" } });
    const t = await r.text();
    if (r.ok && t.trim().startsWith("{")) return t;
    console.warn(`overpass ${ep} -> ${r.status}, trying next`);
  }
  throw new Error("all Overpass endpoints failed");
});
const osmStamp: string = osm.osm3s.timestamp_osm_base;
const bacinger = await cached(`bacinger-${CFG.bacinger}.geojson`, async () => (await fetch(BACINGER_URL)).text());
// A relation's ways are not always listed in race order (the GP relation lists the NGK chicane last):
// chain them by connectivity from its first member, following one-way directions.
if (RELATION) {
  const members: number[] = osm.elements.find((e: any) => e.type === "relation").members.filter((m: any) => m.type === "way").map((m: any) => m.ref);
  const geom = new Map<number, { lat: number; lon: number }[]>(osm.elements.filter((e: any) => e.type === "way").map((w: any) => [w.id, w.geometry]));
  const near = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => { const [x1, y1] = toLambert(a.lon, a.lat), [x2, y2] = toLambert(b.lon, b.lat); return Math.hypot(x1 - x2, y1 - y2) < 0.5; };
  const order = [members[0]], left = new Set(members.slice(1));
  let end = geom.get(members[0])!.at(-1)!;
  while (left.size) {
    const next = [...left].find((id) => near(geom.get(id)![0], end)) ?? [...left].find((id) => near(geom.get(id)!.at(-1)!, end));
    if (next === undefined) throw new Error(`relation ${RELATION}: no way continues after ${order.at(-1)}`);
    const g = geom.get(next)!;
    end = near(g[0], end) ? g.at(-1)! : g[0];
    order.push(next);
    left.delete(next);
  }
  WAY_IDS = order;
}

// ---------- centerline in plan ----------
const ways = new Map<number, any>(osm.elements.map((w: any) => [w.id, w]));
const raw: P[] = [];
let laSourceBrakeIdx = 0; // first node of the short way that leads into La Source
for (const id of WAY_IDS) {
  let g = ways.get(id).geometry as { lat: number; lon: number }[];
  if (id === 126807099) laSourceBrakeIdx = raw.length - 1;
  if (raw.length) {
    const last = raw.at(-1)!;
    const gap = (pt: { lat: number; lon: number }) => { const [e, n] = toLambert(pt.lon, pt.lat); return Math.hypot(e - last[0], n - last[1]); };
    // Two-way (non-oneway) ways may be drawn against the race direction: flip them to continue the chain.
    if (gap(g[0]) > 0.5 && gap(g.at(-1)!) <= 0.5 && ways.get(id).tags?.oneway !== "yes") g = [...g].reverse();
    if (gap(g[0]) > 0.5) throw new Error(`way ${id} does not start where the previous way ends`);
  }
  for (let i = raw.length ? 1 : 0; i < g.length; i++) raw.push(toLambert(g[i].lon, g[i].lat));
}
const CLOSED = CFG.closed;
if (CLOSED) {
  const gap = Math.hypot(raw[0][0] - raw.at(-1)![0], raw[0][1] - raw.at(-1)![1]);
  if (gap > 0.5) throw new Error(`loop does not close: ${gap.toFixed(1)} m gap`);
  raw.pop(); // last node repeats the first
}
const wrap = (i: number, n: number) => ((i % n) + n) % n;
// Index of a neighbour: wraps around a closed loop, clamps at the ends of an open stretch.
const nb = (i: number, n: number) => (CLOSED ? wrap(i, n) : Math.max(0, Math.min(n - 1, i)));

function cumDist(pts: P[]): number[] {
  const d = [0];
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return d;
}
// A closed loop as an open polyline that ends back on its first point.
const closeRing = (pts: P[]): P[] => [...pts, pts[0]];
function resample(pts: P[], step: number, from = 0, to = Infinity): P[] {
  const d = cumDist(pts);
  const end = Math.min(to, d.at(-1)!);
  const out: P[] = [];
  let j = 0;
  for (let s = from; s <= end + 1e-9; s += step) {
    while (j < d.length - 2 && d[j + 1] < s) j++;
    const t = (s - d[j]) / (d[j + 1] - d[j]);
    out.push([pts[j][0] + t * (pts[j + 1][0] - pts[j][0]), pts[j][1] + t * (pts[j + 1][1] - pts[j][1])]);
  }
  return out;
}
function movingAvg(v: number[], half: number): number[] {
  return v.map((_, i) => {
    let s = 0, n = 0;
    if (CLOSED) for (let k = i - half; k <= i + half; k++) (s += v[wrap(k, v.length)]), n++;
    else for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) (s += v[k]), n++;
    return s / n;
  });
}

// Resample at 1 m, smooth the polyline corners away with a +-4 m moving average, then resample at
// the final spacing. Open stretch: start runUp metres before the La Source braking node. Closed loop:
// start at the first node (Bus Stop exit) and use steps that divide the loop exactly, so the last
// section sits one step before the first.
let plan: P[];
if (CLOSED) {
  const ring = closeRing(raw);
  const rawL = cumDist(ring).at(-1)!;
  const fine = resample(ring, rawL / Math.round(rawL)).slice(0, -1);
  const fx = movingAvg(fine.map((p) => p[0]), 4), fy = movingAvg(fine.map((p) => p[1]), 4);
  const smooth = closeRing(fx.map((x, i) => [x, fy[i]] as P));
  const L = cumDist(smooth).at(-1)!;
  plan = resample(smooth, L / Math.round(L / SPACING)).slice(0, -1);
} else {
  const start = cumDist(raw)[laSourceBrakeIdx] - CFG.runUp;
  const fine = resample(raw, 1, start);
  const fx = movingAvg(fine.map((p) => p[0]), 4), fy = movingAvg(fine.map((p) => p[1]), 4);
  plan = resample(fx.map((x, i) => [x, fy[i]] as P), SPACING);
}
const N = plan.length;
const step = (k: number) => Math.hypot(plan[nb(k + 1, N)][0] - plan[k][0], plan[nb(k + 1, N)][1] - plan[k][1]);

// Plan-view unit tangent (central difference) and right-hand normal (east,north) frame.
const right: P[] = plan.map((_, i) => {
  const a = plan[nb(i - 1, N)], b = plan[nb(i + 1, N)];
  const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty);
  return [ty / l, -tx / l]; // tangent rotated -90 deg (clockwise) = right of travel
});

// ---------- DTM sampling via MapServer identify (cell cache) ----------
const cellCachePath = `${RAW}/mnt-2021-2022-cells.json`;
const cells: Record<string, number> = existsSync(cellCachePath) ? JSON.parse(await Bun.file(cellCachePath).text()) : {};

async function identifyCell(i: number, j: number): Promise<number> {
  const cx = (i + 0.5) * CELL, cy = (j + 0.5) * CELL;
  const ext = [cx - 1.5 * CELL, cy - 1.5 * CELL, cx + 1.5 * CELL, cy + 1.5 * CELL].join(",");
  const url = `${MNT_SERVICE}/identify?geometry=${cx},${cy}&geometryType=esriGeometryPoint&sr=3812&layers=all:0` +
    `&tolerance=0&mapExtent=${ext}&imageDisplay=3,3,96&returnGeometry=false&f=json`;
  const j2: any = await (await fetch(url)).json();
  return parseFloat(j2.results[0].attributes["Stretch.Pixel Value"]);
}

async function fillCells(keys: string[]) {
  const todo = [...new Set(keys)].filter((k) => !(k in cells));
  console.log(`DTM: ${todo.length} cells to fetch (${Object.keys(cells).length} cached)`);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const k = todo[next++];
      const [i, j] = k.split(",").map(Number);
      cells[k] = await identifyCell(i, j);
      if (++done % 1000 === 0) {
        console.log(`  ${done}/${todo.length}`);
        await Bun.write(cellCachePath, JSON.stringify(cells));
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  await Bun.write(cellCachePath, JSON.stringify(cells));
}

function cornerCells(p: P) {
  const gx = p[0] / CELL - 0.5, gy = p[1] / CELL - 0.5;
  const i = Math.floor(gx), j = Math.floor(gy);
  return { i, j, tx: gx - i, ty: gy - j };
}
const cellKeys = (p: P) => {
  const { i, j } = cornerCells(p);
  return [`${i},${j}`, `${i + 1},${j}`, `${i},${j + 1}`, `${i + 1},${j + 1}`];
};
function spwDtm(p: P): number {
  const { i, j, tx, ty } = cornerCells(p);
  const c = (a: number, b: number) => cells[`${a},${b}`];
  return (c(i, j) * (1 - tx) + c(i + 1, j) * tx) * (1 - ty) + (c(i, j + 1) * (1 - tx) + c(i + 1, j + 1) * tx) * ty;
}

// Road half-widths per section (left, right of travel): ROAD_W / 2, or the circuit's local
// corrections ("widthKnots", by 2D plan distance, within ~0.5% of the 3D station).
const KNOTS = (CFG as { widthKnots?: [number, number, number][] }).widthKnots;
const planDist: number[] = [0];
for (let k = 1; k < N; k++) planDist.push(planDist[k - 1] + Math.hypot(plan[k][0] - plan[k - 1][0], plan[k][1] - plan[k - 1][1]));
const halfW: [number, number][] = plan.map((_, k) => {
  const st = planDist[k];
  if (!KNOTS || st <= KNOTS[0][0] || st >= KNOTS[KNOTS.length - 1][0]) return [ROAD_W / 2, ROAD_W / 2];
  const j = KNOTS.findIndex((kn) => kn[0] >= st), a = KNOTS[j - 1], b = KNOTS[j], f = (st - a[0]) / (b[0] - a[0]);
  return [a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
});
// Inside a tight bend the road's inner edge can't reach the turn centre: cap the inside half-width at
// 70% of the local centreline radius, the same rule that keeps the inside shoulder from folding (the
// ladders across a hairpin's apex all converge on its inner kerb, so a photo reading there overstates
// the half-width). Geometric limit, not a tuning.
let widthCapped = 0;
if (KNOTS) for (let k = 0; k < N; k++) {
  const a = right[nb(k - 3, N)], b = right[nb(k + 3, N)];
  const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]); // + = left turn
  const radius = Math.abs(turn) > 1e-6 ? (SPACING * 6) / Math.abs(turn) : Infinity, side = turn > 0 ? 0 : 1;
  if (halfW[k][side] > 0.7 * radius) (halfW[k][side] = Math.max(ROAD_W / 2, 0.7 * radius)), widthCapped++;
}
// Smooth the corrected stretch (+-3 sections, ~6 m) so a capped edge has no kinks.
if (KNOTS) {
  const raw = halfW.map((w) => [...w]);
  for (let k = 0; k < N; k++) {
    if (planDist[k] <= KNOTS[0][0] || planDist[k] >= KNOTS[KNOTS.length - 1][0]) continue;
    for (const side of [0, 1]) {
      let sum = 0;
      for (let j = -3; j <= 3; j++) sum += raw[nb(k + j, N)][side];
      halfW[k][side] = Math.min(raw[k][side], sum / 7); // never wider than measured or capped
    }
  }
}
const outerOff = ROAD_W / 2 + SHOULDER_W;
const offsetPt = (k: number, off: number): P => [plan[k][0] + right[k][0] * off, plan[k][1] + right[k][1] * off];
// On the inside of a tight corner (La Source) a full-width shoulder would cross itself, so the
// inside shoulder is narrowed to 70% of the local turn radius (heading change over +-6 m).
const narrowed: number[] = [];
const turnAt = plan.map((_, k) => {
  const a = right[nb(k - 3, N)], b = right[nb(k + 3, N)];
  const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]); // + = left turn
  const span = CLOSED ? 6 : Math.min(N - 1, k + 3) - Math.max(0, k - 3);
  return { left: turn > 0, radius: Math.abs(turn) > 1e-6 ? (SPACING * span) / Math.abs(turn) : Infinity };
});
// Shoulder offsets each side: full width, or narrowed on the inside of a bend; with local width
// corrections the narrowed offset can jump between neighbouring sections as the radius opens, so
// within a corrected stretch it takes the smallest of the +-3 neighbours (prevents a plan-view fold).
const shoulderOff = plan.map((_, k) => {
  const [wl, wr] = halfW[k], t = turnAt[k], wi = t.left ? wl : wr;
  const inner = Math.max(wi + 0.5, Math.min(wi + SHOULDER_W, 0.7 * t.radius));
  return t.left ? [inner, wr + SHOULDER_W] : [wl + SHOULDER_W, inner];
});
const shoulderPts: P[][] = plan.map((_, k) => {
  const [wl, wr] = halfW[k];
  let [ol, or] = shoulderOff[k];
  const inCorrection = !!KNOTS && planDist[k] >= KNOTS[0][0] - 10 && planDist[k] <= KNOTS[KNOTS.length - 1][0] + 10;
  if (inCorrection) for (let j = -3; j <= 3; j++) {
    const n = shoulderOff[nb(k + j, N)];
    ol = Math.max(wl + 0.5, Math.min(ol, n[0])), or = Math.max(wr + 0.5, Math.min(or, n[1]));
  }
  if (ol < wl + SHOULDER_W || or < wr + SHOULDER_W) narrowed.push(k);
  return [offsetPt(k, -ol), offsetPt(k, or)];
});
let dtm: (p: P) => number = spwDtm;
let rlpMetas: { name: string; acquired: string | null; heightDatum: string | null }[] = [];
if (RLP) {
  // RLP DGM1 tiles covering the road and shoulders (bilinear between 1 m cell centres).
  const all = [...plan, ...shoulderPts.flat()], xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const r = await rlpRaster("dgm1", Math.min(...xs) - 5, Math.min(...ys) - 5, Math.max(...xs) + 5, Math.max(...ys) + 5);
  dtm = (p) => r.sample(p[0], p[1]);
  rlpMetas = r.metas;
} else await fillCells([...plan.flatMap(cellKeys), ...shoulderPts.flat().flatMap(cellKeys)]);

// Centerline heights: bilinear DTM, then a 5-sample (+-4 m) moving average along distance.
const hRaw = plan.map(dtm);
if (hRaw.some((v) => !Number.isFinite(v))) throw new Error("terrain model has no value under part of the road");
const hSource = hRaw.slice(); // the terrain model's own heights, before any bridge/pit repair
// Bridge decks: the terrain models are bare ground (DGM1 explicitly leaves bridges out), so on an
// OSM bridge=yes way the road height is the straight line between the ground at its two ends.
const bridgeLines: P[][] = WAY_IDS.filter((id) => ways.get(id).tags?.bridge === "yes").map((id) =>
  (ways.get(id).geometry as { lat: number; lon: number }[]).map((g) => toLambert(g.lon, g.lat)),
);
const onBridge = plan.map((p) => bridgeLines.some((l) => distToPolyline(p, l) < 3));
const bridgeRuns: [number, number][] = [];
for (let k = 0; k < N; k++) if (onBridge[k] && !onBridge[nb(k - 1, N)]) {
  let e = k;
  while (onBridge[nb(e + 1, N)] && e - k < N) e++;
  bridgeRuns.push([k, e]);
}
for (const [a, b] of bridgeRuns) {
  const i0 = nb(a - 1, N), i1 = nb(b + 1, N), span = b - a + 2;
  for (let k = a; k <= b; k++) hRaw[nb(k, N)] = hRaw[i0] + ((hRaw[i1] - hRaw[i0]) * (k - a + 1)) / span;
}
// Unmarked structures (RLP): DGM1 removes every bridge, including where the track passes over an
// underpass that OSM tags on the road below, leaving a pit in the road profile. Where the road sits
// more than DIP_M below the straight line between points up to DIP_SPAN either side, bridge it the
// same way (a real road surface doesn't drop metres and climb back within a few tens of metres).
const DIP_M = 1.0, DIP_SPAN = 15; // m below the chord; samples each side (30 m at 2 m spacing): bridge-length pits only
const dipRuns: [number, number][] = [];
if (RLP) {
  const inDip = plan.map(() => false);
  for (let k = 0; k < N; k++)
    for (let w = 3; w <= DIP_SPAN; w++) {
      const a = hRaw[nb(k - w, N)], b = hRaw[nb(k + w, N)];
      if (hRaw[k] >= (a + b) / 2 - DIP_M) continue;
      // Mark only the samples that actually sit below this chord (the pit itself, not its rims).
      for (let j = k - w + 1; j < k + w; j++) {
        const chord = a + ((b - a) * (j - (k - w))) / (2 * w);
        if (hRaw[nb(j, N)] < chord - 0.3) inDip[nb(j, N)] = true;
      }
    }
  // Shrink each marked run to where the profile actually leaves the chord, then fill it linearly.
  for (let k = 0; k < N; k++) if (inDip[k] && !inDip[nb(k - 1, N)]) {
    let e = k;
    while (inDip[nb(e + 1, N)] && e - k < N) e++;
    dipRuns.push([k, e]);
  }
  for (const [a, b] of dipRuns) {
    const i0 = nb(a - 1, N), i1 = nb(b + 1, N), span = b - a + 2;
    for (let k = a; k <= b; k++) (hRaw[nb(k, N)] = hRaw[i0] + ((hRaw[i1] - hRaw[i0]) * (k - a + 1)) / span), (onBridge[nb(k, N)] = true);
  }
}
const h = movingAvg(hRaw, 2);
// Deck ends: a straight deck meets the ground's slope at a kink that throws a fast car into the air.
// Within BLEND samples of each repaired span's ends, use a wider (+-BLEND samples) average instead:
// a vertical curve, as real bridge approaches have.
const BLEND = 6; // samples (12 m)
const blended: number[] = [];
if (RLP) {
  const wide = movingAvg(hRaw, BLEND);
  for (const [a, b] of [...bridgeRuns, ...dipRuns]) for (const end of [a, b + 1])
    for (let k = end - BLEND; k <= end + BLEND; k++) { const i = nb(k, N); if (!blended.includes(i)) (h[i] = wide[i]), blended.push(i); }
}
// Every repaired sample (raw terrain-model height vs the interpolated deck estimate), for review.
const repairs: { kind: string; from: number; to: number; samples: { station: number; raw: number; repaired: number }[]; maxCorrectionM: number }[] = [];
for (const [kind, runs] of [["bridge (OSM bridge=yes)", bridgeRuns], ["pit (unmarked structure)", dipRuns]] as const)
  for (const [a, b] of runs) {
    const samples = [];
    for (let k = a; k <= b; k++) { const i = nb(k, N); if (hRaw[i] !== hSource[i]) samples.push({ station: 0, raw: Math.round(hSource[i] * 100) / 100, repaired: Math.round(hRaw[i] * 100) / 100, i }); }
    repairs.push({ kind, from: a, to: b, samples: samples as any, maxCorrectionM: Math.round(Math.max(0, ...samples.map((x: any) => Math.abs(x.repaired - x.raw))) * 100) / 100 });
  }
const changedOutside = hRaw.filter((v, i) => v !== hSource[i] && !onBridge[i]).length; // must be 0

// ---------- local frame & geometry ----------
const origin = { e: plan[0][0], n: plan[0][1], h: hRaw[0] };
const r2 = (v: number) => Math.round(v * 100) / 100;
const local = (p: P, y: number) => [r2(p[0] - origin.e), r2(y - origin.h), r2(-(p[1] - origin.n))];

const COLS = ROAD_COLS.length + 2; // [left outer shoulder, road cols..., right outer shoulder]
const positions: number[] = [];
for (let k = 0; k < N; k++) {
  // On a bridge the shoulders are the deck too (the ground below would be a drop).
  positions.push(...local(shoulderPts[k][0], onBridge[k] ? h[k] : dtm(shoulderPts[k][0])));
  const [wl, wr] = halfW[k];
  for (const off of [-wl, -wl / 2, 0, wr / 2, wr]) positions.push(...local(offsetPt(k, off), h[k]));
  positions.push(...local(shoulderPts[k][1], onBridge[k] ? h[k] : dtm(shoulderPts[k][1])));
}

// Quad between column c and c+1 of sections k and k+1. Columns increase to the right of travel.
// In X-east/Z-south, going forward then right is counter-clockwise seen from +Y, so
// (k,c) -> (k,c+1) -> (k+1,c+1) is wound so the normal points up.
// On a closed loop the last section joins back to the first, so the seam shares its vertices.
const quad = (k: number, c: number) => {
  const a = k * COLS + c, b = a + 1, d = nb(k + 1, N) * COLS + c, e = d + 1;
  return [a, b, e, a, e, d];
};
const road: number[] = [], shoulder: number[] = [];
for (let k = 0; k < (CLOSED ? N : N - 1); k++) {
  for (let c = 0; c < COLS - 1; c++) (c === 0 || c === COLS - 2 ? shoulder : road).push(...quad(k, c));
}
// Sanity: first road triangle normal must point up (+Y); report plan-view fold-overs.
const pos = (i: number) => positions.slice(i * 3, i * 3 + 3);
const upY = (t: number[]) => {
  const [a, b, c] = t.map(pos);
  const u = [b[0] - a[0], b[2] - a[2]], v = [c[0] - a[0], c[2] - a[2]];
  return u[1] * v[0] - u[0] * v[1]; // y component of (b-a) x (c-a)
};
if (upY(road.slice(0, 3)) <= 0) throw new Error("winding check failed: road normal points down");
let folds = 0;
for (const g of [road, shoulder]) for (let t = 0; t < g.length; t += 3) if (upY(g.slice(t, t + 3)) <= 0) folds++;

// Cumulative 3D distance along the centerline. On a closed loop `length` adds the closing step
// from the last section back to the first, so distance wraps from length to 0 at the seam.
const centerPts: number[] = [], distance: number[] = [0];
for (let k = 0; k < N; k++) {
  centerPts.push(...local(plan[k], h[k]));
  if (k) distance.push(r2(distance[k - 1] + Math.hypot(CLOSED ? step(k - 1) : SPACING, h[k] - h[k - 1])));
}
const length = CLOSED ? r2(distance[N - 1] + Math.hypot(step(N - 1), h[0] - h[N - 1])) : distance[N - 1];
const seamStep = CLOSED ? { plan: r2(step(N - 1)), height: r2(h[0] - h[N - 1]) } : null;

// ---------- cross-check vs bacinger/f1-circuits ----------
const bac: P[] = bacinger.features[0].geometry.coordinates.map(([lon, lat]: number[]) => toLambert(lon, lat));
function distToPolyline(p: P, line: P[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1))); // repeated points: no NaN
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}
const offs = plan.map((p) => distToPolyline(p, bac)).sort((a, b) => a - b);
const q = (f: number) => offs[Math.floor(f * (offs.length - 1))].toFixed(1);
const offsetNote = `OSM vs bacinger/f1-circuits ${CFG.bacinger} centerline offset: median ${q(0.5)} m, p95 ${q(0.95)} m, max ${q(1)} m.`;

// Narrowed sections as station ranges in metres, e.g. "212-260 m, 6896-6910 m".
function narrowedRanges(): string {
  const r: [number, number][] = [];
  for (const k of narrowed) {
    const last = r.at(-1);
    if (last && k - last[1] <= 2) last[1] = k;
    else r.push([k, k]);
  }
  return r.map(([a, b]) => `${Math.round(distance[a])}-${Math.round(distance[b])} m`).join(", ");
}

// ---------- write ----------
const out = {
  meta: {
    name: CFG.name,
    elevationSource: RLP ? {
      title: "LVermGeo RLP Digitales Geländemodell DGM1 (1 m, laser scanning)",
      url: "https://geoshop.rlp.de/digitale_gelaendemodelle/digitale_gelaendemodelle_dgm.html",
      service: "https://geobasis-rlp.de/data/dgm1/current/tif/ (1 km GeoTIFF tiles)",
      acquisitionDates: [...new Set(rlpMetas.map((m) => m.acquired))].join(", ") + ` (from each tile's metadata: ${rlpMetas.map((m) => m.name).join(", ")})`,
      resolutionM: 1,
      license: RLP_LICENCE,
      attribution: RLP_ATTRIBUTION(new Date().getFullYear()),
    } : {
      title: "Relief de la Wallonie - Modèle Numérique de Terrain (MNT) 2021-2022",
      url: "https://geoportail.wallonie.be/catalogue/a004e570-99d6-4fe5-b83d-49b774409278.html",
      service: MNT_SERVICE,
      campaign: "SPW LiDAR 2021-2022 (RELIEF_WALLONIE_MNT_50CM_2021_2022)",
      acquisitionDates:
        "Campaign 2021-02-19 to 2022-03-05" + CFG.tileNote,
      resolutionM: CELL,
      license: "CC BY 4.0",
      attribution: "© SPW 2021-2022 — Service public de Wallonie (SPW), Relief de la Wallonie - MNT 2021-2022",
    },
    centerlineSource: {
      title: "OpenStreetMap highway=raceway ways " + WAY_IDS.join(","),
      url: "https://www.openstreetmap.org/ (via Overpass API); © OpenStreetMap contributors, ODbL",
      retrieved: `OSM data as of ${osmStamp}`,
    },
    sourceCrs: CRS,
    heightDatum: RLP ? [...new Set(rlpMetas.map((m) => m.heightDatum))].join(", ") + " (DHHN2016 normal heights)" : "Ostend height (DNG/TAW), EPSG:5710",
    localOrigin: { crs: CRS, easting: r2(origin.e), northing: r2(origin.n), height: r2(origin.h) },
    axes: "X east, Y up, Z south (Z = -(northing - origin.northing)); metres",
    roadWidthM: ROAD_W,
    shoulderWidthM: SHOULDER_W,
    ...(KNOTS ? { widthCorrections: {
      knots: KNOTS,
      units: "[station m, left half-width m, right half-width m] (left/right of travel), linear between knots; elsewhere roadWidthM / 2",
      insideCap: `inside half-width capped at 70% of the local centreline radius on ${widthCapped} sections (the road cannot reach the turn centre)`,
      source: "SPW orthophoto ORTHO_2023_ETE (2023-05-27..06-25, 0.65 m/px, CC BY 4.0): edge = white line / kerb inner edge, not the paved run-off beyond",
      uncertainty: "the knots are photo readings, about +-0.7 m (a dated-image estimate); the final edges are NOT that accurate where the inside cap or smoothing moved them (by up to several metres at the apex): those are geometric approximations",
      authoritative: "centerline.halfWidth (per sample, after the cap and smoothing) is the road boundary every consumer uses; the knots alone do not reproduce it",
    } } : {}),
    crossSlope: "flat (estimated, not measured camber)",
    sampleSpacingM: CLOSED ? Math.round(step(0) * 1000) / 1000 : SPACING,
    ...(repairs.length ? {
      heightRepairs: {
        note: "Interpolated deck estimates where the terrain model has no bridge surface; every other sample is the terrain model's own (bilinear) height.",
        samplesChangedOutsideRepairs: changedOutside,
        deckEndBlend: `final heights within ${BLEND * SPACING} m of each repaired span's ends use a ±${BLEND * SPACING} m average (vertical curve) instead of ±4 m (${blended.length} samples)`,
        spans: repairs.map((r) => ({ kind: r.kind, fromStation: Math.round(distance[nb(r.from, N)]), toStation: Math.round(distance[nb(r.to, N)]), maxCorrectionM: r.maxCorrectionM, samples: r.samples.map((x: any) => ({ station: Math.round(distance[x.i] * 10) / 10, raw: x.raw, repaired: x.repaired })) })),
      },
    } : {}),
    ...(CLOSED ? { closed: true } : {}),
    heightSmoothing:
      "Centerline height = bilinear DTM sample, then 5-sample (±4 m) moving average along distance. " +
      "Plan line: OSM nodes resampled at 1 m and smoothed with a ±4 m moving average before resampling at 2 m. " +
      "Shoulder outer edge = raw bilinear DTM.",
    notes: [
      CLOSED
        ? `Closed loop starting at ${RLP ? `the first member way of OSM relation ${RELATION}` : "the Bus Stop chicane exit"}; the last cross-section joins the first (seam step ${seamStep!.plan} m in plan, ${seamStep!.height} m in height).`
        : `Starts ${CFG.runUp} m before the La Source braking point on the pit straight; ends at the start of OSM way 'Les Combes' (turn-in), so the whole Kemmel braking zone is included.`,
      `Road width ${ROAD_W} m is an assumption (FIA minimum for new permanent circuits); the real width varies along the circuit.`,
      RLP
        ? "DTM read from the official 1 km DGM1 GeoTIFF tiles (bilinear between 1 m cell centres)."
        : "DTM read cell-by-cell through the MapServer identify operation (raw 0.5 m cell values); SPW offers no bbox GeoTIFF export.",
      bridgeRuns.length
        ? `Bridge decks (OSM bridge=yes; the terrain model excludes bridges): road and shoulder height interpolated linearly between the ground at each end, at stations ${bridgeRuns.map(([a, b]) => `${Math.round(distance[a])}-${Math.round(distance[b])} m`).join(", ")}.`
        : "No bridge decks on this route.",
      ...(dipRuns.length ? [`Unmarked structures (the DGM removes bridges also where the road below carries the tag): road profile pits more than ${DIP_M} m below the chord over up to ${DIP_SPAN * 2 * SPACING} m bridged linearly, deck and shoulders, at stations ${dipRuns.map(([a, b]) => `${Math.round(distance[a])}-${Math.round(distance[b])} m`).join(", ")}.`] : []),
      offsetNote,
      `Inside shoulder narrowed to 70% of local turn radius on ${narrowed.length} sections (${CLOSED ? `stations ${narrowedRanges()}` : "La Source hairpin"}) so it does not cross itself; ${folds} triangles fold over in plan view.`,
    ],
  },
  positions,
  indices: [...road, ...shoulder],
  groups: [
    { name: "road", start: 0, count: road.length },
    { name: "shoulder", start: road.length, count: shoulder.length },
  ],
  centerline: {
    ...(CLOSED ? { points: centerPts, distance, closed: true, length } : { points: centerPts, distance }),
    // Per-sample road half-widths [left, right] where the circuit has local width corrections.
    ...(KNOTS ? { halfWidth: halfW.flatMap(([l, r]) => [r2(l), r2(r)]) } : {}),
  },
};
await Bun.write(OUT, JSON.stringify(out));

const size = Bun.file(OUT).size;
console.log(`wrote ${OUT}: ${(size / 1024).toFixed(0)} KB, ${positions.length / 3} vertices, ${(road.length + shoulder.length) / 3} triangles, ${N} sections, length ${length} m`);
console.log(offsetNote, `folds: ${folds}`);
