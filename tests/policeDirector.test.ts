import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/CityLayout';
import { PoliceDirector, type DirectorUnitView } from '../src/ai/PoliceDirector';

const city = generateCity(1337);

function mkUnit(id: number, x: number, z: number, sees = false): DirectorUnitView {
  return { id, x, z, seesPlayer: sees, role: 'lead', targetInter: -1, targetX: 0, targetZ: 0 };
}

describe('PoliceDirector AI coordinator', () => {
  it('records last known position, velocity and heading on sighting', () => {
    const dir = new PoliceDirector(city.graph);
    dir.reportSighting(10, 20, 0, 30, 5);
    expect(dir.lastKnown.active).toBe(true);
    expect(dir.lastKnown.x).toBe(10);
    expect(dir.lastKnown.z).toBe(20);
    expect(dir.lastKnown.dirX).toBeCloseTo(0);
    expect(dir.lastKnown.dirZ).toBeCloseTo(1);
    expect(dir.lastKnown.speed).toBeCloseTo(30);
    expect(dir.lastKnown.lkpChecked).toBe(false);
  });

  it('assigns lead, flankers and forward interceptors when in visual contact', () => {
    const dir = new PoliceDirector(city.graph);
    dir.reportSighting(0, 0, 0, 35, 10);
    const units = [
      mkUnit(1, 0, -15, true), // closest behind -> lead
      mkUnit(2, -10, -25, true), // 2nd closest -> left flanker
      mkUnit(3, 10, -30, false), // 3rd closest -> right flanker
      mkUnit(4, 120, -40, false), // far unit -> forward interceptor
    ];
    dir.coordinate(units, 10, true);
    expect(units.find((u) => u.id === 1)!.role).toBe('lead');
    expect(units.find((u) => u.id === 2)!.role).toBe('left');
    expect(units.find((u) => u.id === 3)!.role).toBe('right');
    const inter = units.find((u) => u.id === 4)!;
    expect(inter.role).toBe('intercept');
    // Interceptor target should be ahead of the player (+Z)
    expect(inter.targetZ).toBeGreaterThan(40);
  });

  it('sends closest unit to LKP and fans other units across distinct forward sectors when sight is lost', () => {
    const dir = new PoliceDirector(city.graph);
    dir.reportSighting(0, 0, 0, 32, 10);
    const units = [
      mkUnit(1, 0, -30, false),
      mkUnit(2, -80, -20, false),
      mkUnit(3, 80, -20, false),
      mkUnit(4, 0, -90, false),
    ];
    dir.coordinate(units, 12, false);

    // Closest unit (id=1) verifies the exact LKP
    const lkpUnit = units.find((u) => u.id === 1)!;
    expect(lkpUnit.role).toBe('lkp');
    expect(lkpUnit.targetX).toBe(0);
    expect(lkpUnit.targetZ).toBe(0);

    // Other units get de-conflicted sector intersections, biased along the +Z escape cone
    const sectorUnits = units.filter((u) => u.id !== 1);
    const targets = new Set(sectorUnits.map((u) => u.targetInter));
    expect(sectorUnits.every((u) => u.role === 'sector')).toBe(true);
    expect(targets.size).toBe(sectorUnits.length);
    const avgZ = sectorUnits.reduce((s, u) => s + u.targetZ, 0) / sectorUnits.length;
    expect(avgZ).toBeGreaterThan(0);
  });

  it('marks LKP checked once a unit arrives and advances units to fresh intersections', () => {
    const dir = new PoliceDirector(city.graph);
    dir.reportSighting(0, 0, 0, 30, 10);
    const u1 = mkUnit(1, 0, -20, false);
    dir.coordinate([u1], 11, false);
    expect(u1.role).toBe('lkp');
    const lkpInter = u1.targetInter;

    // Unit arrives at LKP
    u1.x = 1;
    u1.z = 1;
    dir.recordUnitPosition(u1.x, u1.z, 12);
    expect(dir.lastKnown.lkpChecked).toBe(true);

    // Next coordination tick moves the unit to an unvisited forward sector node
    dir.coordinate([u1], 12.5, false);
    expect(u1.role).toBe('sector');
    expect(u1.targetInter).not.toBe(lkpInter);
    expect(u1.targetZ).toBeGreaterThan(0);
  });
});
