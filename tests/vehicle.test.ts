import { beforeAll, describe, expect, it } from 'vitest';
import { PhysicsWorld, initPhysics, G } from '../src/physics/PhysicsWorld';
import { ArcadeVehicle } from '../src/physics/ArcadeVehicle';
import { PLAYER_CARS } from '../src/vehicles/carSpecs';

beforeAll(async () => {
  await initPhysics();
});

function sim(specIdx: number) {
  const phys = new PhysicsWorld();
  phys.addGround(5000);
  const car = new ArcadeVehicle(phys, PLAYER_CARS[specIdx].spec, 0, 0, 0, G.PLAYER, { kind: 'player' });
  const step = (n: number) => {
    for (let k = 0; k < n; k++) {
      car.update(1 / 60);
      phys.step();
    }
  };
  return { phys, car, step };
}

describe('arcade vehicle', () => {
  for (let i = 0; i < PLAYER_CARS.length; i++) {
    const def = PLAYER_CARS[i];
    it(`${def.spec.name} reaches its top speed (±10%)`, () => {
      const { car, step } = sim(i);
      car.input = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
      step(60 * 20);
      expect(car.speed).toBeGreaterThan(def.spec.topSpeed * 0.9);
      expect(car.speed).toBeLessThan(def.spec.topSpeed * 1.1);
      // drove straight along +z
      expect(Math.abs(car.x)).toBeLessThan(1);
      expect(car.z).toBeGreaterThan(100);
    });
  }

  it('brakes from top speed within a reasonable distance', () => {
    const { car, step } = sim(0);
    car.input = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
    step(60 * 20);
    const z0 = car.z;
    const v0 = car.speed;
    car.input = { throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false };
    let n = 0;
    while (car.speed > 0.5 && n++ < 600) step(1);
    const dist = car.z - z0;
    const ideal = (v0 * v0) / (2 * car.spec.brake);
    expect(dist).toBeLessThan(ideal * 1.4);
    expect(dist).toBeGreaterThan(ideal * 0.6);
  });

  it('positive steer turns right (towards -x when heading +z)', () => {
    const { car, step } = sim(0);
    car.input = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
    step(120);
    car.input.steer = 1;
    step(60);
    expect(car.x).toBeLessThan(-1);
  });

  it('nitro boosts beyond normal top speed and drains the tank', () => {
    const { car, step } = sim(0);
    car.input = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: true };
    step(60 * 3);
    expect(car.nitro).toBeLessThan(0.3);
    car.input.nitro = false;
    const { car: car2, step: step2 } = sim(0);
    car2.input = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false };
    step2(60 * 3);
    expect(car.speed).toBeGreaterThan(car2.speed);
  });

  it('never flips over (roll/pitch locked)', () => {
    const { car, step } = sim(1);
    car.input = { throttle: 1, brake: 0, steer: 1, handbrake: true, nitro: true };
    step(600);
    const r = car.body.rotation();
    expect(Math.abs(r.x)).toBeLessThan(1e-3);
    expect(Math.abs(r.z)).toBeLessThan(1e-3);
  });
});
