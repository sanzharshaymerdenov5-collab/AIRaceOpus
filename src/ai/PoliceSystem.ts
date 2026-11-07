import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CITY, type CityLayout, type Lane } from '../city/CityLayout';
import { findPath } from './Pathfinder';
import { ArcadeVehicle } from '../physics/ArcadeVehicle';
import { G, groups, type PhysicsWorld } from '../physics/PhysicsWorld';
import { animateCarRig, buildCarMesh, type CarRig } from '../vehicles/CarMeshFactory';
import { COP_SPEC, COP_SUV_SPEC } from '../vehicles/carSpecs';
import type { HeatSystem } from '../gameplay/HeatSystem';
import { basic, lambert, lightPoolMat } from '../render/materials';
import { clamp, wrapAngle } from '../core/rng';

export type CopState = 'patrol' | 'pursue' | 'ram' | 'search';
export type CopRole = 'lead' | 'left' | 'right' | 'ahead';
const ROLES: CopRole[] = ['lead', 'left', 'right', 'ahead'];

export interface CopUnit {
  car: ArcadeVehicle;
  rig: CarRig;
  state: CopState;
  role: CopRole;
  lane: Lane;
  t: number;
  path: number[];
  repathTimer: number;
  seesPlayer: boolean;
  losTimer: number;
  stuckFor: number;
  damage: number;
}

interface Roadblock {
  group: THREE.Group;
  bodies: RAPIER.RigidBody[];
  colliders: RAPIER.Collider[];
  spikeX: number;
  spikeZ: number;
  hasSpikes: boolean;
  x: number;
  z: number;
}

/**
 * Police pursuit system:
 * - Patrol cruisers on the lane graph that can witness crimes via raycast LOS.
 * - Dynamic scaling up to 7 units (plus heavy SUVs at ★4+) during pursuit.
 * - A* intercept to predicted player position, switching to direct pursuit + PIT/box-in when close.
 * - Roadblocks + spike strips spawned ahead on the player's route at ★3+/★4+.
 * - Helicopter searchlight cone at ★5 that keeps the player spotted on open roads.
 */
export class PoliceSystem {
  readonly group = new THREE.Group();
  readonly units: CopUnit[] = [];
  readonly roadblocks: Roadblock[] = [];
  lastKnown = { x: 0, z: 0, vx: 0, vz: 0 };
  nearestDist = Infinity;
  anySees = false;
  nearestSiren?: { x: number; z: number; vx: number; vz: number };
  private rbCooldown = 0;

  // ★5 helicopter spotlight
  private heli: THREE.Group;
  heliX = 0;
  heliZ = 0;
  heliActive = false;

  constructor(
    private layout: CityLayout,
    private phys: PhysicsWorld,
  ) {
    this.heli = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(11, 55, 16, 1, true).translate(0, -27.5, 0),
      basic({ color: 0xdff4ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    cone.position.y = 55;
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2), lightPoolMat(0xe8f8ff, 0.75));
    pool.position.y = 0.08;
    this.heli.add(cone, pool);
    this.heli.visible = false;
    this.group.add(this.heli);
  }

  clear() {
    for (const u of this.units) {
      this.group.remove(u.rig.root);
      u.car.dispose();
    }
    this.units.length = 0;
    this.clearRoadblocks();
    this.heli.visible = false;
  }

  clearRoadblocks() {
    for (const r of this.roadblocks) {
      this.group.remove(r.group);
      for (const c of r.colliders) this.phys.unregister(c);
      for (const b of r.bodies) this.phys.world.removeRigidBody(b);
    }
    this.roadblocks.length = 0;
  }

  private removeUnit(i: number) {
    const u = this.units[i];
    this.group.remove(u.rig.root);
    u.car.dispose();
    this.units.splice(i, 1);
  }

  private desiredCount(heat: HeatSystem) {
    if (heat.mode === 'clean') return 3;
    if (heat.mode === 'pullover') return 3;
    return [3, 3, 4, 5, 6, 7][heat.stars] ?? 3;
  }

