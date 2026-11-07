import { CITY, CURVE_ZONES, lineCoord, type CityLayout } from '../city/CityLayout';
import type { PoliceSystem } from '../ai/PoliceSystem';
import type { TrafficUnit } from '../ai/TrafficSystem';
import type { HeatSystem } from '../gameplay/HeatSystem';
import type { JobSystem } from '../gameplay/JobSystem';
import type { RaceSystem } from '../gameplay/RaceSystem';
import type { TimeOfDay } from '../gameplay/Save';
import type { ArcadeVehicle } from '../physics/ArcadeVehicle';
import { Minimap } from './Minimap';
import { clamp } from '../core/rng';

interface Toast {
  text: string;
  sub?: string;
  color: string;
  ttl: number;
}

const ORD = ['1ST', '2ND', '3RD', '4TH'];

/**
 * DOM + Canvas HUD:
 * - Analog PS2 tachometer/speedometer dial + digital km/h + gear + nitro arc.
 * - Day/Night mode badge (Speedhunter Showdown vs Outlaw Night).
 * - Official Race telemetry (Position 1..4, Lap, Checkpoint, Timer) & Outlaw Jobs.
 * - Wanted stars, busted / cooldown bars, pull-over prompt.
 * - Health bar, cash, district / curved road name, crime feed and center screen banners.
 */
export class HUD {
  readonly root: HTMLElement;
  private dialCtx: CanvasRenderingContext2D;
  private minimap: Minimap;
  private starsEl: HTMLElement;
  private cashEl: HTMLElement;
  private distEl: HTMLElement;
  private modeEl: HTMLElement;
  private healthFill: HTMLElement;
  private barWrap: HTMLElement;
  private barLabel: HTMLElement;
  private barFill: HTMLElement;
  private bannerEl: HTMLElement;
  private bannerSub: HTMLElement;
  private feedEl: HTMLElement;
  private jobEl: HTMLElement;
  private promptEl: HTMLElement;
  private fpsEl: HTMLElement;
  private toasts: Toast[] = [];
  private bannerTtl = 0;

