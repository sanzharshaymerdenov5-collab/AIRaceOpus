import * as THREE from 'three';
import type { CityLayout, Lane } from '../city/CityLayout';
import { lightState } from '../city/TrafficLights';
import { ArcadeVehicle } from '../physics/ArcadeVehicle';
import { G, type PhysicsWorld } from '../physics/PhysicsWorld';
import { animateCarRig, buildCarMesh, type CarRig } from '../vehicles/CarMeshFactory';
import { TRAFFIC_COLORS, TRAFFIC_SPECS } from '../vehicles/carSpecs';
import { clamp, wrapAngle } from '../core/rng';

export interface TrafficUnit {
  car: ArcadeVehicle;
  rig: CarRig;
  lane: Lane;
  t: number; // progress along lane
  crashedFor: number; // >0 = ragdoll
  stuckFor: number;
}

/**
 * Ambient traffic on the lane graph: pure-pursuit steering, IDM-style spacing,
 * obeys red/yellow lights, yields to nearby sirens, and goes ragdoll when hit.
 */
export class TrafficSystem {
  readonly group = new THREE.Group();
  readonly units: TrafficUnit[] = [];
  targetCount = 34;

  constructor(
    private layout: CityLayout,
    private phys: PhysicsWorld,
  ) {}

  clear() {
    for (const u of this.units) {
      this.group.remove(u.rig.root);
      u.car.dispose();
    }
    this.units.length = 0;
  }

  clearNear(x: number, z: number, radius: number) {
    for (let i = this.units.length - 1; i >= 0; i--) {
      if (Math.hypot(this.units[i].car.x - x, this.units[i].car.z - z) < radius) {
        this.remove(i);
      }
    }
  }

  private remove(idx: number) {
    const u = this.units[idx];
    this.group.remove(u.rig.root);
    u.car.dispose();
    this.units.splice(idx, 1);
  }

  private trySpawn(px: number, pz: number, camFwdX: number, camFwdZ: number) {
    const lanes = this.layout.graph.lanes;
    for (let attempt = 0; attempt < 16; attempt++) {
      const lane = lanes[Math.floor(Math.random() * lanes.length)];
      const t = 10 + Math.random() * Math.max(5, lane.len - 20);
      const x = lane.sx + lane.dx * t;
      const z = lane.sz + lane.dz * t;
      const dx = x - px;
      const dz = z - pz;
      const d = Math.hypot(dx, dz);
      if (d < 85 || d > 230) continue;
      // prefer spawning outside the forward view cone when close
      if (d < 140 && (dx * camFwdX + dz * camFwdZ) / d > 0.65) continue;
      if (this.units.some((u) => Math.hypot(u.car.x - x, u.car.z - z) < 14)) continue;

      const spec = TRAFFIC_SPECS[Math.floor(Math.random() * TRAFFIC_SPECS.length)];
      const color = spec.style === 'taxi' ? 0xffc800 : TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)];
      const yaw = Math.atan2(lane.dx, lane.dz);
      const u: TrafficUnit = {
        car: new ArcadeVehicle(this.phys, spec, x, z, yaw, G.TRAFFIC, { kind: 'traffic' }),
        rig: buildCarMesh(spec, color),
        lane,
        t,
        crashedFor: 0,
        stuckFor: 0,
      };
      u.car.collider && this.phys.register(u.car.collider, { kind: 'traffic', ref: u });
      u.car.setForwardSpeed(lane.limit * 0.75);
      this.group.add(u.rig.root);
      this.units.push(u);
      return;
    }
  }

  /** Mark a traffic unit as knocked off its rails. */
  notifyHit(u: TrafficUnit) {
    u.crashedFor = 5;
    u.car.uncontrolled = true;
  }

  update(dt: number, time: number, px: number, pz: number, camFwdX: number, camFwdZ: number, sirenPos?: { x: number; z: number }) {
    while (this.units.length < this.targetCount) {
      const before = this.units.length;
      this.trySpawn(px, pz, camFwdX, camFwdZ);
      if (this.units.length === before) break;
    }

    const g = this.layout.graph;
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const c = u.car;
      const distPlayer = Math.hypot(c.x - px, c.z - pz);
      if (distPlayer > 270 || (u.stuckFor > 8 && distPlayer > 60)) {
        this.remove(i);
        continue;
      }

      if (c.lastDeltaV > 3.5) this.notifyHit(u);

      if (u.crashedFor > 0) {
        u.crashedFor -= dt;
        if (u.crashedFor <= 0) {
          c.uncontrolled = false;
          const near = g.nearestLane(c.x, c.z, c.fwdX, c.fwdZ);
          u.lane = near.lane;
          u.t = near.t;
        }
      } else {
        // advance along lane, transition when reaching intersection
        u.t = (c.x - u.lane.sx) * u.lane.dx + (c.z - u.lane.sz) * u.lane.dz;
        if (u.t > u.lane.len - 2) {
          const succ = g.successors(u.lane);
          // weight straight-ahead higher than turns
          const straight = succ.find((s) => s.axis === u.lane.axis);
          u.lane = straight && Math.random() < 0.65 ? straight : succ[Math.floor(Math.random() * succ.length)];
          u.t = 0;
        }
        // look-ahead point (pull over to the right if a siren is near)
        const pull = sirenPos && Math.hypot(c.x - sirenPos.x, c.z - sirenPos.z) < 42 ? 1.8 : 0;
        const lookT = Math.min(u.lane.len, Math.max(0, u.t) + 9);
        const rx = -u.lane.dz;
        const rz = u.lane.dx;
        const tx = u.lane.sx + u.lane.dx * lookT + rx * pull;
        const tz = u.lane.sz + u.lane.dz * lookT + rz * pull;
        const desiredYaw = Math.atan2(tx - c.x, tz - c.z);
        const diff = wrapAngle(desiredYaw - c.yaw);
        const steer = clamp(-diff * 2.2, -1, 1);

        // target speed: lane limit, turns, traffic lights, obstacle ahead
        let vTarget = u.lane.limit * (pull ? 0.25 : 0.9);
        if (Math.abs(diff) > 0.25) vTarget = Math.min(vTarget, 9);
        const rem = u.lane.len - u.t;
        const I = g.intersections[u.lane.to];
        const sig = lightState(I, u.lane.axis, time);
        if (sig !== 'green' && rem < 22 && rem > -1) {
          vTarget = Math.min(vTarget, Math.max(0, (rem - 3.5) * 0.75));
        }
        const hit = this.phys.castForward(c.x, 0.6, c.z, c.fwdX, c.fwdZ, 18, c.body);
        if (hit) vTarget = Math.min(vTarget, Math.max(0, (hit.dist - 5) * 1.1));

        const err = vTarget - c.speed;
        c.input = {
          throttle: err > 0.5 ? clamp(err / 6, 0.15, 0.85) : 0,
          brake: err < -0.8 ? clamp(-err / 8, 0.2, 1) : 0,
          steer,
          handbrake: false,
          nitro: false,
        };
        if (Math.abs(c.speed) < 0.5 && sig === 'green') u.stuckFor += dt;
        else u.stuckFor = 0;
      }

      c.update(dt);
      u.rig.root.position.set(c.x, 0, c.z);
      u.rig.root.rotation.y = c.yaw;
      animateCarRig(u.rig, dt, c.speed, c.input.steer, c.input.brake > 0.1 || u.crashedFor > 0, false, false, u.crashedFor > 0 ? 0.5 : 0, time);
    }
  }
}
