// Best-lap replay (F4, PO #209/#213, EM #215, PM #216): the player's car recorded through each timed
// lap, and the fastest clean lap the player drove (from the grid or flying, PO #229) played back on the
// ghost car in step with the player's lap clock. A recording is the car's pose against lap time, sampled on the fixed physics step (simulation
// time, so pause and frame rate don't change it); playback interpolates between samples.

export const SAMPLE_STEPS = 4; // one sample every 4 fixed steps of 1/120 s: 30 a second
const STRIDE = 9; // per sample: lap time, x, y, z, rotation (x, y, z, w), lap station
// Rounding when kept: 1 ms, 1 cm, 4 decimals of rotation, 10 cm of station (about 200 KB a lap).
const PLACES = [3, 2, 2, 2, 4, 4, 4, 4, 1];

export interface Recording {
  lap: number; // its lap time, s
  samples: number[]; // STRIDE numbers per sample, in lap-time order
}

type Vec = { x: number; y: number; z: number };
type Quat = Vec & { w: number };

// The lap in progress, sample by sample.
export class LapRecorder {
  private buf: number[] = [];
  get empty() {
    return this.buf.length === 0;
  }
  reset() {
    this.buf = [];
  }
  sample(t: number, p: Vec, q: Quat, station: number) {
    this.buf.push(t, p.x, p.y, p.z, q.x, q.y, q.z, q.w, station);
  }
  // The finished lap as a recording to keep.
  take(lap: number): Recording {
    const f = PLACES.map((d) => 10 ** d);
    return { lap, samples: this.buf.map((v, i) => Math.round(v * f[i % STRIDE]) / f[i % STRIDE]) };
  }
}

export function parseRecording(json: string | null): Recording | null {
  try {
    const r = JSON.parse(json ?? 'null');
    return r && typeof r.lap === 'number' && Array.isArray(r.samples) && r.samples.length >= STRIDE * 2 ? r : null;
  } catch {
    return null;
  }
}

// The recorded pose at lap time t (held at the first and last samples outside the lap): position and
// rotation written into `pos` and `quat`. Returns the lap station there, on a circuit `length` m long,
// and the speed between the samples it blends (0 where it is held), for turning the wheels.
const at = { station: 0, speed: 0 };
export function poseAt(rec: Recording, t: number, pos: { set(x: number, y: number, z: number): unknown }, quat: { set(x: number, y: number, z: number, w: number): unknown }, length: number): Readonly<typeof at> {
  const s = rec.samples, n = s.length / STRIDE;
  let lo = 0, hi = n - 1;
  if (t <= s[0]) hi = 0;
  else if (t >= s[(n - 1) * STRIDE]) lo = hi = n - 1;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid * STRIDE] <= t) lo = mid;
      else hi = mid;
    }
  }
  const a = lo * STRIDE, b = hi * STRIDE;
  const span = s[b] - s[a];
  const k = span > 0 ? (t - s[a]) / span : 0;
  const mix = (o: number) => s[a + o] + (s[b + o] - s[a + o]) * k;
  pos.set(mix(1), mix(2), mix(3));
  // Rotation: normalised blend along the shorter way round (samples 1/30 s apart turn only a little).
  const sign = s[a + 4] * s[b + 4] + s[a + 5] * s[b + 5] + s[a + 6] * s[b + 6] + s[a + 7] * s[b + 7] < 0 ? -1 : 1;
  const qx = s[a + 4] + (sign * s[b + 4] - s[a + 4]) * k, qy = s[a + 5] + (sign * s[b + 5] - s[a + 5]) * k;
  const qz = s[a + 6] + (sign * s[b + 6] - s[a + 6]) * k, qw = s[a + 7] + (sign * s[b + 7] - s[a + 7]) * k;
  const len = Math.hypot(qx, qy, qz, qw) || 1;
  quat.set(qx / len, qy / len, qz / len, qw / len);
  // Station runs round the circuit and starts again at 0 part way through a lap (on Spa 225 m before
  // the control line): blend the short way round, as for the rotation (EM #223).
  let d = s[b + 8] - s[a + 8];
  if (d > length / 2) d -= length;
  else if (d < -length / 2) d += length;
  at.station = (((s[a + 8] + d * k) % length) + length) % length;
  at.speed = span > 0 ? Math.hypot(s[b + 1] - s[a + 1], s[b + 2] - s[a + 2], s[b + 3] - s[a + 3]) / span : 0;
  return at;
}
