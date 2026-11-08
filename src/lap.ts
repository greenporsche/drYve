import type { Track } from './surface';
import { CALLOUT_LEAD, ROAD_WIDTH, SECTOR_LINES, TRACK_LIMIT, TURNS, type Turn } from './circuit';

const mod = (a: number, n: number) => ((a % n) + n) % n;
// Track limits: like F1's all-four-wheels-off rule. The road is 12 m wide and the car ~1.9 m, so the
// car's centre more than 6 + 0.95 + 0.25 m from the centreline means it is fully beyond the white line.
// Where the circuit has local width corrections, the limit on each side is that side's half-width plus
// the same allowance (TRACK_LIMIT - ROAD_WIDTH / 2).

// Where the car is along the lap, and lap/sector timing from crossings of the control and
// sector lines in race direction. Times use simulation seconds.
export class LapTracker {
  readonly length: number;
  station = 0;
  index = 0;
  lap = 0; // 0 = out lap (no timing until the first control-line crossing)
  sector = 0; // 0, 1, 2 while timing
  lapStart = 0;
  sectorStart = 0;
  current: (number | null)[] = [null, null, null]; // this lap's sector times
  last: (number | null)[] = [null, null, null]; // previous completed lap's sector times
  lastLap: number | null = null;
  bestLap: number | null = null; // on-screen bests: any valid lap, the autopilot's included
  bestSectors: (number | null)[] = [null, null, null];
  // The player's own bests, from laps the autopilot did not drive: the ones kept between visits (PO #151).
  ownBestLap: number | null = null;
  ownBestSectors: (number | null)[] = [null, null, null];
  invalid = false; // this lap broke track limits: it is timed but not counted as a best
  assisted = false; // the autopilot drove during this lap: its times can be on-screen bests, not own bests
  lastInvalid = false;
  offTrack = 0; // car centre's distance from the centreline, m
  private pts: Float32Array;
  private dist: number[];
  private halfWidth?: number[];
  private n: number;

  constructor(track: Track) {
    this.pts = track.centerline.points;
    this.dist = track.centerline.distance;
    this.halfWidth = track.centerline.halfWidth;
    this.n = this.dist.length;
    this.length = track.centerline.length ?? this.dist[this.n - 1];
  }

  // Nearest centerline sample, searching a window ahead of the last one; a full search
  // when the car has jumped (reset) or left the window.
  // Nearest centreline sample to (x, z), searched near the current index (no lap-state change).
  locate(x: number, z: number) {
    let best = Infinity, bi = this.index;
    const scan = (i: number) => {
      const d = (x - this.pts[i * 3]) ** 2 + (z - this.pts[i * 3 + 2]) ** 2;
      if (d < best) (best = d), (bi = i);
    };
    for (let j = this.index - 20; j < this.index + 80; j++) scan(mod(j, this.n));
    if (best > 30 * 30) for (let i = 0; i < this.n; i++) scan(i);
    return { index: bi, jumped: best > 30 * 30 || Math.abs(mod(bi - this.index + this.n / 2, this.n) - this.n / 2) > 100 };
  }

  // Track limit (car centre from the centreline) on the side of the centreline the car is on.
  private limitAt(i: number, x: number, z: number) {
    if (!this.halfWidth) return TRACK_LIMIT;
    const a = this.pts, j = mod(i + 1, this.n), k = mod(i - 1, this.n);
    const tx = a[j * 3] - a[k * 3], tz = a[j * 3 + 2] - a[k * 3 + 2];
    // left of travel in X-east/Z-south is (tz, -tx)
    const left = (x - a[i * 3]) * tz - (z - a[i * 3 + 2]) * tx > 0;
    return this.halfWidth[i * 2 + (left ? 0 : 1)] + (TRACK_LIMIT - ROAD_WIDTH / 2);
  }

  update(x: number, z: number, t: number) {
    const { index, jumped } = this.locate(x, z);
    const prev = this.station;
    this.index = index;
    this.station = this.dist[index];
    this.offTrack = Math.hypot(x - this.pts[index * 3], z - this.pts[index * 3 + 2]);
    if (this.lap > 0 && this.offTrack > this.limitAt(index, x, z)) this.invalid = true;
    if (jumped) {
      // A big jump (a cut across the track, or arriving on the grid): the lap no longer counts,
      // but a standing start armed by a grid reset stays armed.
      const armed = this.armed;
      this.voidLap();
      this.armed = armed;
      return;
    }
    let delta = this.station - prev;
    if (delta < -this.length / 2) delta += this.length;
    if (delta <= 0 || delta > this.length / 2) return; // standing still or going backwards
    const crossed = (line: number) => mod(this.station - line, this.length) < mod(prev - line, this.length);
    if (this.armed) {
      this.armed = false;
      this.lap = 1;
      this.sector = 0;
      this.lapStart = this.sectorStart = t;
      this.current = [null, null, null];
      return;
    }

    if (crossed(SECTOR_LINES[0])) {
      if (this.lap > 0 && this.sector === 2) {
        this.finishSector(t);
        const lapTime = t - this.lapStart;
        this.lastLap = lapTime;
        this.lastInvalid = this.invalid;
        if (!this.invalid && (this.bestLap === null || lapTime < this.bestLap)) this.bestLap = lapTime;
        if (!this.invalid && !this.assisted && (this.ownBestLap === null || lapTime < this.ownBestLap)) this.ownBestLap = lapTime;
        this.last = this.current;
      }
      this.invalid = false;
      this.assisted = false;
      this.lap++;
      this.sector = 0;
      this.lapStart = this.sectorStart = t;
      this.current = [null, null, null];
    } else if (this.lap > 0) {
      const next = this.sector + 1;
      if (next < 3 && crossed(SECTOR_LINES[next])) {
        this.finishSector(t);
        this.sector = next;
        this.sectorStart = t;
      }
    }
  }

  // The lap no longer counts (car reset or cut). Timing restarts at the next control-line crossing.
  voidLap() {
    this.lap = 0;
    this.sector = 0;
    this.current = [null, null, null];
    this.armed = false;
    this.invalid = false;
    this.assisted = false;
  }

  // On the grid: like a real race, lap 1 is timed from the moment the car moves off the grid
  // (behind the start line) to the control line, so it is a little shorter than a full lap.
  armStandingStart() {
    this.voidLap();
    this.armed = true;
  }
  private armed = false;

  private finishSector(t: number) {
    const s = t - this.sectorStart;
    this.current[this.sector] = s;
    const b = this.bestSectors[this.sector];
    if (!this.invalid && (b === null || s < b)) this.bestSectors[this.sector] = s;
    const o = this.ownBestSectors[this.sector];
    if (!this.invalid && !this.assisted && (o === null || s < o)) this.ownBestSectors[this.sector] = s;
  }

  // The turn being approached or driven: from CALLOUT_LEAD metres before turn-in to its exit.
  // When windows overlap (chicanes), the one whose exit comes first wins.
  activeTurn(): Turn | null {
    let best: Turn | null = null, bestLeft = Infinity;
    for (const turn of TURNS) {
      const start = turn.in - CALLOUT_LEAD;
      if (mod(this.station - start, this.length) > mod(turn.out - start, this.length)) continue;
      const left = mod(turn.out - this.station, this.length);
      if (left < bestLeft) (best = turn), (bestLeft = left);
    }
    return best;
  }
}

export function formatTime(s: number | null): string {
  if (s === null) return '–';
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(3).padStart(6, '0');
  return m > 0 ? `${m}:${rest}` : (s).toFixed(3);
}