  constructor(container: HTMLElement, layout: CityLayout) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="hud-top-left">
        <canvas id="minimap-canvas"></canvas>
        <div class="district-tag" id="hud-district">DOWNTOWN</div>
        <div class="mode-tag day" id="hud-mode">☀ DAY · SPEEDHUNTER [T]</div>
      </div>
      <div class="hud-top-right">
        <div class="wanted-stars" id="hud-stars"></div>
        <div class="cash-row">$<span id="hud-cash">1000</span></div>
        <div class="health-wrap"><span>HULL</span><div class="bar"><div id="hud-health"></div></div></div>
        <div class="fps-tag" id="hud-fps">60 FPS</div>
      </div>
      <div class="hud-pursuit" id="hud-bar-wrap">
        <div class="pursuit-label" id="hud-bar-label">BUSTED</div>
        <div class="bar big"><div id="hud-bar-fill"></div></div>
      </div>
      <div class="hud-job" id="hud-job"></div>
      <div class="hud-banner" id="hud-banner"><div class="b-main"></div><div class="b-sub"></div></div>
      <div class="hud-prompt" id="hud-prompt"></div>
      <div class="hud-feed" id="hud-feed"></div>
      <div class="hud-bottom-right">
        <canvas id="dial-canvas" width="220" height="220"></canvas>
      </div>
      <div class="hud-controls-hint">[WASD/Arrows] Drive · [Space] Drift · [Shift] Nitro · [E] Start Race/Job · [T] Day/Night · [C] Cam · [R] Reset · [Esc] Pause</div>
    `;
    container.appendChild(this.root);

    this.minimap = new Minimap(this.root.querySelector('#minimap-canvas') as HTMLCanvasElement, layout);
    this.dialCtx = (this.root.querySelector('#dial-canvas') as HTMLCanvasElement).getContext('2d')!;
    this.starsEl = this.root.querySelector('#hud-stars')!;
    this.cashEl = this.root.querySelector('#hud-cash')!;
    this.distEl = this.root.querySelector('#hud-district')!;
    this.modeEl = this.root.querySelector('#hud-mode')!;
    this.healthFill = this.root.querySelector('#hud-health')!;
    this.barWrap = this.root.querySelector('#hud-bar-wrap')!;
    this.barLabel = this.root.querySelector('#hud-bar-label')!;
    this.barFill = this.root.querySelector('#hud-bar-fill')!;
    this.bannerEl = this.root.querySelector('#hud-banner .b-main')!;
    this.bannerSub = this.root.querySelector('#hud-banner .b-sub')!;
    this.feedEl = this.root.querySelector('#hud-feed')!;
    this.jobEl = this.root.querySelector('#hud-job')!;
    this.promptEl = this.root.querySelector('#hud-prompt')!;
    this.fpsEl = this.root.querySelector('#hud-fps')!;

    let starsHtml = '';
    for (let k = 0; k < 5; k++) starsHtml += `<span class="star">★</span>`;
    this.starsEl.innerHTML = starsHtml;
  }

  banner(text: string, sub = '', color = '#ff9d00', time = 2.2) {
    this.bannerEl.textContent = text;
    this.bannerEl.style.color = color;
    this.bannerSub.textContent = sub;
    this.bannerEl.parentElement!.classList.add('show');
    this.bannerTtl = time;
  }

  toast(text: string, color = '#ff5555') {
    this.toasts.unshift({ text, color, ttl: 2.6 });
    if (this.toasts.length > 5) this.toasts.pop();
    this.renderToasts();
  }

  private renderToasts() {
    this.feedEl.innerHTML = this.toasts.map((t) => `<div style="color:${t.color}">${t.text}</div>`).join('');
  }

  update(
    dt: number,
    time: number,
    car: ArcadeVehicle,
    health01: number,
    cash: number,
    heat: HeatSystem,
    cops: PoliceSystem,
    traffic: TrafficUnit[],
    jobs: JobSystem,
    races: RaceSystem,
    timeOfDay: TimeOfDay,
    fps: number,
  ) {
    // Banner + toast decay
    if (this.bannerTtl > 0) {
      this.bannerTtl -= dt;
      if (this.bannerTtl <= 0) this.bannerEl.parentElement!.classList.remove('show');
    }
    let ch = false;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      this.toasts[i].ttl -= dt;
      if (this.toasts[i].ttl <= 0) (this.toasts.splice(i, 1), (ch = true));
    }
    if (ch) this.renderToasts();

    this.cashEl.textContent = cash.toLocaleString();
    this.fpsEl.textContent = `${Math.round(fps)} FPS`;
    this.healthFill.style.width = `${Math.round(clamp(health01, 0, 1) * 100)}%`;
    this.healthFill.style.background = health01 > 0.5 ? '#2ee67a' : health01 > 0.25 ? '#ffb000' : '#ff2a40';

    // Mode badge
    if (timeOfDay === 'day') {
      this.modeEl.textContent = '☀ DAY · SPEEDHUNTER [T]';
      this.modeEl.className = 'mode-tag day';
    } else {
      this.modeEl.textContent = '☾ NIGHT · OUTLAW HEAT [T]';
      this.modeEl.className = 'mode-tag night';
    }

    // District / Curved road label
    let curveName = '';
    for (const cz of CURVE_ZONES) {
      if (
        car.x >= lineCoord(cz.i0) - 8 &&
        car.x <= lineCoord(cz.i0 + 2) + 8 &&
        car.z >= lineCoord(cz.j0) - 8 &&
        car.z <= lineCoord(cz.j0 + 2) + 8
      ) {
        curveName = cz.name;
        break;
      }
    }
    if (curveName) {
      this.distEl.textContent = curveName;
    } else {
      const dc = Math.max(Math.abs(car.x), Math.abs(car.z)) / CITY.SPACING;
      this.distEl.textContent =
        dc > CITY.N / 2 - 0.6 ? 'RING HIGHWAY' : dc <= 2.5 ? 'PALM DOWNTOWN' : car.x > CITY.SPACING * 3 ? 'HARBOR DOCKS' : 'WEST SUBURBS';
    }

    // Wanted stars
    const flash = Math.floor(time * 7) % 2 === 0;
    const starNodes = this.starsEl.children;
    for (let i = 0; i < 5; i++) {
      const el = starNodes[i] as HTMLElement;
      const lit = i < heat.stars;
      el.className = lit ? (heat.mode === 'cooldown' ? 'star cool' : flash ? 'star red' : 'star blue') : 'star';
    }

    // Busted / Cooldown / Pullover bar
    if (heat.bustedMeter > 0.02) {
      this.barWrap.style.display = 'block';
      this.barLabel.textContent = 'BUSTED!';
      this.barFill.style.width = `${heat.bustedMeter * 100}%`;
      this.barFill.style.background = '#ff2030';
    } else if (heat.mode === 'cooldown') {
      this.barWrap.style.display = 'block';
      this.barLabel.textContent = 'COOLDOWN — STAY HIDDEN';
      this.barFill.style.width = `${heat.cooldown * 100}%`;
      this.barFill.style.background = '#20b8ff';
    } else if (heat.mode === 'pullover') {
      this.barWrap.style.display = 'block';
      this.barLabel.textContent = 'POLICE: PULL OVER (STOP) OR FLEE!';
      this.barFill.style.width = `${(1 - heat.pulloverTime / 8) * 100}%`;
      this.barFill.style.background = '#ffae00';
    } else {
      this.barWrap.style.display = 'none';
    }

    // Official Race panel or Outlaw Job panel
    if (races.active) {
      const r = races.active;
      const posStr = ORD[r.playerPosition - 1] ?? `${r.playerPosition}TH`;
      const lapInfo =
        r.def.kind === 'circuit'
          ? `LAP ${r.lap}/${r.def.laps} · CP ${r.cpIndex + 1}/${r.def.checkpoints.length}`
          : `SPRINT · CP ${r.cpIndex + 1}/${r.def.checkpoints.length}`;
      const prize = r.def.prizes[r.playerPosition - 1] ?? 500;
      this.jobEl.style.display = 'block';
      this.jobEl.innerHTML = `
        <div class="job-title" style="color:#ff2a6d">🏁 ${r.def.name}</div>
        <div class="job-sub">${lapInfo} · PRIZE $${prize.toLocaleString()}</div>
        <div class="job-time">${posStr} / 4 · ${r.elapsed.toFixed(1)}s</div>
      `;
    } else if (jobs.active) {
      const j = jobs.active;
      const extra =
        j.type === 'smash'
          ? `SMASHED: ${j.smashed} / ${j.smashGoal}`
          : j.type === 'sprint'
            ? `CHECKPOINT ${j.cpIndex + 1} / ${j.checkpoints.length}`
            : 'LOSE THE COPS & REACH THE DROP-OFF';
      this.jobEl.style.display = 'block';
      this.jobEl.innerHTML = `<div class="job-title">${j.name}</div><div class="job-sub">${extra}</div><div class="job-time">${j.timeLeft.toFixed(1)}s</div>`;
    } else {
      this.jobEl.style.display = 'none';
    }

    // Start prompt
    if (races.nearRace && !races.active && !jobs.active) {
      const d = races.nearRace.def;
      this.promptEl.style.display = 'block';
      this.promptEl.textContent = `PRESS [E] OR [ENTER] · OFFICIAL RACE: ${d.name} (1ST: $${d.prizes[0].toLocaleString()})`;
    } else if (jobs.nearSpot && !jobs.active && !races.active) {
      this.promptEl.style.display = 'block';
      this.promptEl.textContent = `PRESS [E] OR [ENTER] TO START ${jobs.nearSpot.type.toUpperCase()} JOB`;
    } else if (car.spikedTime > 0) {
      this.promptEl.style.display = 'block';
      this.promptEl.textContent = `TYRES PUNCTURED! (${car.spikedTime.toFixed(0)}s)`;
    } else {
      this.promptEl.style.display = 'none';
    }

    this.minimap.draw(car.x, car.z, car.yaw, cops, traffic, jobs, races, time);
    this.drawDial(car);
  }

  private drawDial(car: ArcadeVehicle) {
    const g = this.dialCtx;
    const W = 220;
    const cx = 115;
    const cy = 115;
    const R = 86;
    g.clearRect(0, 0, W, W);

    // Backing disc
    g.fillStyle = 'rgba(8, 12, 24, 0.82)';
    g.beginPath();
    g.arc(cx, cy, R + 12, 0, Math.PI * 2);
    g.fill();

    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;

    // Nitro outer arc
    g.lineWidth = 8;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.arc(cx, cy, R + 6, a0, a1);
    g.stroke();
    g.strokeStyle = car.nitroActive ? '#ffffff' : '#00d9ff';
    g.beginPath();
    g.arc(cx, cy, R + 6, a0, a0 + (a1 - a0) * car.nitro);
    g.stroke();

    // Ticks (0..260 km/h)
    for (let k = 0; k <= 13; k++) {
      const f = k / 13;
      const a = a0 + (a1 - a0) * f;
      const redline = k >= 11;
      g.strokeStyle = redline ? '#ff2a40' : '#d8e2f0';
      g.lineWidth = k % 2 === 0 ? 2.5 : 1.2;
      const r0 = k % 2 === 0 ? R - 14 : R - 8;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * (R - 2), cy + Math.sin(a) * (R - 2));
      g.stroke();
      if (k % 2 === 0) {
        g.fillStyle = redline ? '#ff4455' : '#9fb0c8';
        g.font = 'bold 10px Orbitron, monospace';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(`${k * 20}`, cx + Math.cos(a) * (R - 25), cy + Math.sin(a) * (R - 25));
      }
    }

    // Needle
    const kmh = Math.abs(car.speed) * 3.6;
    const nf = clamp(kmh / 260, 0, 1.05);
    const na = a0 + (a1 - a0) * nf;
    g.strokeStyle = '#ff6a00';
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(cx - Math.cos(na) * 14, cy - Math.sin(na) * 14);
    g.lineTo(cx + Math.cos(na) * (R - 10), cy + Math.sin(na) * (R - 10));
    g.stroke();
    g.fillStyle = '#ff9d00';
    g.beginPath();
    g.arc(cx, cy, 7, 0, Math.PI * 2);
    g.fill();

    // Digital readout
    g.fillStyle = '#ffffff';
    g.font = '900 28px Orbitron, monospace';
    g.textAlign = 'center';
    g.fillText(`${Math.round(kmh)}`, cx, cy + 38);
    g.fillStyle = '#ff9d00';
    g.font = '700 10px Orbitron, monospace';
    g.fillText('KM/H · N2O', cx, cy + 56);

    const gear = car.speed < -1 ? 'R' : Math.min(6, Math.max(1, Math.floor((Math.abs(car.speed) / car.spec.topSpeed) * 5.6) + 1));
    g.fillStyle = '#05d9e8';
    g.font = '900 16px Orbitron, monospace';
    g.fillText(`G${gear}`, cx, cy - 22);
  }
}
