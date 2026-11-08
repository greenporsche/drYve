// Inset track map: the baked centerline's X/Z with the car's X/Z through one shared transform.
// Local axes are X east, Z south, so canvas x = X and canvas y = Z puts north at the top.
// Sectors (S10.2, PO #21275): the line is drawn in the three sector colours from the timing stations,
// with S1/S2/S3 labels beside each sector's middle and a start/finish bar at the control line.
import { SECTOR_COLOURS, sampleAt, sectorMid, sectorRuns } from './sectors';

const SIZE = 112; // CSS px
const PAD = 10;

export interface MapSectors {
  distance: number[];
  lines: number[]; // sector start stations; lines[0] is the control line
  length: number;
  estimated?: boolean; // estimated split (not official points): a short caption on the map says so
}

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private toMap: (x: number, z: number) => [number, number];
  private track: Path2D;
  private sectors: { colour: string; path: Path2D }[] = [];
  private labels: { text: string; colour: string; x: number; y: number }[] = [];
  private start: [number, number, number, number] | null = null;
  private caption = '';

  constructor(canvas: HTMLCanvasElement, points: ArrayLike<number>, closed = false, sectors?: MapSectors) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = SIZE * dpr;
    canvas.style.width = canvas.style.height = `${SIZE}px`;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
      minZ = Math.min(minZ, points[i + 2]); maxZ = Math.max(maxZ, points[i + 2]);
    }
    const scale = (SIZE - PAD * 2) / Math.max(maxX - minX, maxZ - minZ);
    const ox = (SIZE - (maxX - minX) * scale) / 2;
    const oz = (SIZE - (maxZ - minZ) * scale) / 2;
    this.toMap = (x, z) => [ox + (x - minX) * scale, oz + (z - minZ) * scale];
    const at = (i: number) => this.toMap(points[i * 3], points[i * 3 + 2]);

    this.track = new Path2D();
    for (let i = 0; i < points.length; i += 3) {
      const [mx, my] = this.toMap(points[i], points[i + 2]);
      if (i === 0) this.track.moveTo(mx, my);
      else this.track.lineTo(mx, my);
    }
    if (closed) this.track.closePath();
    if (!sectors) return;

    const { distance, lines, length } = sectors;
    if (sectors.estimated) this.caption = 'SECTORS EST.';
    for (const run of sectorRuns(distance, lines, length, closed)) {
      const path = new Path2D();
      run.indices.forEach((i, k) => (k ? path.lineTo(...at(i)) : path.moveTo(...at(i))));
      this.sectors.push({ colour: SECTOR_COLOURS[run.sector], path });
    }
    // Direction along the line at sample i, and its left normal, in map px.
    const n = distance.length;
    const tangent = (i: number) => {
      const [ax, ay] = at((i - 1 + n) % n), [bx, by] = at((i + 1) % n), l = Math.hypot(bx - ax, by - ay) || 1;
      return [(bx - ax) / l, (by - ay) / l];
    };
    const c0 = SIZE / 2;
    for (let k = 0; k < 3; k++) {
      const i = sampleAt(distance, sectorMid(k, lines, length), length);
      const [px, py] = at(i), [tx, ty] = tangent(i);
      // Beside the line, on the side away from the map's centre.
      let nx = -ty, ny = tx;
      if (nx * (px - c0) + ny * (py - c0) < 0) (nx = -nx), (ny = -ny);
      const x = Math.min(SIZE - 9, Math.max(9, px + nx * 9)), y = Math.min(SIZE - 6, Math.max(6, py + ny * 9));
      this.labels.push({ text: `S${k + 1}`, colour: SECTOR_COLOURS[k], x, y });
    }
    const s = sampleAt(distance, lines[0], length);
    const [sx, sy] = at(s), [tx, ty] = tangent(s);
    this.start = [sx - ty * 6, sy + tx * 6, sx + ty * 6, sy - tx * 6];
  }

  draw(carX: number, carZ: number) {
    const c = this.ctx;
    c.clearRect(0, 0, SIZE, SIZE);
    c.lineJoin = c.lineCap = 'round';
    c.strokeStyle = '#000a';
    c.lineWidth = 6;
    c.stroke(this.track);
    if (this.sectors.length) {
      c.lineWidth = 3;
      for (const s of this.sectors) {
        c.strokeStyle = s.colour;
        c.stroke(s.path);
      }
    } else {
      c.strokeStyle = '#fff';
      c.lineWidth = 3;
      c.stroke(this.track);
    }
    if (this.start) {
      const [x1, y1, x2, y2] = this.start;
      c.lineCap = 'butt';
      c.strokeStyle = '#000';
      c.lineWidth = 4;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      c.strokeStyle = '#fff';
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      c.lineCap = 'round';
    }
    c.font = '800 9px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 3;
    c.strokeStyle = '#000c';
    for (const l of this.labels) {
      c.strokeText(l.text, l.x, l.y);
      c.fillStyle = l.colour;
      c.fillText(l.text, l.x, l.y);
    }
    if (this.caption) {
      c.font = '700 8px system-ui, sans-serif';
      c.textAlign = 'right';
      c.textBaseline = 'bottom';
      c.strokeStyle = '#000c';
      c.lineWidth = 3;
      c.strokeText(this.caption, SIZE - 2, SIZE - 1);
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.fillText(this.caption, SIZE - 2, SIZE - 1);
    }
    const [x, y] = this.toMap(carX, carZ);
    c.fillStyle = '#e10600';
    c.strokeStyle = '#fff';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
}
