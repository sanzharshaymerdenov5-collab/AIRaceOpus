import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CITY, type CityLayout, type Lane } from '../city/CityLayout';
import { findPath, pathLength } from './Pathfinder';
import { PoliceDirector, type DirectorUnitView, type LastKnownSighting, type TacticalRole } from './PoliceDirector';
import { ArcadeVehicle } from '../physics/ArcadeVehicle';
import { G, groups, type PhysicsWorld } from '../physics/PhysicsWorld';
import { animateCarRig, buildCarMesh, buildHeliMesh, type CarRig, type HeliRig } from '../vehicles/CarMeshFactory';
import { COP_SPEC, COP_SUV_SPEC } from '../vehicles/carSpecs';
import type { HeatSystem } from '../gameplay/HeatSystem';
import { basic, lambert, lightPoolMat } from '../render/materials';
import { clamp, wrapAngle } from '../core/rng';

/** Seconds of lost LOS tolerated before the squad switches from pursuit roles to search (bridges pole occlusions). */
const CONTACT_GRACE = 0.25;
/** Planning deceleration (m/s²) used to brake ahead of corners. Conservative vs. the 30 m/s² brake. */
const CORNER_DECEL = 15;

export type CopState = 'patrol' | 'pursue' | 'ram' | 'search';
export type CopRole = TacticalRole;

export interface CopUnit {
  id: number;
  car: ArcadeVehicle;
  rig: CarRig;
  state: CopState;
  role: CopRole;
  lane: Lane;
  t: number;
  path: number[];
  pathGoal: number;
  repathTimer: number;
  targetInter: number;
  targetX: number;
  targetZ: number;
  seesPlayer: boolean;
  losTimer: number;
  stuckFor: number;
  /** Seconds left in the current reverse-out manoeuvre. */
  reverseFor: number;
  reverseSteer: number;
  /** How many unstuck attempts in a row (decays while driving freely). */
  stuckCount: number;
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
 * Police pursuit system coordinated by `PoliceDirector`:
 * - Patrol cruisers on the lane graph that can witness crimes via raycast LOS.
 * - Shared Last Known Position (LKP) & velocity updated only when a cop, camera, or helicopter spots the player.
 * - Dynamic tactical roles (Lead PIT, Left/Right box-in flankers, forward A* Interceptors).
 * - Coordinated LKP verification + expanding-ring sector search when LOS is broken.
 * - Roadblocks + spike strips at ★3+/★4+, and ★5 helicopter spotlight.
 */
export class PoliceSystem {
  readonly group = new THREE.Group();
  readonly units: CopUnit[] = [];
  readonly roadblocks: Roadblock[] = [];
  readonly director: PoliceDirector;
  nearestDist = Infinity;
  anySees = false;
  nearestSiren?: { x: number; z: number; vx: number; vz: number };
  private rbCooldown = 0;
  private nextId = 1;

  // ★5 helicopter spotlight
  private heli: THREE.Group;
  private heliRig: HeliRig;
  private heliYaw = 0;
  private heliPrevX = 0;
  private heliPrevZ = 0;
  heliX = 0;
  heliZ = 0;
  heliActive = false;
  /** Game time of the last confirmed visual on the player (any unit or the heli). */
  private lastSeenAt = -999;

  constructor(
    private layout: CityLayout,
    private phys: PhysicsWorld,
  ) {
    this.director = new PoliceDirector(layout.graph);
    this.heli = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(11, 55, 16, 1, true).translate(0, -27.5, 0),
      basic({ color: 0xdff4ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    cone.position.y = 55;
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2), lightPoolMat(0xe8f8ff, 0.75));
    pool.position.y = 0.08;
    this.heliRig = buildHeliMesh();
    this.heliRig.root.position.y = 56.2;
    this.heli.add(cone, pool, this.heliRig.root);
    this.heli.visible = false;
    this.group.add(this.heli);
  }

