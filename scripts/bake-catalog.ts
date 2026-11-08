// Landing-page circuit catalog (S10.1, PO #21273): one record per circuit with an SVG outline path.
// Roster (PM #21285): the 2026 F1 calendar as formula1.com/en/racing/2026 lists it (23 rounds, read
// 2026-11-08; round 16 "Bahrain Grand Prix in Malaysia" is held at Sepang, round 14 the Spanish GP at
// Madring, Madrid, per their event pages), plus the Nürburgring GP. Playable circuits draw their outline
// from our own baked centerline, so it matches the drive; the rest from bacinger/f1-circuits
// (MIT, https://github.com/bacinger/f1-circuits), downloaded to data/raw/f1-circuits.geojson.
// Every outline keeps its true aspect ratio (equirectangular around the circuit's mean latitude,
// north up) and is fitted into a 100-unit box.
// Usage: bun scripts/bake-catalog.ts  ->  public/data/catalog.json
import { readFileSync, writeFileSync } from 'node:fs';
import { sampleAt, sectorMid, sectorRuns } from '../src/sectors';

type Entry = { id: string; source: string; name: string; city: string; country: string; flag: string; round?: number; playable?: string };
const ROSTER: Entry[] = [
  { id: 'spa', source: 'be-1925', name: 'Spa-Francorchamps', city: 'Francorchamps', country: 'Belgium', flag: '🇧🇪', round: 10, playable: 'spa' },
  { id: 'nurburgring-gp', source: 'de-1927', name: 'Nürburgring GP', city: 'Nürburg', country: 'Germany', flag: '🇩🇪', playable: 'nurburgring-gp' },
  { id: 'albert-park', source: 'au-1953', name: 'Albert Park', city: 'Melbourne', country: 'Australia', flag: '🇦🇺', round: 1 },
  { id: 'shanghai', source: 'cn-2004', name: 'Shanghai International Circuit', city: 'Shanghai', country: 'China', flag: '🇨🇳', round: 2 },
  { id: 'suzuka', source: 'jp-1962', name: 'Suzuka', city: 'Suzuka', country: 'Japan', flag: '🇯🇵', round: 3 },
  { id: 'miami', source: 'us-2022', name: 'Miami International Autodrome', city: 'Miami', country: 'United States', flag: '🇺🇸', round: 4 },
  { id: 'montreal', source: 'ca-1978', name: 'Circuit Gilles-Villeneuve', city: 'Montréal', country: 'Canada', flag: '🇨🇦', round: 5 },
  { id: 'monaco', source: 'mc-1929', name: 'Circuit de Monaco', city: 'Monaco', country: 'Monaco', flag: '🇲🇨', round: 6 },
  { id: 'barcelona', source: 'es-1991', name: 'Circuit de Barcelona-Catalunya', city: 'Barcelona', country: 'Spain', flag: '🇪🇸', round: 7 },
  { id: 'red-bull-ring', source: 'at-1969', name: 'Red Bull Ring', city: 'Spielberg', country: 'Austria', flag: '🇦🇹', round: 8 },
  { id: 'silverstone', source: 'gb-1948', name: 'Silverstone', city: 'Silverstone', country: 'Great Britain', flag: '🇬🇧', round: 9 },
  { id: 'hungaroring', source: 'hu-1986', name: 'Hungaroring', city: 'Budapest', country: 'Hungary', flag: '🇭🇺', round: 11 },
  { id: 'zandvoort', source: 'nl-1948', name: 'Zandvoort', city: 'Zandvoort', country: 'Netherlands', flag: '🇳🇱', round: 12 },
  { id: 'monza', source: 'it-1922', name: 'Monza', city: 'Monza', country: 'Italy', flag: '🇮🇹', round: 13 },
  { id: 'madring', source: 'es-2026', name: 'Madring', city: 'Madrid', country: 'Spain', flag: '🇪🇸', round: 14 },
  { id: 'baku', source: 'az-2016', name: 'Baku City Circuit', city: 'Baku', country: 'Azerbaijan', flag: '🇦🇿', round: 15 },
  { id: 'sepang', source: 'my-1999', name: 'Sepang International Circuit', city: 'Sepang', country: 'Malaysia', flag: '🇲🇾', round: 16 },
  { id: 'marina-bay', source: 'sg-2008', name: 'Marina Bay', city: 'Singapore', country: 'Singapore', flag: '🇸🇬', round: 17 },
  { id: 'austin', source: 'us-2012', name: 'Circuit of the Americas', city: 'Austin', country: 'United States', flag: '🇺🇸', round: 18 },
  { id: 'mexico-city', source: 'mx-1962', name: 'Autódromo Hermanos Rodríguez', city: 'Mexico City', country: 'Mexico', flag: '🇲🇽', round: 19 },
  { id: 'interlagos', source: 'br-1940', name: 'Interlagos', city: 'São Paulo', country: 'Brazil', flag: '🇧🇷', round: 20 },
  { id: 'las-vegas', source: 'us-2023', name: 'Las Vegas Strip Circuit', city: 'Las Vegas', country: 'United States', flag: '🇺🇸', round: 21 },
  { id: 'lusail', source: 'qa-2004', name: 'Lusail International Circuit', city: 'Lusail', country: 'Qatar', flag: '🇶🇦', round: 22 },
  { id: 'yas-marina', source: 'ae-2009', name: 'Yas Marina', city: 'Abu Dhabi', country: 'United Arab Emirates', flag: '🇦🇪', round: 23 },
];

