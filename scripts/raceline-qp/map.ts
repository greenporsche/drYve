// Map a dense QP racing line (mincurv.py output: dense_x, dense_z) onto the lap's 2 m centreline
// samples as lateral offsets n (m, + = left of travel): each sample's normal is intersected with the
// dense polyline, walking forward from the previous hit. Writes the n array as JSON.
// Usage: bun map.ts <circuit>-lap.json <qp.json> <out-n.json>
const [lapFile, qpFile, outFile] = process.argv.slice(2);
const track = await Bun.file(lapFile).json();
const qp = await Bun.file(qpFile).json();
const c: number[] = track.centerline.points, N = track.centerline.distance.length, hw: number[] = track.centerline.halfWidth;
const w = (i: number) => ((i % N) + N) % N;
const nx = new Float64Array(N), nz = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const a = w(i - 1), b = w(i + 1), tx = c[b * 3] - c[a * 3], tz = c[b * 3 + 2] - c[a * 3 + 2], l = Math.hypot(tx, tz) || 1;
  nx[i] = tz / l; nz[i] = -tx / l; // left of travel, as in raceline.ts
}
const QX: number[] = qp.dense_x, QZ: number[] = qp.dense_z, M = QX.length;
let j0 = 0;
{ let best = Infinity; for (let j = 0; j < M; j++) { const d = Math.hypot(QX[j] - c[0], QZ[j] - c[2]); if (d < best) (best = d), (j0 = j); } }
const n = new Float64Array(N);
let missing = 0;
for (let i = 0; i < N; i++) {
  const px = c[i * 3], pz = c[i * 3 + 2];
  let hit = NaN, hj = j0, bestK = Infinity;
  for (let k = -60; k < 120; k++) {
    const a = (((j0 + k) % M) + M) % M, b = (a + 1) % M;
    const ex = QX[b] - QX[a], ez = QZ[b] - QZ[a], det = nx[i] * -ez - nz[i] * -ex;
    if (Math.abs(det) < 1e-12) continue;
    const rx = QX[a] - px, rz = QZ[a] - pz, t = (rx * -ez - rz * -ex) / det, u = (nx[i] * rz - nz[i] * rx) / det;
    if (u >= 0 && u <= 1 && Math.abs(t) < 15 && Math.abs(k) < bestK) (hit = t), (hj = a), (bestK = Math.abs(k));
  }
  if (Number.isNaN(hit)) (missing++, (hit = n[w(i - 1)]));
  else j0 = hj;
  n[i] = hit;
}
let minClr = Infinity, at = 0;
for (let i = 0; i < N; i++) { const cl = Math.min(hw[i * 2] - n[i], hw[i * 2 + 1] + n[i]); if (cl < minClr) (minClr = cl), (at = track.centerline.distance[i]); }
console.log(`${N} samples, ${missing} without an intersection, minimum road-edge clearance ${minClr.toFixed(2)} m at ${at.toFixed(0)} m`);
await Bun.write(outFile, JSON.stringify(Array.from(n)));
