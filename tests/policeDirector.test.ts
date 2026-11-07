import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/CityLayout';
import { PoliceDirector, type DirectorUnitView } from '../src/ai/PoliceDirector';
import { PoliceSystem } from '../src/ai/PoliceSystem';
import { HeatSystem } from '../src/gameplay/HeatSystem';
import { ArcadeVehicle } from '../src/physics/ArcadeVehicle';
import { G, initPhysics, PhysicsWorld } from '../src/physics/PhysicsWorld';
import { PLAYER_CARS } from '../src/vehicles/carSpecs';

if (typeof document === 'undefined') {
  const noop = () => {};
  const ctx = new Proxy(
    {
      createRadialGradient: () => ({ addColorStop: noop }),
      createLinearGradient: () => ({ addColorStop: noop }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      measureText: () => ({ width: 10 }),
    },
    { get: (t, p) => (p in t ? (t as Record<string, unknown>)[p as string] : noop) },
  );
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}

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

  it('tracks both nearest and ahead intersections for a mid-block LKP and only clears LKP when physically reached', () => {
    const dir = new PoliceDirector(city.graph);
    // Suspect spotted at z=22 (between z=0 and z=94) driving +Z toward z=94
    dir.reportSighting(0, 22, 0, 32, 10);
    expect(city.graph.intersections[dir.lastKnown.interId].z).toBe(0);
    expect(city.graph.intersections[dir.lastKnown.aheadInterId].z).toBeGreaterThan(22);

    // Reaching the nearby intersection at (0, 0) (22 m away from LKP) must NOT prematurely clear LKP
    dir.recordUnitPosition(0, 0, 10.5);
    expect(dir.lastKnown.lkpChecked).toBe(false);

    // Driving up the block through the actual LKP at (0, 20) clears LKP
    dir.recordUnitPosition(0, 20, 11);
    expect(dir.lastKnown.lkpChecked).toBe(true);
  });

  it('keeps sector search targets within active pursuit radius during extended searches', () => {
    const dir = new PoliceDirector(city.graph);
    dir.reportSighting(0, 0, 0, 40, 10);
    dir.lastKnown.lkpChecked = true;
    const units = [
      mkUnit(1, 0, -40, false),
      mkUnit(2, -94, 0, false),
      mkUnit(3, 94, 0, false),
      mkUnit(4, 0, 94, false),
    ];
    dir.coordinate(units, 20, false);
    for (const u of units) {
      expect(u.role).toBe('sector');
      expect(Math.hypot(u.targetX, u.targetZ)).toBeLessThanOrEqual(250);
    }
  });

  it('physically drives police units through a mid-block LKP and fans out across forward sectors', async () => {
    await initPhysics();
    const phys = new PhysicsWorld();
    const layout = generateCity(1337);
    for (const b of layout.buildings) {
      phys.addStaticBox(b.x, b.h / 2, b.z, b.w / 2, b.h / 2, b.d / 2);
    }
    const police = new PoliceSystem(layout, phys);
    const heat = new HeatSystem();
    const player = new ArcadeVehicle(phys, PLAYER_CARS[0].spec, 0, -40, 0, G.PLAYER, { kind: 'player' });

    heat.forceStars(2);
    police.reportSighting(player.x, player.z, 0, 25, 0);
    for (let i = 0; i < 10 && police.units.length < 4; i++) {
      police.update(1 / 60, 0, player, heat);
    }
    police.units[0].car.teleport(0, -85, 0);
    police.units[0].car.setForwardSpeed(22);
    police.units[1].car.teleport(-94, -40, 0);
    police.units[1].car.setForwardSpeed(20);
    police.units[2].car.teleport(0, -150, 0);
    police.units[2].car.setForwardSpeed(22);

    let time = 0;
    const dt = 1 / 60;
    let minCopDistToLkp = Infinity;
    for (let step = 0; step < 60 * 8; step++) {
      time += dt;
      if (time < 1.5) {
        player.teleport(0, -40 + (time / 1.5) * 40, 0);
        player.setForwardSpeed(27);
      } else if (time < 2.5) {
        const x = ((time - 1.5) / 1.0) * 42;
        player.teleport(x, 0, Math.PI / 2);
        player.setForwardSpeed(42);
      } else {
        player.teleport(282, -188, Math.PI);
        player.setForwardSpeed(0);
      }
      player.update(dt);
      police.update(dt, time, player, heat);
      phys.step();
      heat.update(dt, {
        playerSpeed: Math.abs(player.speed),
        nearestCopDist: police.nearestDist,
        copSeesPlayer: police.anySees,
      });
      if (time >= 2.5) {
        const lk = police.lastKnown;
        for (const u of police.units) {
          minCopDistToLkp = Math.min(minCopDistToLkp, Math.hypot(u.car.x - lk.x, u.car.z - lk.z));
        }
      }
    }
    expect(minCopDistToLkp).toBeLessThan(8);
    expect(police.lastKnown.lkpChecked).toBe(true);
    expect(police.director.visitedAt.size).toBeGreaterThanOrEqual(2);
  });
});
