import { CITY, type CityLayout } from '../city/CityLayout';
import type { CopUnit, PoliceSystem } from '../ai/PoliceSystem';
import type { TrafficUnit } from '../ai/TrafficSystem';
import type { JobSystem } from '../gameplay/JobSystem';
import type { RaceSystem } from '../gameplay/RaceSystem';

/**
 * Rotating top-down PS2-style radar: pre-renders the 1.5x1.5 km road network (including curved roads)
 * to an offscreen canvas once, then blits it rotated under the player icon + cop cones + jobs + AI racers.
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
    // straight grid roads
    g.strokeStyle = '#4a5568';
    g.lineCap = 'square';
    for (const seg of this.layout.segments) {
      if (seg.removed || seg.curve) continue;
      const A = this.layout.intersections[seg.a];
      const B = this.layout.intersections[seg.b];
      g.lineWidth = (seg.ring ? CITY.ROAD * 1.15 : CITY.ROAD * 0.9) * S;
      g.strokeStyle = seg.ring ? '#7b6a35' : '#465066';
      g.beginPath();
      g.moveTo(this.toMap(A.x), this.toMap(A.z));
      g.lineTo(this.toMap(B.x), this.toMap(B.z));
      g.stroke();
    }
    // smooth curved roads
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const cr of this.layout.curvedRoads) {
      if (!cr.points.length) continue;
      // outer kerb highlight
      g.lineWidth = CITY.ROAD * 1.25 * S;
      g.strokeStyle = '#8b4a62';
      g.beginPath();
      g.moveTo(this.toMap(cr.points[0].x), this.toMap(cr.points[0].z));
      for (let i = 1; i < cr.points.length; i++) {
        g.lineTo(this.toMap(cr.points[i].x), this.toMap(cr.points[i].z));
      }
      g.stroke();
      // asphalt core
      g.lineWidth = CITY.ROAD * 0.92 * S;
      g.strokeStyle = '#5a6680';
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
    races: RaceSystem,
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

    // Official Race spots, Job spots, or active objective
    if (races.active) {
      const cps = races.active.def.checkpoints;
      const cur = cps[races.active.cpIndex];
      const next = cps[(races.active.cpIndex + 1) % cps.length];
      if (cur) {
        // Route line from player to current checkpoint & next checkpoint
        ctx.strokeStyle = 'rgba(255, 42, 109, 0.75)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo((cur.x - px) * scale, (cur.z - pz) * scale);
        if (next) ctx.lineTo((next.x - px) * scale, (next.z - pz) * scale);
        ctx.stroke();

        dot(cur.x, cur.z, 5.5 + Math.sin(time * 9) * 1.5, '#ff2a6d');
        dot(cur.x, cur.z, 2.5, '#ffffff');
      }
      // Draw AI race opponents
      for (const opp of races.active.opponents) {
        const ox = (opp.car.x - px) * scale;
        const oz = (opp.car.z - pz) * scale;
        ctx.save();
        ctx.translate(ox, oz);
        ctx.rotate(-opp.car.yaw + Math.PI);
        ctx.fillStyle = opp.colorHex;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, -5);
        ctx.lineTo(4, 4);
        ctx.lineTo(-4, 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    } else if (jobs.active) {
      if (jobs.target) {
        dot(jobs.target.x, jobs.target.z, 5 + Math.sin(time * 8) * 1.5, '#05d9e8');
      }
    } else {
      // Idle markers for Official Races (neon pink/gold rings) and Outlaw Jobs
      for (const r of this.layout.raceSpots) {
        dot(r.startX, r.startZ, 5, '#ff2a6d');
        dot(r.startX, r.startZ, 2.2, '#ffc800');
      }
      for (const s of this.layout.jobSpots) {
        const col = s.type === 'getaway' ? '#ff2a6d' : s.type === 'sprint' ? '#05d9e8' : '#ffc800';
        dot(s.x, s.z, 3.6, col);
      }
    }

    // Roadblocks
    for (const rb of cops.roadblocks) dot(rb.x, rb.z, 4, '#ff8800');

    // Traffic
    for (const t of traffic) dot(t.car.x, t.car.z, 1.8, '#8a99ad');

    // Last Known Position (LKP) marker when police have lost sight and are searching
    const lk = cops.lastKnown;
    if (lk.active && !cops.anySees) {
      const lx = (lk.x - px) * scale;
      const lz = (lk.z - pz) * scale;
      const pulse = 6 + (Math.sin(time * 7) * 0.5 + 0.5) * 5;
      ctx.strokeStyle = 'rgba(255, 200, 0, 0.85)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(lx, lz, pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lx - 5, lz);
      ctx.lineTo(lx + 5, lz);
      ctx.moveTo(lx, lz - 5);
      ctx.lineTo(lx, lz + 5);
      ctx.moveTo(lx, lz);
      ctx.lineTo(lx + lk.dirX * 18, lz + lk.dirZ * 18);
      ctx.stroke();
    }

    // Cops + search cones
    const flash = Math.floor(time * 8) % 2 === 0;
    const drawCop = (u: CopUnit) => {
      const cx = (u.car.x - px) * scale;
      const cz = (u.car.z - pz) * scale;
      if (u.state !== 'patrol') {
        if (u.state === 'search') {
          ctx.strokeStyle = 'rgba(80, 180, 255, 0.25)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx, cz);
          ctx.lineTo((u.targetX - px) * scale, (u.targetZ - pz) * scale);
          ctx.stroke();
        }
        ctx.save();
        ctx.translate(cx, cz);
        ctx.rotate(-u.car.yaw);
        ctx.fillStyle = u.seesPlayer ? 'rgba(255,40,60,0.28)' : 'rgba(60,150,255,0.22)';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, 38, Math.PI * 0.26, Math.PI * 0.74);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      dot(u.car.x, u.car.z, 3.3, u.state === 'patrol' ? '#4da6ff' : flash ? '#ff2030' : '#2080ff');
    };
    for (const u of cops.units) drawCop(u);

    ctx.restore();

    // Target edge arrow if active race checkpoint or job target is outside the radar circle
    const activeTarget = races.target ?? jobs.target;
    const arrowColor = races.target ? '#ff2a6d' : '#05d9e8';
    if (activeTarget) {
      const dx = activeTarget.x - px;
      const dz = activeTarget.z - pz;
      const ang = Math.atan2(dx, dz) - pyaw; // 0 = ahead (up)
      const dist = Math.hypot(dx, dz) * scale;
      if (dist > R - 10) {
        ctx.save();
        ctx.translate(R, R);
        ctx.rotate(-ang);
        ctx.fillStyle = arrowColor;
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
    ctx.strokeStyle = races.active ? '#ff2a6d' : '#ff9d00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}
