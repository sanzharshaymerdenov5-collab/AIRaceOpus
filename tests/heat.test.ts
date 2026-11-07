import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { HeatSystem, STAR_THRESHOLDS, starsForHeat } from '../src/gameplay/HeatSystem';

const far = { playerSpeed: 30, nearestCopDist: 500, copSeesPlayer: false };
const chasing = { playerSpeed: 30, nearestCopDist: 40, copSeesPlayer: true };

function setup() {
  const bus = new EventBus();
  const log: string[] = [];
  for (const e of ['busted', 'escaped', 'ticket', 'pursuitStarted', 'cooldownStarted', 'spotted'] as const)
    bus.on(e, () => log.push(e));
  return { h: new HeatSystem(bus), log, bus };
}
const run = (h: HeatSystem, secs: number, ctx: typeof far) => {
  for (let t = 0; t < secs; t += 1 / 60) h.update(1 / 60, ctx);
};

describe('heat system', () => {
  it('maps heat to stars using thresholds', () => {
    expect(starsForHeat(0)).toBe(0);
    expect(starsForHeat(9.9)).toBe(0);
    for (let k = 0; k < 5; k++) expect(starsForHeat(STAR_THRESHOLDS[k])).toBe(k + 1);
    expect(starsForHeat(99999)).toBe(5);
  });

  it('ignores unwitnessed crimes', () => {
    const { h } = setup();
    h.reportCrime('hitAndRun', false);
    expect(h.heat).toBe(0);
    expect(h.mode).toBe('clean');
  });

  it('witnessed crimes add heat and start pursuit', () => {
    const { h, log } = setup();
    h.reportCrime('hitAndRun', true);
    expect(h.heat).toBe(15);
    expect(h.stars).toBe(1);
    expect(h.mode).toBe('pursuit');
    expect(log).toContain('pursuitStarted');
    h.reportCrime('rammingCop', true);
    expect(h.stars).toBe(1); // 55 < 60
    h.reportCrime('rammingCop', true);
    expect(h.stars).toBe(2);
  });

  it('minor crime starts a pull-over; stopping gives a ticket', () => {
    const { h, log } = setup();
    h.reportCrime('speeding', true);
    expect(h.mode).toBe('pullover');
    run(h, 3, { playerSpeed: 0, nearestCopDist: 10, copSeesPlayer: true });
    expect(log).toContain('ticket');
    expect(h.mode).toBe('clean');
    expect(h.heat).toBe(0);
  });

  it('fleeing a pull-over escalates to one star', () => {
    const { h } = setup();
    h.reportCrime('speeding', true);
    run(h, HeatSystem.PULLOVER_FLEE_TIME + 0.1, chasing);
    expect(h.stars).toBe(1);
    expect(h.mode).toBe('pursuit');
  });

  it('cabbie is immune to minor crimes but not major ones', () => {
    const { h } = setup();
    h.minorImmune = true;
    h.reportCrime('speeding', true);
    h.reportCrime('redLight', true);
    expect(h.heat).toBe(0);
    h.reportCrime('hitAndRun', true);
    expect(h.heat).toBe(15);
  });

  it('busted meter fills when stopped near a cop and drains otherwise', () => {
    const { h, log } = setup();
    h.forceStars(2);
    run(h, 1.5, { playerSpeed: 0, nearestCopDist: 5, copSeesPlayer: true });
    expect(h.bustedMeter).toBeGreaterThan(0.4);
    run(h, 2, chasing);
    expect(h.bustedMeter).toBe(0);
    run(h, HeatSystem.BUST_FILL + 0.1, { playerSpeed: 0, nearestCopDist: 5, copSeesPlayer: true });
    expect(log).toContain('busted');
    expect(h.stars).toBe(0);
  });

  it('cooldown starts after losing sight, resets when spotted, completes to escape', () => {
    const { h, log } = setup();
    h.forceStars(1);
    run(h, HeatSystem.UNSEEN_TO_COOLDOWN + 0.1, far);
    expect(h.mode).toBe('cooldown');
    expect(log).toContain('cooldownStarted');
    run(h, 3, far);
    expect(h.cooldown).toBeGreaterThan(0);
    h.update(1 / 60, chasing);
    expect(log).toContain('spotted');
    expect(h.cooldown).toBe(0);
    expect(h.mode).toBe('pursuit');
    run(h, HeatSystem.UNSEEN_TO_COOLDOWN + h.cooldownDuration() + 0.5, far);
    expect(log).toContain('escaped');
    expect(h.mode).toBe('clean');
  });

  it('higher stars need longer cooldowns', () => {
    const { h } = setup();
    expect(h.cooldownDuration(5)).toBeGreaterThan(h.cooldownDuration(1));
  });
});
