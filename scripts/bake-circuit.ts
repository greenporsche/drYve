// Circuit teaching data for circuits without hand-surveyed corner tables (Spa's is hand-made in
// public/data/spa-circuit.json). Run after the road bake:
//   bun scripts/bake-circuit.ts nurburgring-gp   -> public/data/nurburgring-gp-circuit.json
//
// Stations are metres along the baked lap centerline. Corners are found from curvature (heading change
// over +-16 m), numbered in race order from the control line, and named after the OSM way they sit on
// where OSM names one, unless the circuit config lists a published track guide's numbers and names. The control (start/finish) line is
// the first point of the independent bacinger/f1-circuits centerline, which starts on the line;
// sectors split the lap into approximate thirds (official sector points not sourced).
import proj4 from "proj4";

const ID = process.argv[2] ?? "nurburgring-gp";
// `guide`: published track-guide turn numbers and names, one per detected corner in race order (a
// detected corner can span two official turns, e.g. "8-9"). Checked against the OSM-named corners
// (Ford-Kurve, Michael-Schumacher-S, the chicane) so the detected order lines up with the guide's.
type Guide = { source: string; turns: [string, string][] };
const CFG: Record<string, { name: string; short: string; bacinger: string; osm: string; roadWidth: number; trackLimit: number; guide?: Guide }> = {
  "nurburgring-gp": {
    name: "Nürburgring Grand Prix circuit",
    short: "Nürburgring GP",
    bacinger: "de-1927",
    osm: "osm-nurburgring-gp-rel.json",
    roadWidth: 12,
    trackLimit: 7.2,
    // Coach Dave Academy, "Nürburgring Grand Prix Circuit track guide" (15 turns); Veedol- and
    // Dunlop- names as on German Wikipedia's Nürburgring article (sponsor names change: OSM has
    // Goodyear-Kehre and NGK-Schikane). Official T12, a fast left kink, isn't a detected corner.
    guide: {
      source: "Coach Dave Academy Nürburgring GP track guide; German Wikipedia (Nürburgring)",
      turns: [
        ["1", "Castrol-S"], ["2", "Mercedes-Arena"], ["3", "Mercedes-Arena"], ["4", "Mercedes-Arena"],
        ["5", "Valvoline-Kurve"], ["6", "Ford-Kurve"], ["7", "Dunlop-Kehre"], ["8", "Michael-Schumacher-S"],
        ["10", "Kumho-Kurve"], ["11", "Bit-Kurve"], ["13", "Veedol-Schikane"], ["14", "Veedol-Schikane"], ["15", "Coca-Cola-Kurve"],
      ],
    },
  },
};
const cfg = CFG[ID];
if (!cfg) throw new Error(`unknown circuit ${ID}`);
proj4.defs("EPSG:25832", "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");

const lap = JSON.parse(await Bun.file(`public/data/${ID}-lap.json`).text());
const o = lap.meta.localOrigin, pts: number[] = lap.centerline.points, dist: number[] = lap.centerline.distance, N = dist.length;
const L: number = lap.centerline.length;
const crs: string = lap.meta.sourceCrs;
const local = (lon: number, lat: number) => {
  const [e, n] = proj4("EPSG:4326", crs, [lon, lat]) as [number, number];
  return [e - o.easting, -(n - o.northing)];
};
const nearest = (x: number, z: number) => {
  let best = Infinity, k = 0;
  for (let i = 0; i < N; i++) {
    const d = Math.hypot(pts[i * 3] - x, pts[i * 3 + 2] - z);
    if (d < best) (best = d), (k = i);
  }
  return { k, d: best };
};
const wrapSt = (s: number) => ((s % L) + L) % L;

// Control line from the bacinger centerline's first point.
const bac = JSON.parse(await Bun.file(`data/raw/bacinger-${cfg.bacinger}.geojson`).text()).features[0].geometry.coordinates;
const sf = nearest(...(local(bac[0][0], bac[0][1]) as [number, number]));
const CONTROL = Math.round(dist[sf.k]);
// The grid forms up just after the control line, as at Spa (so a standing start begins lap 1 there);
// the real GP grid position relative to the line is not sourced.
const START_AHEAD = 100;

