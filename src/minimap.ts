// Inset track map: the baked centerline's X/Z with the car's X/Z through one shared transform.
// Local axes are X east, Z south, so canvas x = X and canvas y = Z puts north at the top.
const SIZE = 112; // CSS px
const PAD = 8;

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private toMap: (x: number, z: number) => [number, number];
  private track: Path2D;

  constructor(canvas: HTMLCanvasElement, points: ArrayLike<number>, closed = false) {
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

    this.track = new Path2D();
    for (let i = 0; i < points.length; i += 3) {
      const [mx, my] = this.toMap(points[i], points[i + 2]);
      if (i === 0) this.track.moveTo(mx, my);
      else this.track.lineTo(mx, my);
    }
    if (closed) this.track.closePath();
  }

  draw(carX: number, carZ: number) {
    const c = this.ctx;
    c.clearRect(0, 0, SIZE, SIZE);
    c.lineJoin = c.lineCap = 'round';
    c.strokeStyle = '#000a';
    c.lineWidth = 6;
    c.stroke(this.track);
    c.strokeStyle = '#fff';
    c.lineWidth = 3;
    c.stroke(this.track);
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
