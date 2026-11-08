// The lap's three timing sectors along the baked centerline (S10.2, PO #21275, EM #21286): one helper for
// the in-game map and the landing page's playable outlines (scripts/bake-catalog.ts), driven by the same
// sector stations the lap timing uses (circuit.json sectorLines; sector 1 starts at the control line).
// Sector k runs from lines[k] up to lines[k + 1], the last one wrapping round to lines[0].
export const SECTOR_COLOURS = ['#3b8bff', '#ffd23f', '#ff3b30']; // S1 blue, S2 yellow, S3 red

// Which sector (0, 1, 2) station s is in, on a lap of the given length.
export function sectorAt(s: number, lines: number[], length: number) {
  const rel = (x: number) => (((x - lines[0]) % length) + length) % length;
  const r = rel(s);
  return r < rel(lines[1]) ? 0 : r < rel(lines[2]) ? 1 : 2;
}

// The centerline sample indices split into consecutive runs by sector, in lap order from sample 0.
// Each run also takes the next run's first sample, so the drawn pieces join; on a closed lap the last
// run ends back at sample 0. `step` thins the samples (every step-th one; boundaries are kept).
export function sectorRuns(distance: number[], lines: number[], length: number, closed: boolean, step = 1) {
  const n = distance.length;
  const sec = distance.map((d) => sectorAt(d, lines, length));
  const runs: { sector: number; indices: number[] }[] = [{ sector: sec[0], indices: [0] }];
  for (let i = 1; i < n; i++) {
    const cur = runs[runs.length - 1];
    if (sec[i] !== cur.sector) {
      cur.indices.push(i); // the boundary sample ends this run and starts the next
      runs.push({ sector: sec[i], indices: [i] });
    } else if (i % step === 0 || i === n - 1 || sec[i + 1] !== sec[i]) cur.indices.push(i);
  }
  if (closed) runs[runs.length - 1].indices.push(0); // back to the start of the lap
  return runs;
}

// The sample nearest a station (for the start/finish mark and the sector labels).
export function sampleAt(distance: number[], s: number, length: number) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < distance.length; i++) {
    const d = Math.abs((((distance[i] - s) % length) + length * 1.5) % length - length / 2);
    if (d < bestD) (bestD = d), (best = i);
  }
  return best;
}

// Station halfway through sector k (for its label).
export function sectorMid(k: number, lines: number[], length: number) {
  const a = lines[k], b = lines[(k + 1) % 3];
  const span = ((((b - a) % length) + length) % length) || length;
  return (a + span / 2) % length;
}