  private trySpawn(px: number, pz: number, pvX: number, pvZ: number, stars: number, pursuing: boolean) {
    const lanes = this.layout.graph.lanes;
    for (let k = 0; k < 20; k++) {
      const lane = lanes[Math.floor(Math.random() * lanes.length)];
      const t = lane.len * 0.5;
      const x = lane.sx + lane.dx * t;
      const z = lane.sz + lane.dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (pursuing ? d < 75 || d > 190 : d < 65 || d > 210) continue;
      if (this.units.some((u) => Math.hypot(u.car.x - x, u.car.z - z) < 15)) continue;
      // when pursuing, bias spawns ahead of the player
      if (pursuing && k < 12 && (x - px) * pvX + (z - pz) * pvZ < 0) continue;

      const suv = stars >= 4 && Math.random() < 0.45;
      const spec = suv ? COP_SUV_SPEC : COP_SPEC;
      const yaw = Math.atan2(lane.dx, lane.dz);
      const u: CopUnit = {
        car: new ArcadeVehicle(this.phys, spec, x, z, yaw, G.COP, { kind: 'cop' }),
        rig: buildCarMesh(spec, 0x111111),
        state: pursuing ? 'pursue' : 'patrol',
        role: ROLES[this.units.length % ROLES.length],
        lane,
        t,
        path: [],
        repathTimer: 0,
        seesPlayer: false,
        losTimer: Math.random() * 0.1,
        stuckFor: 0,
        damage: 0,
      };
      this.phys.register(u.car.collider, { kind: 'cop', ref: u });
      u.car.setForwardSpeed(pursuing ? 22 : lane.limit * 0.8);
      this.group.add(u.rig.root);
      this.units.push(u);
      return;
    }
  }

  private spawnRoadblock(px: number, pz: number, pvx: number, pvz: number, withSpikes: boolean) {
    const g = this.layout.graph;
    // pick an intersection ~150..240 m ahead of the player
    const sp = Math.hypot(pvx, pvz);
    const fx = sp > 2 ? pvx / sp : 0;
    const fz = sp > 2 ? pvz / sp : 1;
    const cand = g.intersections.filter((I) => {
      const dx = I.x - px;
      const dz = I.z - pz;
      const d = Math.hypot(dx, dz);
      return d > 130 && d < 230 && (dx * fx + dz * fz) / d > 0.55 && I.degree >= 3;
    });
    if (!cand.length) return;
    const I = cand[Math.floor(Math.random() * cand.length)];
    if (this.roadblocks.some((r) => Math.hypot(r.x - I.x, r.z - I.z) < 90)) return;

    const grp = new THREE.Group();
    const bodies: RAPIER.RigidBody[] = [];
    const colliders: RAPIER.Collider[] = [];
    const across = Math.abs(fx) > Math.abs(fz) ? 'z' : 'x'; // block perpendicular to travel
    const rotY = across === 'x' ? 0 : Math.PI / 2;

    // Two parked cruisers angled with a gap + wooden barriers
    for (const side of [-4.1, 4.1]) {
      const cx = I.x + (across === 'x' ? side : 0);
      const cz = I.z + (across === 'z' ? side : 0);
      const rig = buildCarMesh(COP_SPEC, 0x111111);
      rig.root.position.set(cx, 0, cz);
      rig.root.rotation.y = rotY + (side < 0 ? 0.18 : -0.18);
      if (rig.lightbar) rig.lightbar.poolRed.visible = true;
      grp.add(rig.root);
      const b = this.phys.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(cx, 0.55, cz)
          .setRotation({ x: 0, y: Math.sin(rig.root.rotation.y / 2), z: 0, w: Math.cos(rig.root.rotation.y / 2) })
          .enabledRotations(false, true, false)
          .setLinearDamping(3)
          .setAngularDamping(3),
      );
      const col = this.phys.world.createCollider(
        RAPIER.ColliderDesc.cuboid(COP_SPEC.width / 2, 0.45, COP_SPEC.length / 2).setMass(1900).setCollisionGroups(groups(G.COP, G.ALL)),
        b,
      );
      this.phys.register(col, { kind: 'cop' });
      bodies.push(b);
      colliders.push(col);
    }

