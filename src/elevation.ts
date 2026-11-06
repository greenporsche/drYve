import type { Track } from './surface';
import { SECTOR_LINES, TURNS } from './circuit';

// Lap elevation profile from the baked centerline heights, with sector boundaries, turn numbers
// and a marker at the car's station. The strip starts at the control line, like a lap does.
const H = 96; // CSS px; the width follows the space available in the bar
const PAD = { l: 34, r: 8, t: 8, b: 18 };

export class ElevationStrip {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement; // static profile, drawn once
  private length: number;
  private x: (station: number) => number;
  private y: (alt: number) => number;
  private alt: number[];
  private dist: number[];
  private W = 520;
  private canvas: HTMLCanvasElement;
  private track: Track;

  constructor(canvas: HTMLCanvasElement, track: Track) {
    this.canvas = canvas;
    this.track = track;
    this.ctx = canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.x = () => 0;
    this.y = () => 0;
    this.alt = [];
    this.dist = [];
    this.length = 0;
    this.layout(520);
  }

  // Size the strip to `width` CSS px and redraw the static profile (called on resize).
  layout(width: number) {
    const W = Math.max(240, Math.floor(width));
    this.W = W;
    const canvas = this.canvas, track = this.track;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const o = track.meta.localOrigin.height;
    const pts = track.centerline.points;
    this.dist = track.centerline.distance;
    this.alt = this.dist.map((_, i) => pts[i * 3 + 1] + o);
    this.length = track.centerline.length ?? this.dist[this.dist.length - 1];
    const lo = Math.floor(Math.min(...this.alt) / 10) * 10, hi = Math.ceil(Math.max(...this.alt) / 10) * 10;
    const start = SECTOR_LINES[0];
    const lapPos = (s: number) => (((s - start) % this.length) + this.length) % this.length;
    this.x = (s) => PAD.l + (lapPos(s) / this.length) * (W - PAD.l - PAD.r);
    this.y = (a) => PAD.t + (1 - (a - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

    this.base.width = canvas.width;
    this.base.height = canvas.height;
    const c = this.base.getContext('2d')!;
    c.scale(dpr, dpr);

    // Profile, in lap order from the control line.
    const order = this.dist.map((_, i) => i).sort((a, b) => lapPos(this.dist[a]) - lapPos(this.dist[b]));
    const floorY = H - PAD.b;
    c.beginPath();
    c.moveTo(PAD.l, floorY);
    for (const i of order) c.lineTo(this.x(this.dist[i]), this.y(this.alt[i]));
    c.lineTo(W - PAD.r, floorY);
    c.closePath();
    const grad = c.createLinearGradient(0, PAD.t, 0, floorY);
    grad.addColorStop(0, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0.05)');
    c.fillStyle = grad;
    c.fill();
    c.beginPath();
    order.forEach((i, k) => (k ? c.lineTo : c.moveTo).call(c, this.x(this.dist[i]), this.y(this.alt[i])));
    c.strokeStyle = '#fff';
    c.lineWidth = 1.5;
    c.stroke();

    // Sector boundaries and labels.
    c.font = '700 10px system-ui, sans-serif';
    c.textBaseline = 'top';
    SECTOR_LINES.forEach((s, k) => {
      const sx = this.x(s);
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(sx, PAD.t);
      c.lineTo(sx, floorY);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = 'rgba(255,255,255,0.7)';
      c.fillText(`S${k + 1}`, sx + 3, PAD.t);
    });

    // Turn numbers along the bottom.
    c.font = '600 9px system-ui, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.textAlign = 'center';
    let lastX = -Infinity;
    for (const t of TURNS) {
      const tx = this.x((t.in + t.out) / 2);
      if (Math.abs(tx - lastX) < 14) continue; // too close to read; the neighbour already labels it
      c.fillText(String(t.n), tx, floorY + 4);
      lastX = tx;
    }

    // Altitude scale.
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.fillText(`${hi} m`, PAD.l - 4, this.y(hi));
    c.fillText(`${lo} m`, PAD.l - 4, this.y(lo));
  }

  draw(station: number, altitude: number) {
    const c = this.ctx, W = this.W;
    c.clearRect(0, 0, W, H);
    c.drawImage(this.base, 0, 0, W, H);
    const x = this.x(station), y = this.y(altitude);
    c.strokeStyle = 'rgba(225,6,0,0.8)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x, PAD.t);
    c.lineTo(x, H - PAD.b);
    c.stroke();
    c.fillStyle = '#e10600';
    c.strokeStyle = '#fff';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, 4.5, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    // The car's altitude, beside the marker (flips to the left near the right end).
    const label = `${altitude.toFixed(1)} m`;
    c.font = '800 12px system-ui, sans-serif';
    const w = c.measureText(label).width + 8;
    const lx = x + 8 + w > W - PAD.r ? x - 8 - w : x + 8;
    const ly = Math.max(PAD.t, Math.min(H - PAD.b - 16, y - 20));
    c.fillStyle = 'rgba(225,6,0,0.95)';
    c.fillRect(lx, ly, w, 16);
    c.fillStyle = '#fff';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText(label, lx + 4, ly + 8.5);
  }
}
