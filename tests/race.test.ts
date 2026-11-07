import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/CityLayout';
import { EventBus } from '../src/core/events';
import { RaceSystem } from '../src/gameplay/RaceSystem';
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

describe('Official Speedhunter Races (RaceSystem)', () => {
  it('defines 5 official races whose start lines and checkpoints all lie on drivable roads', () => {
    const layout = generateCity(1337);
    expect(layout.raceSpots.length).toBe(5);
    for (const r of layout.raceSpots) {
      expect(layout.graph.onRoad(r.startX, r.startZ)).toBe(true);
      expect(r.prizes[0]).toBeGreaterThan(r.prizes[1]);
      expect(r.prizes[1]).toBeGreaterThan(r.prizes[2]);
      for (const cp of r.checkpoints) {
        expect(layout.graph.onRoad(cp.x, cp.z)).toBe(true);
      }
    }
  });

  it('starts an official race with 3 AI opponents, counts down 3-2-1-GO, and awards 1st place prize on finish', async () => {
    await initPhysics();
    const phys = new PhysicsWorld();
    const layout = generateCity(1337);
    const bus = new EventBus();
    const races = new RaceSystem(layout, phys, bus);
    const player = new ArcadeVehicle(phys, PLAYER_CARS[0].spec, 0, 0, 0, G.PLAYER, { kind: 'player' });

    let endedPayload: { name: string; position: number; reward: number; time: number } | null = null;
    bus.on('raceEnded', (p) => {
      endedPayload = p;
    });

    // Start Sprint Race #1 ('canyon_sprint', 1 lap)
    const sprintIdx = layout.raceSpots.findIndex((r) => r.kind === 'sprint');
    races.start(sprintIdx, player);
    expect(races.active).not.toBeNull();
    expect(races.active!.opponents.length).toBe(3);
    expect(races.active!.countdown).toBeCloseTo(3.0);

    // Step through 3.1s countdown
    let time = 0;
    const dt = 0.1;
    for (let i = 0; i < 32; i++) {
      time += dt;
      races.update(dt, time, player, false, true);
      phys.step();
    }
    expect(races.active!.countdown).toBeLessThanOrEqual(0);

    // Verify AI opponents accelerate off the grid after GO!
    for (let i = 0; i < 15; i++) {
      time += dt;
      races.update(dt, time, player, false, true);
      phys.step();
    }
    const aiMoving = races.active!.opponents.some((o) => o.car.speed > 2);
    expect(aiMoving).toBe(true);

    // Teleport player through each checkpoint to win 1st place
    const cps = [...races.active!.def.checkpoints];
    const firstPrize = races.active!.def.prizes[0];
    for (const cp of cps) {
      time += dt;
      player.teleport(cp.x, cp.z, 0);
      races.update(dt, time, player, false, true);
    }

    expect(races.active).toBeNull();
    expect(endedPayload).not.toBeNull();
    expect(endedPayload!.position).toBe(1);
    expect(endedPayload!.reward).toBe(firstPrize);
  });
});
