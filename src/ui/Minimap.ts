import { CITY, type CityLayout } from '../city/CityLayout';
import type { CopUnit, PoliceSystem } from '../ai/PoliceSystem';
import type { TrafficUnit } from '../ai/TrafficSystem';
import type { JobSystem } from '../gameplay/JobSystem';

/**
 * Rotating top-down PS2-style radar: pre-renders the road network to an
 * offscreen canvas once, then blits it rotated under the player icon + cop cones + jobs.
 */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private mapCanvas: HTMLCanvasElement;
  private readonly mapPx = 512;
  private readonly worldSpan = CITY.HALF * 2 + 80;

  constructor(
    canvas: HTMLCanvasElement,
    private layout: CityLayout,
  ) {
    canvas.width = canvas.height = 190;
    this.ctx = canvas.getContext('2d')!;
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = this.mapCanvas.height = this.mapPx;
    this.bakeRoads();
  }

  private toMap(w: number) {
    return (w / this.worldSpan + 0.5) * this.mapPx;
  }

  private bakeRoads() {
    const g = this.mapCanvas.getContext('2d')!;
    const S = this.mapPx / this.worldSpan;
    g.fillStyle = '#0a0e18';
    g.fillRect(0, 0, this.mapPx, this.mapPx);
    // blocks
    for (const b of this.layout.blocks) {
      g.fillStyle = b.district === 'park' ? '#16281c' : b.district === 'downtown' ? '#1c2438' : '#151b28';
      const s = CITY.BLOCK * S;
      g.fillRect(this.toMap(b.cx) - s / 2, this.toMap(b.cz) - s / 2, s, s);
    }
    // roads
    g.strokeStyle = '#4a5568';
    g.lineCap = 'square';
    for (const seg of this.layout.segments) {
      if (seg.removed) continue;
      const A = this.layout.intersections[seg.a];
      const B = this.layout.intersections[seg.b];
      g.lineWidth = (seg.ring ? CITY.ROAD * 1.15 : CITY.ROAD * 0.9) * S;
      g.strokeStyle = seg.ring ? '#7b6a35' : '#465066';
      g.beginPath();
      g.moveTo(this.toMap(A.x), this.toMap(A.z));
      g.lineTo(this.toMap(B.x), this.toMap(B.z));
      g.stroke();
    }
  }

  draw(
    px: number,
    pz: number,
    pyaw: number,
    cops: PoliceSystem,
    traffic: TrafficUnit[],
    jobs: JobSystem,
    time: number,
  ) {
    const ctx = this.ctx;
    const W = ctx.canvas.width;
    const R = W / 2;
    const scale = 0.42; // canvas px per world metre
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 3, 0, Math.PI * 2);
    ctx.clip();

    // Rotate so player's forward (+Z at yaw=0) points UP on the radar
    ctx.translate(R, R);
    ctx.rotate(pyaw - Math.PI);

    const mScale = (this.worldSpan / this.mapPx) * scale;
    ctx.save();
    ctx.scale(mScale, mScale);
    ctx.drawImage(this.mapCanvas, -this.toMap(px), -this.toMap(pz));
    ctx.restore();

    const dot = (wx: number, wz: number, r: number, col: string) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc((wx - px) * scale, (wz - pz) * scale, r, 0, Math.PI * 2);
      ctx.fill();
    };

    // Job spots or active objective
    if (!jobs.active) {
      for (const s of this.layout.jobSpots) {
        const col = s.type === 'getaway' ? '#ff2a6d' : s.type === 'sprint' ? '#05d9e8' : '#ffc800';
        dot(s.x, s.z, 4, col);
      }
    } else if (jobs.target) {
      dot(jobs.target.x, jobs.target.z, 5 + Math.sin(time * 8) * 1.5, '#05d9e8');
    }

    // Roadblocks
    for (const rb of cops.roadblocks) dot(rb.x, rb.z, 4, '#ff8800');

    // Traffic
    for (const t of traffic) dot(t.car.x, t.car.z, 1.8, '#8a99ad');

    // Cops + search cones
    const flash = Math.floor(time * 8) % 2 === 0;
    const drawCop = (u: CopUnit) => {
      const cx = (u.car.x - px) * scale;
      const cz = (u.car.z - pz) * scale;
      if (u.state !== 'patrol') {
        ctx.save();
        ctx.translate(cx, cz);
        ctx.rotate(-u.car.yaw);
        ctx.fillStyle = u.seesPlayer ? 'rgba(255,40,60,0.26)' : 'rgba(60,140,255,0.20)';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 32, Math.PI * 0.3, Math.PI * 0.7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      dot(u.car.x, u.car.z, 3.3, u.state === 'patrol' ? '#4da6ff' : flash ? '#ff2030' : '#2080ff');
    };
    for (const u of cops.units) drawCop(u);

    ctx.restore();

    // Target edge arrow if active job target is outside the radar circle
    if (jobs.target) {
      const dx = jobs.target.x - px;
      const dz = jobs.target.z - pz;
      const ang = Math.atan2(dx, dz) - pyaw; // 0 = ahead (up)
      const dist = Math.hypot(dx, dz) * scale;
      if (dist > R - 10) {
        ctx.save();
        ctx.translate(R, R);
        ctx.rotate(-ang);
        ctx.fillStyle = '#05d9e8';
        ctx.beginPath();
        ctx.moveTo(0, -(R - 4));
        ctx.lineTo(-6, -(R - 14));
        ctx.lineTo(6, -(R - 14));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // Player chevron in the middle
    ctx.save();
    ctx.translate(R, R);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Bezel
    ctx.strokeStyle = '#ff9d00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}