    // Spike strip across the middle gap
    if (withSpikes) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(across === 'x' ? 3.6 : 0.45, 0.1, across === 'z' ? 3.6 : 0.45),
        lambert({ color: 0xffd000, emissive: 0x443300 }),
      );
      strip.position.set(I.x, 0.06, I.z);
      grp.add(strip);
    }
    this.group.add(grp);
    this.roadblocks.push({ group: grp, bodies, colliders, spikeX: I.x, spikeZ: I.z, hasSpikes: withSpikes, x: I.x, z: I.z });
  }

  /** Witness check: any cop with LOS within 85 m, or any speed camera within 35 m. */
  isWitnessed(px: number, pz: number, cameras: { x: number; z: number }[], checkCameras = false): boolean {
    for (const u of this.units) {
      const d = Math.hypot(u.car.x - px, u.car.z - pz);
      if (d < 85 && this.phys.lineOfSight(u.car.x, 1.2, u.car.z, px, 1.2, pz)) return true;
    }
    if (checkCameras) for (const c of cameras) if (Math.hypot(c.x - px, c.z - pz) < 38) return true;
    return false;
  }

  update(dt: number, time: number, player: ArcadeVehicle, heat: HeatSystem) {
    const px = player.x;
    const pz = player.z;
    const pv = player.body.linvel();
    const pursuing = heat.mode === 'pursuit' || heat.mode === 'cooldown';
    const want = this.desiredCount(heat);
    while (this.units.length < want) {
      const n = this.units.length;
      this.trySpawn(px, pz, pv.x, pv.z, heat.stars, pursuing);
      if (this.units.length === n) break;
    }

    // Roadblocks at ★3+
    this.rbCooldown -= dt;
    if (heat.mode === 'pursuit' && heat.stars >= 3 && this.roadblocks.length < 2 && this.rbCooldown <= 0) {
      this.spawnRoadblock(px, pz, pv.x, pv.z, heat.stars >= 4);
      this.rbCooldown = 14;
    }
    for (let i = this.roadblocks.length - 1; i >= 0; i--) {
      const r = this.roadblocks[i];
      if (r.hasSpikes && player.spikedTime <= 0 && Math.hypot(px - r.spikeX, pz - r.spikeZ) < 2.4) {
        player.spikedTime = 8;
      }
      if (!pursuing || Math.hypot(px - r.x, pz - r.z) > 280) {
        this.group.remove(r.group);
        for (const c of r.colliders) this.phys.unregister(c);
        for (const b of r.bodies) this.phys.world.removeRigidBody(b);
        this.roadblocks.splice(i, 1);
      }
    }

    // ★5 Helicopter
    this.heliActive = pursuing && heat.stars >= 5;
    this.heli.visible = this.heliActive;
    let heliSees = false;
    if (this.heliActive) {
      const tx = px + pv.x * 0.8 + Math.sin(time * 0.9) * 8;
      const tz = pz + pv.z * 0.8 + Math.cos(time * 0.7) * 8;
      this.heliX += (tx - this.heliX) * Math.min(1, dt * 1.8);
      this.heliZ += (tz - this.heliZ) * Math.min(1, dt * 1.8);
      this.heli.position.set(this.heliX, 0, this.heliZ);
      heliSees = Math.hypot(this.heliX - px, this.heliZ - pz) < 16 && this.phys.lineOfSight(this.heliX, 50, this.heliZ, px, 1.2, pz);
    } else {
      this.heliX = px;
      this.heliZ = pz;
    }

    this.nearestDist = Infinity;
    this.anySees = heliSees;
    this.nearestSiren = undefined;
    const g = this.layout.graph;

    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const c = u.car;
      const d = Math.hypot(c.x - px, c.z - pz);
      if (d < this.nearestDist) {
        this.nearestDist = d;
        if (u.state !== 'patrol') {
          const v = c.body.linvel();
          this.nearestSiren = { x: c.x, z: c.z, vx: v.x, vz: v.z };
        }
      }
      if (d > 260 || (u.stuckFor > 5 && d > 45)) {
        this.removeUnit(i);
        continue;
      }

      if (c.lastDeltaV > 6) u.damage = Math.min(1, u.damage + c.lastDeltaV * 0.02);

      // 10 Hz line-of-sight check
      u.losTimer -= dt;
      if (u.losTimer <= 0) {
        u.losTimer = 0.1;
        u.seesPlayer = d < 120 && this.phys.lineOfSight(c.x, 1.2, c.z, px, 1.2, pz);
      }
      if (u.seesPlayer) {
        this.anySees = true;
        this.lastKnown = { x: px, z: pz, vx: pv.x, vz: pv.z };
      }

      // State transitions
      if (heat.mode === 'clean') u.state = 'patrol';
      else if (heat.mode === 'pullover') u.state = d < 140 ? 'pursue' : 'patrol';
      else if (heat.mode === 'pursuit') u.state = d < 16 && heat.stars >= 2 ? 'ram' : 'pursue';
      else if (heat.mode === 'cooldown') u.state = u.seesPlayer ? 'pursue' : 'search';

      // Steering + speed per state
      let tx = c.x + c.fwdX * 10;
      let tz = c.z + c.fwdZ * 10;
      let vTarget = 14;
      c.topSpeedScale = 1;

      if (u.state === 'patrol') {
        u.t = (c.x - u.lane.sx) * u.lane.dx + (c.z - u.lane.sz) * u.lane.dz;
        if (u.t > u.lane.len - 2) {
          const succ = g.successors(u.lane);
          u.lane = succ[Math.floor(Math.random() * succ.length)];
          u.t = 0;
        }
        const lt = Math.min(u.lane.len, Math.max(0, u.t) + 10);
        tx = u.lane.sx + u.lane.dx * lt;
        tz = u.lane.sz + u.lane.dz * lt;
        vTarget = u.lane.limit * 0.85;
      } else {
        // target point: predicted player pos (pursue/ram) or last known + search wander
        let goalX = this.lastKnown.x;
        let goalZ = this.lastKnown.z;
        if (u.state === 'pursue' || u.state === 'ram') {
          const lead = clamp(d / 38, 0, 1.6);
          goalX = px + pv.x * lead;
          goalZ = pz + pv.z * lead;
        } else {
          goalX += this.lastKnown.vx * 2 + Math.sin(time * 0.7 + i * 2) * 45;
          goalZ += this.lastKnown.vz * 2 + Math.cos(time * 0.6 + i * 2) * 45;
        }

        if (d < 52 && u.seesPlayer && u.state !== 'search') {
          // Direct tactical pursuit: formation offset around the player
          const pfx = player.fwdX;
          const pfz = player.fwdZ;
          const prx = -pfz;
          const prz = pfx;
          if (u.state === 'ram' || u.role === 'lead') {
            // PIT: aim at rear quarter panel
            const side = c.x * prx + c.z * prz > px * prx + pz * prz ? 1 : -1;
            tx = px - pfx * 1.8 + prx * side * 1.1;
            tz = pz - pfz * 1.8 + prz * side * 1.1;
          } else if (u.role === 'left') {
            tx = px + pfx * 2 - prx * 2.6;
            tz = pz + pfz * 2 - prz * 2.6;
          } else if (u.role === 'right') {
            tx = px + pfx * 2 + prx * 2.6;
            tz = pz + pfz * 2 + prz * 2.6;
          } else {
            // 'ahead' tries to get in front and brake-check
            tx = px + pfx * 9;
            tz = pz + pfz * 9;
          }
          vTarget = heat.mode === 'pullover' ? Math.max(12, Math.abs(player.speed) + 4) : 70;
          // Rubber-band: boost when far behind, ease slightly when right on top
          c.topSpeedScale = d > 35 ? 1.18 : 1.02;
        } else {
          // A* on intersection graph
          u.repathTimer -= dt;
          if (u.repathTimer <= 0 || u.path.length === 0) {
            u.repathTimer = 0.6;
            const sI = g.nearestIntersection(c.x, c.z).id;
            const gI = g.nearestIntersection(goalX, goalZ).id;
            u.path = findPath(g, sI, gI) ?? [gI];
          }
          while (u.path.length > 1) {
            const nI = g.intersections[u.path[0]];
            if (Math.hypot(nI.x - c.x, nI.z - c.z) < CITY.ROAD) u.path.shift();
            else break;
          }
          const wp = g.intersections[u.path[0]];
          tx = wp ? wp.x : goalX;
          tz = wp ? wp.z : goalZ;
          vTarget = u.state === 'search' ? 24 : 58;
          c.topSpeedScale = d > 90 ? 1.25 : 1.1;
        }
      }

      const desiredYaw = Math.atan2(tx - c.x, tz - c.z);
      const diff = wrapAngle(desiredYaw - c.yaw);
      let steer = clamp(-diff * 2.4, -1, 1);
      // Whisker ray obstacle avoidance (buildings)
      const hitC = this.phys.castForward(c.x, 0.7, c.z, c.fwdX, c.fwdZ, 12, c.body, G.STATIC);
      if (hitC) {
        const lYaw = c.yaw + 0.45;
        const hitL = this.phys.castForward(c.x, 0.7, c.z, Math.sin(lYaw), Math.cos(lYaw), 12, c.body, G.STATIC);
        steer = hitL ? 1 : -1;
        vTarget = Math.min(vTarget, 14);
      }
      if (Math.abs(diff) > 0.6) vTarget = Math.min(vTarget, 18);

      // Reverse unstuck if wedged against a wall
      if (u.state !== 'patrol' && Math.abs(c.speed) < 1.2) u.stuckFor += dt;
      else u.stuckFor = Math.max(0, u.stuckFor - dt);

      if (u.stuckFor > 1.3 && u.stuckFor < 2.6) {
        c.input = { throttle: 0, brake: 1, steer: -steer, handbrake: false, nitro: false };
      } else {
        const err = vTarget - c.speed;
        c.input = {
          throttle: err > 0 ? clamp(err / 8, 0.2, 1) : 0,
          brake: err < -3 ? clamp(-err / 14, 0.2, 1) : 0,
          steer,
          handbrake: Math.abs(diff) > 1.1 && c.speed > 18,
          nitro: false,
        };
      }

      c.update(dt);
      u.rig.root.position.set(c.x, 0, c.z);
      u.rig.root.rotation.y = c.yaw;
      animateCarRig(u.rig, dt, c.speed, c.input.steer, c.input.brake > 0.1, false, u.state !== 'patrol', u.damage, time + i * 0.17);
    }
  }
}
