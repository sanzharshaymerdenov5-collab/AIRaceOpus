import type { CrimeType, EventBus } from '../core/events';

export const STAR_THRESHOLDS = [10, 60, 150, 300, 500];

export const CRIME_HEAT: Record<CrimeType, number> = {
  speeding: 5,
  redLight: 10,
  reckless: 5,
  hitAndRun: 15,
  propertyDamage: 3,
  rammingCop: 40,
  evading: 0,
};
export const MINOR_CRIMES: CrimeType[] = ['speeding', 'redLight', 'reckless'];

export type HeatMode = 'clean' | 'pullover' | 'pursuit' | 'cooldown';

export interface HeatContext {
  playerSpeed: number; // m/s (abs)
  nearestCopDist: number;
  copSeesPlayer: boolean;
}

export function starsForHeat(heat: number): number {
  let s = 0;
  for (const t of STAR_THRESHOLDS) if (heat >= t) s++;
  return s;
}

/**
 * Crime -> heat -> wanted level state machine.
 * - Unwitnessed crimes add no heat.
 * - Heat below ★1 triggers a pull-over attempt; stop = ticket, flee = ★1.
 * - Pursuit: busted meter fills while slow near a cop.
 * - Losing line of sight starts the cooldown; completing it = escaped.
 */
export class HeatSystem {
  heat = 0;
  stars = 0;
  mode: HeatMode = 'clean';
  bustedMeter = 0; // 0..1
  cooldown = 0; // 0..1 progress
  unseenTime = 0;
  pulloverTime = 0;
  stoppedTime = 0;
  minorImmune = false;
  /** Heat level at which pursuit started (for escape bonus). */
  private peakHeat = 0;

  static readonly UNSEEN_TO_COOLDOWN = 3; // s without LOS before cooldown starts
  static readonly PULLOVER_FLEE_TIME = 8;
  static readonly PULLOVER_STOP_TIME = 2.5;
  static readonly BUST_DIST = 12;
  static readonly BUST_SPEED = 2.8;
  static readonly BUST_FILL = 3; // seconds to fill

  constructor(private bus?: EventBus) {}

  cooldownDuration(stars = this.stars) {
    return 8 + 4 * stars;
  }

  reportCrime(type: CrimeType, witnessed: boolean, scale = 1): number {
    let heat = CRIME_HEAT[type] * scale;
    if (this.minorImmune && MINOR_CRIMES.includes(type) && this.mode !== 'pursuit') heat = 0;
    if (!witnessed) heat = 0;
    this.bus?.emit('crime', { type, witnessed, heat });
    if (heat > 0) this.addHeat(heat);
    return heat;
  }

  addHeat(amount: number) {
    this.heat += amount;
    const prevStars = this.stars;
    this.stars = Math.min(5, starsForHeat(this.heat));
    this.peakHeat = Math.max(this.peakHeat, this.heat);
    if (this.stars > 0) {
      if (this.mode !== 'pursuit') {
        const wasActive = this.mode === 'cooldown';
        this.mode = 'pursuit';
        this.cooldown = 0;
        this.unseenTime = 0;
        if (!wasActive) this.bus?.emit('pursuitStarted', { stars: this.stars });
      }
    } else if (this.mode === 'clean') {
      this.mode = 'pullover';
      this.pulloverTime = 0;
      this.stoppedTime = 0;
      this.bus?.emit('pullover', { active: true });
    }
    if (this.stars !== prevStars || amount > 0) this.bus?.emit('heatChanged', { heat: this.heat, stars: this.stars });
  }

  /** Force a minimum wanted level (e.g. getaway jobs). */
  forceStars(stars: number) {
    const need = STAR_THRESHOLDS[Math.max(0, stars - 1)];
    if (this.heat < need) this.addHeat(need - this.heat);
  }

  update(dt: number, ctx: HeatContext) {
    switch (this.mode) {
      case 'clean':
        return;
      case 'pullover': {
        this.pulloverTime += dt;
        if (ctx.playerSpeed < HeatSystem.BUST_SPEED && ctx.nearestCopDist < 25) this.stoppedTime += dt;
        else this.stoppedTime = Math.max(0, this.stoppedTime - dt * 0.5);
        if (this.stoppedTime >= HeatSystem.PULLOVER_STOP_TIME) {
          const fine = Math.round(100 + this.heat * 20);
          this.resetClean();
          this.bus?.emit('ticket', { fine });
          this.bus?.emit('pullover', { active: false });
        } else if (this.pulloverTime >= HeatSystem.PULLOVER_FLEE_TIME && ctx.nearestCopDist < 120) {
          this.bus?.emit('crime', { type: 'evading', witnessed: true, heat: STAR_THRESHOLDS[0] - this.heat });
          this.bus?.emit('pullover', { active: false });
          this.addHeat(STAR_THRESHOLDS[0] - this.heat);
        } else if (ctx.nearestCopDist > 200) {
          // the cop lost interest
          this.resetClean();
          this.bus?.emit('pullover', { active: false });
        }
        return;
      }
      case 'pursuit':
      case 'cooldown': {
        // busted meter
        if (ctx.playerSpeed < HeatSystem.BUST_SPEED && ctx.nearestCopDist < HeatSystem.BUST_DIST) {
          this.bustedMeter += dt / HeatSystem.BUST_FILL;
        } else {
          this.bustedMeter = Math.max(0, this.bustedMeter - dt / 1.5);
        }
        if (this.bustedMeter >= 1) {
          this.bust();
          return;
        }
        if (ctx.copSeesPlayer) {
          if (this.mode === 'cooldown') this.bus?.emit('spotted', {});
          this.unseenTime = 0;
          this.cooldown = 0;
          this.mode = 'pursuit';
        } else {
          this.unseenTime += dt;
          if (this.mode === 'pursuit' && this.unseenTime >= HeatSystem.UNSEEN_TO_COOLDOWN) {
            this.mode = 'cooldown';
            this.bus?.emit('cooldownStarted', {});
          }
          if (this.mode === 'cooldown') {
            this.cooldown += dt / this.cooldownDuration();
            if (this.cooldown >= 1) this.escape();
          }
        }
        return;
      }
    }
  }

  bust() {
    const fine = Math.round(250 + this.heat * 8);
    this.resetClean();
    this.bus?.emit('busted', { fine });
  }

  escape() {
    const bonus = Math.round(this.peakHeat * 10);
    const heat = this.peakHeat;
    this.resetClean();
    this.bus?.emit('escaped', { bonus, heat });
  }

  resetClean() {
    this.heat = 0;
    this.stars = 0;
    this.mode = 'clean';
    this.bustedMeter = 0;
    this.cooldown = 0;
    this.unseenTime = 0;
    this.pulloverTime = 0;
    this.stoppedTime = 0;
    this.peakHeat = 0;
    this.bus?.emit('heatChanged', { heat: 0, stars: 0 });
  }
}