  private animateHeli(dt: number, time: number) {
    if (!this.heliActive) return;
    const vx = (this.heliX - this.heliPrevX) / Math.max(dt, 1e-4);
    const vz = (this.heliZ - this.heliPrevZ) / Math.max(dt, 1e-4);
    this.heliPrevX = this.heliX;
    this.heliPrevZ = this.heliZ;
    const sp = Math.hypot(vx, vz);
    if (sp > 1) this.heliYaw += wrapAngle(Math.atan2(vx, vz) - this.heliYaw) * Math.min(1, dt * 2);
    const r = this.heliRig;
    r.root.rotation.y = this.heliYaw;
    // Nose-down pitch with forward speed, gentle bob
    r.body.rotation.x = clamp(sp * 0.012, 0, 0.22);
    r.root.position.y = 56.2 + Math.sin(time * 1.3) * 0.35;
    r.rotor.rotation.y += dt * 38;
    r.tailRotor.rotation.x += dt * 55;
    r.strobe.visible = Math.floor(time * 2.5) % 3 === 0;
  }

  get lastKnown(): LastKnownSighting {
    return this.director.lastKnown;
  }
  set lastKnown(v: { x: number; z: number; vx: number; vz: number }) {
    this.director.reportSighting(v.x, v.z, v.vx, v.vz, 0);
  }

  /** Report a confirmed player sighting (e.g. witnessed crime or speed camera). */
  reportSighting(x: number, z: number, vx: number, vz: number, time: number) {
    this.director.reportSighting(x, z, vx, vz, time);
  }