const BOX = 100; // outline fitted into a BOX x BOX square, aspect kept
const geo = JSON.parse(readFileSync(new URL('../data/raw/f1-circuits.geojson', import.meta.url), 'utf8'));
const byId = new Map<string, number[][]>(geo.features.map((f: { properties: { id: string }; geometry: { coordinates: number[][] } }) => [f.properties.id, f.geometry.coordinates]));

// Points in metres-like units, x east, y south (SVG down).
function fromLonLat(coords: number[][]): [number, number][] {
  const lat0 = (coords.reduce((s, c) => s + c[1], 0) / coords.length) * (Math.PI / 180);
  return coords.map(([lon, lat]) => [lon * Math.cos(lat0) * 111320, -lat * 110574]);
}
function fromBaked(id: string): [number, number][] {
  const lap = JSON.parse(readFileSync(new URL(`../public/data/${id}-lap.json`, import.meta.url), 'utf8'));
  const p: number[] = lap.centerline.points, out: [number, number][] = [];
  for (let i = 0; i < p.length; i += 3 * 4) out.push([p[i], p[i + 2]]); // every 4th 2 m sample; local X east, Z south
  return out;
}
// Inset so sector labels beside the outline stay inside the box.
const INSET = 6;
function fit(pts: [number, number][]) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys), w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
  const s = (BOX - 2 * INSET) / Math.max(w, h), ox = (BOX - w * s) / 2, oy = (BOX - h * s) / 2;
  const map = ([x, y]: [number, number]): [number, number] => [+(ox + (x - minX) * s).toFixed(1), +(oy + (y - minY) * s).toFixed(1)];
  const path = (p: [number, number][], close: boolean) => p.map((q, i) => `${i ? 'L' : 'M'}${map(q).join(' ')}`).join('') + (close ? 'Z' : '');
  return { d: path(pts, true), aspect: +(w / h).toFixed(3), map, path };
}

// Playable circuits: the outline split into the three timing sectors (src/sectors.ts, the stations in
// <id>-circuit.json the lap timing uses), each sector's label position beside its middle (outside the
// loop) and the start/finish bar at the control line, all in the outline's box.
function sectors(id: string, f: ReturnType<typeof fit>) {
  const lap = JSON.parse(readFileSync(new URL(`../public/data/${id}-lap.json`, import.meta.url), 'utf8')).centerline;
  const circuit = JSON.parse(readFileSync(new URL(`../public/data/${id}-circuit.json`, import.meta.url), 'utf8'));
  const p: number[] = lap.points, L: number = lap.length, lines: number[] = circuit.sectorLines;
  const pt = (i: number): [number, number] => [p[i * 3], p[i * 3 + 2]];
  const n = lap.distance.length;
  const runs = sectorRuns(lap.distance, lines, L, !!lap.closed, 4).map((r) => ({ sector: r.sector, d: f.path(r.indices.map(pt), false) }));
  const dir = (i: number) => { const a = f.map(pt((i - 2 + n) % n)), b = f.map(pt((i + 2) % n)), l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const labels = [0, 1, 2].map((k) => {
    const i = sampleAt(lap.distance, sectorMid(k, lines, L), L), [x, y] = f.map(pt(i)), [tx, ty] = dir(i);
    let nx = -ty, ny = tx;
    if (nx * (x - BOX / 2) + ny * (y - BOX / 2) < 0) (nx = -nx), (ny = -ny);
    const c = (v: number) => +Math.min(BOX - 4, Math.max(4, v)).toFixed(1);
    return { text: `S${k + 1}`, x: c(x + nx * 7), y: c(y + ny * 7) };
  });
  const s0 = sampleAt(lap.distance, lines[0], L), [sx, sy] = f.map(pt(s0)), [tx, ty] = dir(s0);
  const start = [sx - ty * 4, sy + tx * 4, sx + ty * 4, sy - tx * 4].map((v) => +v.toFixed(1));
  return { runs, labels, start, estimated: !!circuit.sectorsEstimated };
}

const circuits = ROSTER.map((e) => {
  const pts = e.playable ? fromBaked(e.playable) : fromLonLat(byId.get(e.source) ?? (() => { throw new Error(`no outline for ${e.source}`); })());
  const f = fit(pts);
  return { id: e.id, name: e.name, city: e.city, country: e.country, flag: e.flag, round: e.round ?? null, playable: e.playable ?? null, outline: e.playable ? 'baked centerline' : 'bacinger/f1-circuits', aspect: f.aspect, d: f.d, sectors: e.playable ? sectors(e.playable, f) : null };
});
writeFileSync(new URL('../public/data/catalog.json', import.meta.url), JSON.stringify({
  box: BOX,
  calendar: { season: 2026, source: 'https://www.formula1.com/en/racing/2026', read: '2026-11-08', rounds: 23 },
  attribution: 'Circuit outlines: bacinger/f1-circuits (MIT); Spa and Nürburgring GP from this site\'s own survey-based centerlines.',
  circuits,
}));
console.log(`catalog: ${circuits.length} circuits (${circuits.filter((c) => c.playable).length} playable)`);