// Corners from curvature.
const head = (i: number) => {
  const a = (i - 3 + N) % N, b = (i + 3) % N;
  return Math.atan2(pts[b * 3] - pts[a * 3], pts[b * 3 + 2] - pts[a * 3 + 2]);
};
const curv = Array.from({ length: N }, (_, i) => {
  const d = head((i + 4) % N) - head((i - 4 + N) % N);
  return Math.atan2(Math.sin(d), Math.cos(d)) / 16;
});
const corners: { in: number; out: number; mid: number }[] = [];
let inTurn = false, start = 0;
for (let j = 0; j < N + 50; j++) {
  const i = j % N, c = Math.abs(curv[i]);
  if (!inTurn && c > 0.012 && j < N) (inTurn = true), (start = j);
  if (inTurn && c < 0.006) {
    inTurn = false;
    if (j - start > 3) corners.push({ in: dist[start % N], out: dist[i], mid: dist[Math.floor((start + j) / 2) % N] });
  }
}

// Names from the OSM ways they sit on.
const osm = JSON.parse(await Bun.file(`data/raw/${cfg.osm}`).text());
const named = osm.elements.filter((e: any) => e.type === "way" && e.tags?.name && !/anbindung|strecke/i.test(e.tags.name));
function nameAt(st: number): string {
  const k = dist.findIndex((d) => d >= st);
  const x = pts[k * 3], z = pts[k * 3 + 2];
  for (const w of named) for (const g of w.geometry) {
    const [gx, gz] = local(g.lon, g.lat);
    if (Math.hypot(gx - x, gz - z) < 15) return w.tags.name;
  }
  return "";
}
// Race order from the control line.
corners.sort((a, b) => wrapSt(a.in - CONTROL) - wrapSt(b.in - CONTROL));
if (cfg.guide && cfg.guide.turns.length !== corners.length) throw new Error(`guide lists ${cfg.guide.turns.length} turns, detected ${corners.length}`);
const turns = corners.map((c, i) => {
  const g = cfg.guide?.turns[i];
  return { n: g ? Number(g[0]) : i + 1, name: g ? g[1] : nameAt(c.mid), osmName: nameAt(c.mid) || undefined, in: Math.round(c.in), out: Math.round(c.out) };
});

const out = {
  id: ID,
  name: cfg.name,
  short: cfg.short,
  turns,
  controlLine: CONTROL,
  startLine: Math.round(wrapSt(CONTROL + START_AHEAD)),
  sectorLines: [CONTROL, Math.round(wrapSt(CONTROL + L / 3)), Math.round(wrapSt(CONTROL + (2 * L) / 3))],
  calloutLead: 150,
  roadWidth: cfg.roadWidth,
  trackLimit: cfg.trackLimit,
  notes: [
    cfg.guide
      ? `Corners found from centerline curvature (${turns.length}); numbers and names from ${cfg.guide.source} (not an FIA document), matched in race order; osmName is the OSM way name where one exists.`
      : `Corners found from centerline curvature (${turns.length}), numbered in race order from the control line and named after the OSM way they sit on where it has a name; not the official FIA turn numbering.`,
    `Control (start/finish) line at station ${CONTROL} m: first point of the bacinger/f1-circuits ${cfg.bacinger} centerline (${sf.d.toFixed(1)} m from ours). Start line (grid front) assumed ${START_AHEAD} m after it, so the grid sits past the control line as at Spa.`,
    "Sector lines split the lap into approximate thirds (official sector points not sourced).",
    `Road width ${cfg.roadWidth} m and track limit ${cfg.trackLimit} m from the centerline (car centre) are assumptions, as at Spa; the real width varies.`,
  ],
};
await Bun.write(`public/data/${ID}-circuit.json`, JSON.stringify(out, null, 2));
console.log(`wrote public/data/${ID}-circuit.json: control ${CONTROL} m, ${turns.length} turns`);
for (const t of turns) console.log(` T${t.n} ${t.name || "-"} ${t.in}-${t.out}`);