  clear() {
    for (const u of this.units) {
      this.group.remove(u.rig.root);
      u.car.dispose();
    }
    this.units.length = 0;
    this.clearRoadblocks();
    this.director.reset();
    this.heli.visible = false;
    this.lastSeenAt = -999;
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

  private trySpawn(refX: number, refZ: number, dirX: number, dirZ: number, px: number, pz: number, stars: number, pursuing: boolean) {
    const lanes = this.layout.graph.lanes;
    for (let k = 0; k < 24; k++) {
      const lane = lanes[Math.floor(Math.random() * lanes.length)];
      const t = lane.len * 0.5;
      const x = lane.sx + lane.dx * t;
      const z = lane.sz + lane.dz * t;
      // Never pop a cop right in front of the player's camera
      const dPlayer = Math.hypot(x - px, z - pz);
      if (dPlayer < 72) continue;
      const dRef = Math.hypot(x - refX, z - refZ);
      if (pursuing ? dRef < 65 || dRef > 210 : dPlayer > 215) continue;
      if (this.units.some((u) => Math.hypot(u.car.x - x, u.car.z - z) < 15)) continue;
      // When pursuing/searching, bias reinforcement spawns ahead of the LKP escape direction
      if (pursuing && k < 15 && (x - refX) * dirX + (z - refZ) * dirZ < 0) continue;

      const suv = stars >= 4 && Math.random() < 0.45;
      const spec = suv ? COP_SUV_SPEC : COP_SPEC;
      const yaw = Math.atan2(lane.dx, lane.dz);
      const interId = this.layout.graph.nearestIntersection(x, z).id;
      const u: CopUnit = {
        id: this.nextId++,
        car: new ArcadeVehicle(this.phys, spec, x, z, yaw, G.COP, { kind: 'cop' }),
        rig: buildCarMesh(spec, 0x111111),
        state: pursuing ? 'search' : 'patrol',
        role: 'lead',
        lane,
        t,
        path: [],
        pathGoal: -1,
        repathTimer: 0,
        targetInter: interId,
        targetX: refX,
        targetZ: refZ,
        seesPlayer: false,
        losTimer: Math.random() * 0.08,
        stuckFor: 0,
        reverseFor: 0,
        reverseSteer: 0,
        stuckCount: 0,
        damage: 0,
      };
      this.phys.register(u.car.collider, { kind: 'cop', ref: u });
      u.car.setForwardSpeed(pursuing ? 24 : lane.limit * 0.8);
      this.group.add(u.rig.root);
      this.units.push(u);
      return;
    }
  }

  private spawnRoadblock(refX: number, refZ: number, fx: number, fz: number, px: number, pz: number, withSpikes: boolean) {
    const g = this.layout.graph;
    const cand = g.intersections.filter((I) => {
      const dx = I.x - refX;
      const dz = I.z - refZ;
      const d = Math.hypot(dx, dz);
      const dPlayer = Math.hypot(I.x - px, I.z - pz);
      return d > 120 && d < 235 && dPlayer > 95 && (dx * fx + dz * fz) / d > 0.5 && I.degree >= 3;
    });
    if (!cand.length) return;
    const I = cand[Math.floor(Math.random() * cand.length)];
    if (this.roadblocks.some((r) => Math.hypot(r.x - I.x, r.z - I.z) < 90)) return;

    const grp = new THREE.Group();
    const bodies: RAPIER.RigidBody[] = [];
    const colliders: RAPIER.Collider[] = [];
    const across = Math.abs(fx) > Math.abs(fz) ? 'z' : 'x';
    const rotY = across === 'x' ? 0 : Math.PI / 2;

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

  /** Witness check: any cop with LOS within 95 m, or any speed camera within 38 m. */
  isWitnessed(px: number, pz: number, cameras: { x: number; z: number }[], checkCameras = false): boolean {
    for (const u of this.units) {
      const d = Math.hypot(u.car.x - px, u.car.z - pz);
      if (d < 95 && this.phys.lineOfSight(u.car.x, 1.2, u.car.z, px, 1.2, pz)) return true;
    }
    if (checkCameras) for (const c of cameras) if (Math.hypot(c.x - px, c.z - pz) < 38) return true;
    return false;
  }

  /** Check whether a cop can see the player (forward/side vision cone up to 145 m, or 48 m 360° proximity). */
  private checkUnitLOS(u: CopUnit, px: number, pz: number, d: number): boolean {
    if (d > 145) return false;
    if (d > 48) {
      const dx = (px - u.car.x) / d;
      const dz = (pz - u.car.z) / d;
      // Forward/side field of view (~215 degrees)
      if (dx * u.car.fwdX + dz * u.car.fwdZ < -0.3) return false;
    }
    return this.phys.lineOfSight(u.car.x, 1.2, u.car.z, px, 1.2, pz);
  }

  update(dt: number, time: number, player: ArcadeVehicle, heat: HeatSystem) {
    const px = player.x;
    const pz = player.z;
    const pv = player.body.linvel();
    const g = this.layout.graph;

    if (heat.mode === 'clean') {
      if (this.director.lastKnown.active) this.director.reset();
    } else if (!this.director.lastKnown.active) {
      // Pursuit or pullover just started (e.g. speed camera, job start, or witnessed crime)
      this.director.reportSighting(px, pz, pv.x, pv.z, time);
    }

    const pursuing = heat.mode !== 'clean';
    const lk = this.director.lastKnown;
    const spawnRefX = pursuing && lk.active ? lk.x : px;
    const spawnRefZ = pursuing && lk.active ? lk.z : pz;
    const spawnDirX = pursuing && lk.active ? lk.dirX : player.fwdX;
    const spawnDirZ = pursuing && lk.active ? lk.dirZ : player.fwdZ;

    const want = this.desiredCount(heat);
    while (this.units.length < want) {
      const n = this.units.length;
      this.trySpawn(spawnRefX, spawnRefZ, spawnDirX, spawnDirZ, px, pz, heat.stars, pursuing);
      if (this.units.length === n) break;
    }

    // ★5 Helicopter tracks around LKP when searching, or live position when in sight
    this.heliActive = pursuing && heat.stars >= 5;
    this.heli.visible = this.heliActive;
    let heliSees = false;
    if (this.heliActive) {
      const hGoalX = (this.anySees ? px : lk.x + lk.dirX * 45) + Math.sin(time * 0.9) * 18;
      const hGoalZ = (this.anySees ? pz : lk.z + lk.dirZ * 45) + Math.cos(time * 0.7) * 18;
      this.heliX += (hGoalX - this.heliX) * Math.min(1, dt * 1.6);
      this.heliZ += (hGoalZ - this.heliZ) * Math.min(1, dt * 1.6);
      this.heli.position.set(this.heliX, 0, this.heliZ);
      heliSees = Math.hypot(this.heliX - px, this.heliZ - pz) < 22 && this.phys.lineOfSight(this.heliX, 50, this.heliZ, px, 1.2, pz);
    } else {
      this.heliX = px;
      this.heliZ = pz;
    }

    // 1. Update LOS for all units and feed sightings into the AI Director
    this.nearestDist = Infinity;
    this.anySees = heliSees;
    this.nearestSiren = undefined;

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
      const dAnchor = pursuing && lk.active ? Math.min(d, Math.hypot(c.x - lk.x, c.z - lk.z)) : d;
      if (dAnchor > 275 || (u.stuckCount >= 4 && d > 45)) {
        this.removeUnit(i);
        continue;
      }

      if (c.lastDeltaV > 6) u.damage = Math.min(1, u.damage + c.lastDeltaV * 0.02);

      u.losTimer -= dt;
      if (u.losTimer <= 0 || pursuing) {
        u.losTimer = 0.08;
        u.seesPlayer = this.checkUnitLOS(u, px, pz, d);
      }
      if (u.seesPlayer) this.anySees = true;
    }

    if (this.anySees) this.lastSeenAt = time;
    // Brief LOS drop-outs (lamp posts, traffic) shouldn't flip the squad between pursuit and search roles
    const contact = this.anySees || time - this.lastSeenAt < CONTACT_GRACE;

    if (this.anySees && heat.mode !== 'clean') {
      this.director.reportSighting(px, pz, pv.x, pv.z, time);
    } else if (heat.mode !== 'clean' && !contact) {
      for (const u of this.units) {
        this.director.recordUnitPosition(u.car.x, u.car.z, time);
      }
    }

    // Roadblocks at ★3+ placed ahead of LKP escape direction
    this.rbCooldown -= dt;
    if (heat.mode === 'pursuit' && heat.stars >= 3 && this.roadblocks.length < 2 && this.rbCooldown <= 0 && lk.active) {
      this.spawnRoadblock(lk.x, lk.z, lk.dirX, lk.dirZ, px, pz, heat.stars >= 4);
      this.rbCooldown = 12;
    }
    for (let i = this.roadblocks.length - 1; i >= 0; i--) {
      const r = this.roadblocks[i];
      if (r.hasSpikes && player.spikedTime <= 0 && Math.hypot(px - r.spikeX, pz - r.spikeZ) < 2.6) {
        player.spikedTime = 8;
        this.director.reportSighting(px, pz, pv.x, pv.z, time);
      }
      if (!pursuing || Math.hypot(px - r.x, pz - r.z) > 290) {
        this.group.remove(r.group);
        for (const c of r.colliders) this.phys.unregister(c);
        for (const b of r.bodies) this.phys.world.removeRigidBody(b);
        this.roadblocks.splice(i, 1);
      }
    }

    // 2. Ask the AI Director to assign tactical roles and search/intercept targets
    if (heat.mode !== 'clean' && lk.active) {
      const views: DirectorUnitView[] = this.units.map((u) => ({
        id: u.id,
        x: u.car.x,
        z: u.car.z,
        dirX: u.car.fwdX,
        dirZ: u.car.fwdZ,
        seesPlayer: u.seesPlayer,
        role: u.role,
        targetInter: u.targetInter,
        targetX: u.targetX,
        targetZ: u.targetZ,
      }));
      this.director.coordinate(views, time, contact);
      views.forEach((v, idx) => {
        const u = this.units[idx];
        u.role = v.role;
        u.targetInter = v.targetInter;
        u.targetX = v.targetX;
        u.targetZ = v.targetZ;
      });
    }

    // 3. Execute steering and speed control per unit
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const c = u.car;
      const d = Math.hypot(c.x - px, c.z - pz);

      if (heat.mode === 'clean') u.state = 'patrol';
      else if (!contact) u.state = 'search';
      else u.state = d < 17 && heat.stars >= 2 && u.role !== 'intercept' ? 'ram' : 'pursue';

      let tx = c.x + c.fwdX * 10;
      let tz = c.z + c.fwdZ * 10;
      let vTarget = 14;
      const holding = false;
      c.topSpeedScale = 1;
      const distToLkp = Math.hypot(c.x - lk.x, c.z - lk.z);
      const sameXCorridor = Math.abs(c.x - lk.x) <= CITY.ROAD * 0.65 && Math.abs(c.z - lk.z) <= CITY.SPACING * 1.05;
      const sameZCorridor = Math.abs(c.z - lk.z) <= CITY.ROAD * 0.65 && Math.abs(c.x - lk.x) <= CITY.SPACING * 1.05;
      const onLkpCorridor =
        (sameXCorridor || sameZCorridor || (!g.onRoad(lk.x, lk.z) && distToLkp < 42)) &&
        this.phys.lineOfSight(c.x, 1.2, c.z, lk.x, 1.2, lk.z);

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
      } else if (u.seesPlayer && (u.role !== 'intercept' || d < 95)) {
        // Direct tactical engagement whenever unit has line of sight to the player
        const pfx = player.fwdX;
        const pfz = player.fwdZ;
        const prx = -pfz;
        const prz = pfx;
        if (d > 48) {
          const lead = clamp(d / 45, 0, 1.1);
          tx = px + pv.x * lead;
          tz = pz + pv.z * lead;
        } else if (u.state === 'ram' || u.role === 'lead') {
          const side = c.x * prx + c.z * prz > px * prx + pz * prz ? 1 : -1;
          tx = px - pfx * 1.8 + prx * side * 1.1;
          tz = pz - pfz * 1.8 + prz * side * 1.1;
        } else if (u.role === 'left') {
          tx = px + pfx * 2.2 - prx * 2.6;
          tz = pz + pfz * 2.2 - prz * 2.6;
        } else {
          tx = px + pfx * 2.2 + prx * 2.6;
          tz = pz + pfz * 2.2 + prz * 2.6;
        }
        vTarget = heat.mode === 'pullover' ? Math.max(18, Math.abs(player.speed) + 8) : 70;
        c.topSpeedScale = d > 35 ? 1.22 : 1.08;
      } else if (!lk.lkpChecked && (u.role === 'lkp' || distToLkp < 75) && onLkpCorridor) {
        // On the same road corridor as the unchecked LKP: drive straight through (lk.x, lk.z)
        // along the player's escape vector at full pursuit speed!
        tx = lk.x + lk.dirX * 6;
        tz = lk.z + lk.dirZ * 6;
        vTarget = 62;
        c.topSpeedScale = 1.24;
      } else {
        // A* navigation to the Director's assigned intersection (LKP approach, Sector, or Interceptor cutoff)
        const goalInter = u.targetInter >= 0 ? u.targetInter : g.nearestIntersection(u.targetX, u.targetZ).id;
        const curWp = u.path.length > 0 ? g.intersections[u.path[0]] : undefined;
        const offCourse = curWp ? Math.hypot(curWp.x - c.x, curWp.z - c.z) > CITY.SPACING * 1.35 : true;
        if (u.path.length === 0 || u.pathGoal !== goalInter || offCourse || u.reverseFor > 0.5) {
          u.pathGoal = goalInter;
          u.path = this.planPath(c, goalInter);
          // If the first node of the new path is an intersection we are already inside/exiting, skip it
          if (u.path.length > 1) {
            const firstI = g.intersections[u.path[0]];
            const nextI = g.intersections[u.path[1]];
            const dFirst = Math.hypot(firstI.x - c.x, firstI.z - c.z);
            const toNextDot = (nextI.x - firstI.x) * (c.x - firstI.x) + (nextI.z - firstI.z) * (c.z - firstI.z);
            if (dFirst < CITY.ROAD * 0.95 || (dFirst < CITY.ROAD * 1.6 && toNextDot > 0)) {
              u.path.shift();
            }
          }
          // For LKP verification on a mid-block segment, traverse from behindInterId through (lk.x, lk.z) to aheadInterId
          if (u.role === 'lkp' && lk.behindInterId !== lk.aheadInterId) {
            const last = u.path[u.path.length - 1];
            if (last === lk.behindInterId && !u.path.includes(lk.aheadInterId)) {
              u.path.push(lk.aheadInterId);
            } else if (last === lk.aheadInterId && !u.path.includes(lk.behindInterId)) {
              u.path.push(lk.behindInterId);
            }
          }
        }
        // Advance waypoints. On a turn, hold the current node until inside the intersection box so we don't cut building corners.
        while (u.path.length > 1) {
          const nI = g.intersections[u.path[0]];
          const nN = g.intersections[u.path[1]];
          const dn = Math.hypot(nI.x - c.x, nI.z - c.z);
          const inX = (nI.x - c.x) / Math.max(1, dn);
          const inZ = (nI.z - c.z) / Math.max(1, dn);
          const ol = Math.max(1, Math.hypot(nN.x - nI.x, nN.z - nI.z));
          const straight = inX * ((nN.x - nI.x) / ol) + inZ * ((nN.z - nI.z) / ol) > 0.8;
          const reach = straight ? CITY.ROAD * 1.25 : clamp(Math.abs(c.speed) * 0.38, 8.5, 12.5);
          if (dn < reach) u.path.shift();
          else break;
        }
        const wp = g.intersections[u.path[0]];
        // Keep full pursuit speed while in active pursuit or rushing to verify LKP; brisk sweep speed in cooldown
        vTarget = heat.mode === 'pursuit' || !lk.lkpChecked || u.role === 'lkp' || distToLkp > 65 ? 60 : 48;
        c.topSpeedScale = distToLkp > 70 || !lk.lkpChecked ? 1.24 : 1.15;
        if (wp) {
          const dxW = wp.x - c.x;
          const dzW = wp.z - c.z;
          const dw = Math.hypot(dxW, dzW);
          // Pure-pursuit lookahead (~18 m ahead along the street with right-hand lane offset) so units pull onto
          // the road after a turn and don't collide head-on with oncoming cruisers.
          const laneOff = dw > 14 ? 2.2 : 0;
          if (Math.abs(dxW) < Math.abs(dzW)) {
            tx = wp.x - Math.sign(dzW) * laneOff;
            tz = c.z + Math.sign(dzW) * Math.min(Math.abs(dzW), 18);
          } else {
            tx = c.x + Math.sign(dxW) * Math.min(Math.abs(dxW), 18);
            tz = wp.z + Math.sign(dxW) * laneOff;
          }
          if (u.path.length === 1 && dw < CITY.ROAD * 0.9) {
            if (u.role === 'lkp') {
              // Reached the end of the LKP segment (e.g. if LKP was slightly off-road in a block): mark LKP checked
              lk.lkpChecked = true;
            }
            this.director.visitedAt.set(wp.id, time);
          }
          // Brake-before-corner: limit speed so the unit can make the upcoming turn (or transition cleanly at the goal node)
          let vCorner = 20;
          if (u.path.length > 1) {
            const nN = g.intersections[u.path[1]];
            const ol = Math.max(1, Math.hypot(nN.x - wp.x, nN.z - wp.z));
            const cosT = ((wp.x - c.x) * (nN.x - wp.x) + (wp.z - c.z) * (nN.z - wp.z)) / (Math.max(1, dw) * ol);
            vCorner = cosT > 0.8 ? Infinity : cosT > -0.4 ? 18 : 10;
          }
          if (vCorner < Infinity) vTarget = Math.min(vTarget, Math.sqrt(vCorner * vCorner + 2 * CORNER_DECEL * Math.max(0, dw - 7)));
        } else {
          tx = u.targetX;
          tz = u.targetZ;
        }
      }

      const desiredYaw = Math.atan2(tx - c.x, tz - c.z);
      const diff = wrapAngle(desiredYaw - c.yaw);
      let steer = clamp(-diff * 2.4, -1, 1);
      // Whisker ray obstacle avoidance (buildings). Positive steer turns towards yaw-; prefer the planned turn side.
      const reachC = clamp(6 + Math.abs(c.speed) * 0.45, 8, 20);
      const hitC = this.phys.castForward(c.x, 0.7, c.z, c.fwdX, c.fwdZ, reachC, c.body, G.STATIC);
      if (hitC) {
        const lYaw = c.yaw + 0.5;
        const rYaw = c.yaw - 0.5;
        const hitL = this.phys.castForward(c.x, 0.7, c.z, Math.sin(lYaw), Math.cos(lYaw), reachC, c.body, G.STATIC);
        const hitR = this.phys.castForward(c.x, 0.7, c.z, Math.sin(rYaw), Math.cos(rYaw), reachC, c.body, G.STATIC);
        if (hitL && !hitR) steer = 1;
        else if (hitR && !hitL) steer = -1;
        else steer = diff > 0 ? -1 : 1;
        vTarget = Math.min(vTarget, hitL && hitR ? 8 : 15);
      } else if (u.state !== 'ram') {
        // Overtake / weave around civilian traffic or other cruisers ahead
        const hitV = this.phys.castForward(c.x, 0.7, c.z, c.fwdX, c.fwdZ, 11, c.body, G.TRAFFIC | G.COP);
        if (hitV) {
          const lYaw = c.yaw + 0.36;
          const rYaw = c.yaw - 0.36;
          const hitVL = this.phys.castForward(c.x, 0.7, c.z, Math.sin(lYaw), Math.cos(lYaw), 11, c.body, G.STATIC | G.TRAFFIC | G.COP);
          const hitVR = this.phys.castForward(c.x, 0.7, c.z, Math.sin(rYaw), Math.cos(rYaw), 11, c.body, G.STATIC | G.TRAFFIC | G.COP);
          if (!hitVL && hitVR) steer = -0.75;
          else if (!hitVR && hitVL) steer = 0.75;
          else steer = steer >= 0 ? 0.75 : -0.75;
        }
      }
      if (Math.abs(diff) > 0.6) vTarget = Math.min(vTarget, 19);
      if (holding) vTarget = 0;

      // Timed reverse-out when wedged against a wall/car (can't oscillate like a decaying counter)
      if (u.reverseFor > 0) {
        u.reverseFor -= dt;
        c.input = { throttle: 0, brake: 1, steer: u.reverseSteer, handbrake: false, nitro: false };
      } else {
        if (vTarget > 5 && Math.abs(c.speed) < 1.5) u.stuckFor += dt;
        else u.stuckFor = Math.max(0, u.stuckFor - dt * 2);
        if (Math.abs(c.speed) > 8) u.stuckCount = Math.max(0, u.stuckCount - dt * 0.25);
        if (u.stuckFor > 0.9) {
          u.stuckFor = 0;
          u.stuckCount++;
          u.reverseFor = 1.1;
          // Reversing with opposite lock swings the nose towards the target
          u.reverseSteer = -(Math.abs(steer) > 0.15 ? Math.sign(steer) : u.stuckCount % 2 ? 1 : -1);
        }
        const err = vTarget - c.speed;
        c.input = {
          throttle: err > 0 ? clamp(err / 8, 0.2, 1) : 0,
          brake: err < -3 || (holding && c.speed > 0.5) ? clamp(-err / 14, 0.2, 1) : 0,
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
    this.animateHeli(dt, time);
  }

  /**
   * Route from the car's current road. Plans from the intersection ahead, and only uses the one
   * behind (a U-turn) when that is clearly shorter. Prevents the old mid-block flip-flop where the
   * "nearest" node switched from behind to ahead and the cop kept turning around.
   */
  private planPath(c: ArcadeVehicle, goal: number): number[] {
    const g = this.layout.graph;
    const { ahead, behind } = g.aheadIntersection(c.x, c.z, c.fwdX, c.fwdZ);
    const pA = findPath(g, ahead, goal);
    if (ahead === behind) return pA ?? [goal];
    const pB = findPath(g, behind, goal);
    const A = g.intersections[ahead];
    const B = g.intersections[behind];
    const costA = pA ? Math.hypot(A.x - c.x, A.z - c.z) + pathLength(g, pA) : Infinity;
    const costB = pB ? Math.hypot(B.x - c.x, B.z - c.z) + pathLength(g, pB) + 30 + Math.abs(c.speed) * 2 : Infinity;
    return (costA <= costB ? pA : pB) ?? [goal];
  }
}
