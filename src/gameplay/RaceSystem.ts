import * as THREE from 'three';
import type { CityLayout, OfficialRaceDef } from '../city/CityLayout';
import { findPath } from '../ai/Pathfinder';
import { ArcadeVehicle } from '../physics/ArcadeVehicle';
import { G, type PhysicsWorld } from '../physics/PhysicsWorld';
import { animateCarRig, buildCarMesh, setCarColor, type CarRig } from '../vehicles/CarMeshFactory';
import { PLAYER_CARS } from '../vehicles/carSpecs';
import type { EventBus } from '../core/events';
import { basic, lambert, lightPoolMat } from '../render/materials';
import { clamp, wrapAngle } from '../core/rng';

export interface AiRacer {
  id: number;
  name: string;
  color: number;
  colorHex: string;
  car: ArcadeVehicle;
  rig: CarRig;
  lap: number;
  cpIndex: number;
  finished: boolean;
  finishTime: number;
  path: number[];
  pathGoal: number;
  repathTimer: number;
  stuckFor: number;
  reverseFor: number;
  skillOffset: number;
}

export interface ActiveRace {
  def: OfficialRaceDef;
  countdown: number;
  lastBeepSec: number;
  elapsed: number;
  lap: number;
  cpIndex: number;
  opponents: AiRacer[];
  playerPosition: number;
}

const RACER_PROFILES = [
  { name: 'LUNA // VIPER', carId: 'viper', color: 0xff2a6d, colorHex: '#ff2a6d', skillOffset: 1.03 },
  { name: 'KAI // RAPTOR', carId: 'raptor', color: 0x00ffa2, colorHex: '#00ffa2', skillOffset: 0.99 },
  { name: 'DEX // NOVA', carId: 'nova', color: 0xffae00, colorHex: '#ffae00', skillOffset: 0.95 },
];

/**
 * Need For Speed Heat-style "Speedhunter Showdown" Official Race System:
 * - Festival start arches across the 1.5x1.5 km city.
 * - 3 AI opponents on a 2x2 starting grid with 3-2-1-GO! countdown.
 * - Multi-lap circuits & point-to-point sprints routing through curved roads and boulevards.
 * - Live standings (1st..4th) and official Speedhunter Bank ($) podium payouts.
 */
export class RaceSystem {
  readonly group = new THREE.Group();
  active: ActiveRace | null = null;
  nearRace: { idx: number; def: OfficialRaceDef } | null = null;
  private arches: THREE.Group[] = [];
  private cpGate: THREE.Group;
  private nextGate: THREE.Group;

  constructor(
    private layout: CityLayout,
    private phys: PhysicsWorld,
    private bus: EventBus,
    private onBeep?: (freq: number, dur: number) => void,
  ) {
    for (const r of layout.raceSpots) {
      const arch = this.buildFestivalArch(r.startX, r.startZ, r.startYaw, 0xff2a6d, 0x05d9e8);
      this.arches.push(arch);
      this.group.add(arch);
    }

    this.cpGate = this.buildCheckpointGate(0xff2a6d, 1.0);
    this.cpGate.visible = false;
    this.group.add(this.cpGate);

    this.nextGate = this.buildCheckpointGate(0x05d9e8, 0.45);
    this.nextGate.visible = false;
    this.group.add(this.nextGate);

    this.bus.on('busted', () => this.active && this.finish(false));
    this.bus.on('wrecked', () => this.active && this.finish(false));
  }

  private buildFestivalArch(x: number, z: number, yaw: number, primary: number, secondary: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;

    const span = 6.2;
    const h = 8.4;
    const darkMat = lambert({ color: 0x1c202a });
    const pinkMat = basic({ color: primary, toneMapped: false });
    const cyanMat = basic({ color: secondary, toneMapped: false });
    const goldMat = basic({ color: 0xffc800, toneMapped: false });

    for (const side of [-1, 1]) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(0.9, h, 0.9).translate(0, h / 2, 0), darkMat);
      tower.position.x = side * span;
      const neonStrip = new THREE.Mesh(new THREE.BoxGeometry(0.25, h - 0.6, 1.02).translate(0, h / 2, 0), pinkMat);
      neonStrip.position.x = side * span;
      const flag = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.4, 0.8).translate(0, h + 1.2, 0), side < 0 ? pinkMat : cyanMat);
      flag.position.x = side * span;
      g.add(tower, neonStrip, flag);
    }

    // Overhead festival truss banner
    const banner = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 1.4, 1.5, 1.1), darkMat);
    banner.position.y = h + 0.2;
    const topNeon = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 1.5, 0.32, 1.2), pinkMat);
    topNeon.position.y = h + 0.85;
    const botNeon = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 1.5, 0.28, 1.2), cyanMat);
    botNeon.position.y = h - 0.45;
    const midStripe = new THREE.Mesh(new THREE.BoxGeometry(span * 1.3, 0.45, 1.22), goldMat);
    midStripe.position.y = h + 0.2;
    g.add(banner, topNeon, botNeon, midStripe);

    // Tall translucent sky beacon + ground light ring
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(3.4, 3.4, 65, 16, 1, true).translate(0, 32.5, 0),
      basic({ color: primary, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.2, 5.4, 28).rotateX(-Math.PI / 2), lightPoolMat(primary, 0.95));
    ring.position.y = 0.09;
    ring.name = 'archRing';
    g.add(beam, ring);

    return g;
  }

  private buildCheckpointGate(color: number, opacityScale: number): THREE.Group {
    const g = new THREE.Group();
    const span = 6.5;
    const h = 9.0;
    const pillarGeo = new THREE.CylinderGeometry(0.45, 0.65, h, 10).translate(0, h / 2, 0);
    const pillarMat = basic({ color, transparent: opacityScale < 1, opacity: 0.9 * opacityScale, toneMapped: false });

    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.x = side * span;
      const flare = new THREE.Mesh(
        new THREE.CylinderGeometry(1.8, 1.8, 38, 12, 1, true).translate(0, 19, 0),
        basic({
          color,
          transparent: true,
          opacity: 0.24 * opacityScale,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      flare.position.x = side * span;
      g.add(p, flare);
    }

    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(span, 0.35, 8, 24, Math.PI),
      basic({ color: 0xffc800, transparent: opacityScale < 1, opacity: 0.9 * opacityScale, toneMapped: false }),
    );
    arch.position.y = h * 0.65;
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(16, 16).rotateX(-Math.PI / 2), lightPoolMat(color, 0.85 * opacityScale));
    pool.position.y = 0.08;
    g.add(arch, pool);
    return g;
  }

  /** Active checkpoint world coordinates for HUD / Minimap. */
  get target(): { x: number; z: number } | null {
    if (!this.active) return null;
    return this.active.def.checkpoints[this.active.cpIndex] ?? null;
  }

  /** Start an official race at `spotIdx`, lining up the player and 3 AI racers on the starting grid. */
  start(spotIdx: number, player: ArcadeVehicle, clearTrafficNear?: (x: number, z: number, r: number) => void) {
    const def = this.layout.raceSpots[spotIdx];
    if (!def) return;
    if (this.active) this.finish(false);

    clearTrafficNear?.(def.startX, def.startZ, 55);

    const fx = Math.sin(def.startYaw);
    const fz = Math.cos(def.startYaw);
    const rx = -fz;
    const rz = fx;

    // Place player on Row 2 Left so the 3 AI cars are visible right beside and ahead on the starting grid
    const playerStartX = def.startX - rx * 2.2 - fx * 3.5;
    const playerStartZ = def.startZ - rz * 2.2 - fz * 3.5;
    player.teleport(playerStartX, playerStartZ, def.startYaw);
    player.setForwardSpeed(0);
    player.nitro = 1;
    player.spikedTime = 0;

    // Grid offsets for the 3 AI racers: Row 1 Left, Row 1 Right, Row 2 Right
    const gridOffsets: [number, number][] = [
      [-2.2, 4.2],
      [2.2, 4.2],
      [2.2, -3.5],
    ];

    const opponents: AiRacer[] = RACER_PROFILES.map((prof, idx) => {
      const carDef = PLAYER_CARS.find((c) => c.spec.id === prof.carId) ?? PLAYER_CARS[1];
      const [latOff, fwdOff] = gridOffsets[idx];
      const ox = def.startX + rx * latOff + fx * fwdOff;
      const oz = def.startZ + rz * latOff + fz * fwdOff;
      const car = new ArcadeVehicle(this.phys, carDef.spec, ox, oz, def.startYaw, G.TRAFFIC, { kind: 'traffic' });
      const rig = buildCarMesh(carDef.spec, prof.color, false);
      setCarColor(rig, prof.color);
      rig.root.position.set(ox, 0, oz);
      rig.root.rotation.y = def.startYaw;
      this.group.add(rig.root);

      return {
        id: idx + 1,
        name: prof.name,
        color: prof.color,
        colorHex: prof.colorHex,
        car,
        rig,
        lap: 1,
        cpIndex: 0,
        finished: false,
        finishTime: 0,
        path: [],
        pathGoal: -1,
        repathTimer: 0,
        stuckFor: 0,
        reverseFor: 0,
        skillOffset: prof.skillOffset,
      };
    });

    this.active = {
      def,
      countdown: 3.0,
      lastBeepSec: 4,
      elapsed: 0,
      lap: 1,
      cpIndex: 0,
      opponents,
      playerPosition: 4,
    };

    for (const a of this.arches) a.visible = false;
    this.syncGates(player.x, player.z);
    this.bus.emit('raceStarted', { name: def.name, kind: def.kind, laps: def.laps });
    this.bus.emit('message', { text: def.name, sub: 'GET READY · 3... 2... 1...', color: '#ff2a6d', time: 1.5 });
  }

  private syncGates(fromX: number, fromZ: number) {
    if (!this.active) {
      this.cpGate.visible = false;
      this.nextGate.visible = false;
      return;
    }
    const cps = this.active.def.checkpoints;
    const cur = cps[this.active.cpIndex];
    if (!cur) {
      this.cpGate.visible = false;
      this.nextGate.visible = false;
      return;
    }
    this.cpGate.visible = true;
    this.cpGate.position.set(cur.x, 0, cur.z);

    // Orient current gate perpendicular to incoming direction
    const nextIdx = (this.active.cpIndex + 1) % cps.length;
    const hasNext = this.active.cpIndex + 1 < cps.length || this.active.lap < this.active.def.laps;
    const nextCp = hasNext ? cps[nextIdx] : null;
    const dirX = nextCp ? nextCp.x - cur.x : cur.x - fromX;
    const dirZ = nextCp ? nextCp.z - cur.z : cur.z - fromZ;
    if (Math.hypot(dirX, dirZ) > 0.1) {
      this.cpGate.rotation.y = Math.atan2(dirX, dirZ);
    }

    if (nextCp) {
      this.nextGate.visible = true;
      this.nextGate.position.set(nextCp.x, 0, nextCp.z);
      this.nextGate.rotation.y = Math.atan2(nextCp.x - cur.x, nextCp.z - cur.z);
    } else {
      this.nextGate.visible = false;
    }
  }

  finish(completed: boolean) {
    if (!this.active) return;
    const r = this.active;
    const pos = r.playerPosition;
    const reward = completed ? (r.def.prizes[pos - 1] ?? 500) : 0;
    const elapsed = r.elapsed;

    for (const opp of r.opponents) {
      this.group.remove(opp.rig.root);
      opp.car.dispose();
    }
    this.active = null;
    this.cpGate.visible = false;
    this.nextGate.visible = false;
    for (const a of this.arches) a.visible = true;

    if (completed) {
      this.bus.emit('raceEnded', { name: r.def.name, position: pos, reward, time: elapsed });
    }
  }

  private progressScore(lap: number, cpIndex: number, x: number, z: number, finished: boolean, finishTime: number): number {
    if (finished) return 1e9 - finishTime * 100;
    const cp = this.active!.def.checkpoints[cpIndex] ?? this.active!.def.checkpoints[0];
    const dist = Math.hypot(x - cp.x, z - cp.z);
    return lap * 100000 + cpIndex * 2000 - dist;
  }

  private updateAiRacer(dt: number, time: number, opp: AiRacer, playerScore: number) {
    const race = this.active!;
    const c = opp.car;

    if (race.countdown > 0) {
      c.setForwardSpeed(0);
      c.input = { throttle: 0.4, brake: 1, steer: 0, handbrake: false, nitro: false };
      c.update(dt);
      opp.rig.root.position.set(c.x, 0, c.z);
      opp.rig.root.rotation.y = c.yaw;
      animateCarRig(opp.rig, dt, 0, 0, true, false, false, 0, time);
      return;
    }

    if (opp.finished) {
      c.input = { throttle: 0, brake: 0.7, steer: 0, handbrake: false, nitro: false };
      c.update(dt);
      opp.rig.root.position.set(c.x, 0, c.z);
      opp.rig.root.rotation.y = c.yaw;
      animateCarRig(opp.rig, dt, c.speed, 0, true, false, false, 0, time);
      return;
    }

    const cps = race.def.checkpoints;
    let cp = cps[opp.cpIndex];
    const distToCp = Math.hypot(c.x - cp.x, c.z - cp.z);
    if (distToCp < 16) {
      opp.cpIndex++;
      opp.path = [];
      if (opp.cpIndex >= cps.length) {
        if (opp.lap < race.def.laps) {
          opp.lap++;
          opp.cpIndex = 0;
        } else {
          opp.finished = true;
          opp.finishTime = race.elapsed;
          return;
        }
      }
      cp = cps[opp.cpIndex];
    }

    const g = this.layout.graph;
    opp.repathTimer -= dt;
    const goalInter = g.nearestIntersection(cp.x, cp.z).id;
    if (opp.repathTimer <= 0 || opp.pathGoal !== goalInter || opp.path.length === 0) {
      opp.repathTimer = 0.35;
      opp.pathGoal = goalInter;
      const { ahead } = g.aheadIntersection(c.x, c.z, c.fwdX, c.fwdZ);
      opp.path = findPath(g, ahead, goalInter) ?? [goalInter];
    }

    while (opp.path.length > 1) {
      const n = g.intersections[opp.path[0]];
      if (Math.hypot(n.x - c.x, n.z - c.z) < 15) opp.path.shift();
      else break;
    }

    let tx = cp.x;
    let tz = cp.z;
    if (opp.path.length >= 1 && Math.hypot(cp.x - c.x, cp.z - c.z) > 48) {
      const wp = g.intersections[opp.path[0]];
      const dx = wp.x - c.x;
      const dz = wp.z - c.z;
      const d = Math.hypot(dx, dz) || 1;
      const rx = -dz / d;
      const rz = dx / d;
      tx = wp.x + rx * 2.2;
      tz = wp.z + rz * 2.2;
    }

    // Unstuck handling
    if (Math.abs(c.speed) < 1.8) {
      opp.stuckFor += dt;
      if (opp.stuckFor > 1.5 && opp.reverseFor <= 0) {
        opp.reverseFor = 0.85;
      }
      if (opp.stuckFor > 3.6) {
        const near = g.nearestLane(c.x, c.z, tx - c.x, tz - c.z).lane;
        c.teleport(near.sx + near.dx * (near.len * 0.5), near.sz + near.dz * (near.len * 0.5), Math.atan2(tx - c.x, tz - c.z));
        c.setForwardSpeed(18);
        opp.stuckFor = 0;
        opp.reverseFor = 0;
      }
    } else {
      opp.stuckFor = 0;
    }

    if (opp.reverseFor > 0) {
      opp.reverseFor -= dt;
      c.input = { throttle: 0, brake: 1, steer: 0.6, handbrake: false, nitro: false };
    } else {
      const desiredYaw = Math.atan2(tx - c.x, tz - c.z);
      let diff = wrapAngle(desiredYaw - c.yaw);

      // Forward obstacle avoidance
      const hit = this.phys.castForward(c.x, 0.6, c.z, c.fwdX, c.fwdZ, 16, c.body);
      if (hit && hit.dist < 13) {
        diff += opp.id % 2 === 0 ? 0.35 : -0.35;
      }

      const steer = clamp(-diff * 2.3, -1, 1);

      // Rubber-banding relative to player so races stay competitive
      const myScore = this.progressScore(opp.lap, opp.cpIndex, c.x, c.z, opp.finished, opp.finishTime);
      const scoreDiff = playerScore - myScore; // >0 means player is ahead of this AI
      const rubber = clamp(1 + scoreDiff / 1800, 0.84, 1.14) * opp.skillOffset;

      let vTarget = c.spec.topSpeed * 0.92 * rubber;
      if (Math.abs(diff) > 0.45) vTarget = Math.min(vTarget, 20);
      else if (Math.abs(diff) > 0.22) vTarget = Math.min(vTarget, 29);

      const err = vTarget - c.speed;
      const useNitro = Math.abs(diff) < 0.14 && scoreDiff > 120 && c.speed > 22;
      c.input = {
        throttle: err > 0 ? clamp(err / 7, 0.25, 1) : 0.1,
        brake: err < -3.5 ? clamp(-err / 14, 0.2, 0.95) : 0,
        steer,
        handbrake: Math.abs(diff) > 0.85 && c.speed > 22,
        nitro: useNitro,
      };
    }

    c.update(dt);
    opp.rig.root.position.set(c.x, 0, c.z);
    opp.rig.root.rotation.y = c.yaw;
    animateCarRig(
      opp.rig,
      dt,
      c.speed,
      c.input.steer,
      c.input.brake > 0.1,
      c.nitroActive,
      false,
      0,
      time,
    );
  }

  update(
    dt: number,
    time: number,
    player: ArcadeVehicle,
    startPressed: boolean,
    canStartNew: boolean,
    clearTrafficNear?: (x: number, z: number, r: number) => void,
  ) {
    // Rotate festival arch ground rings
    for (const a of this.arches) {
      const ring = a.getObjectByName('archRing');
      if (ring) ring.rotation.z = time * 1.2;
    }

    if (!this.active) {
      let found: { idx: number; def: OfficialRaceDef } | null = null;
      if (canStartNew) {
        this.layout.raceSpots.forEach((def, idx) => {
          if (Math.hypot(def.startX - player.x, def.startZ - player.z) < 12) {
            found = { idx, def };
          }
        });
      }
      this.nearRace = found;
      if (found && startPressed) {
        this.start((found as { idx: number; def: OfficialRaceDef }).idx, player, clearTrafficNear);
      }
      return;
    }

    this.nearRace = null;
    const race = this.active;

    // 3-2-1-GO! Countdown phase
    if (race.countdown > 0) {
      race.countdown -= dt;
      const sec = Math.ceil(race.countdown);
      if (sec < race.lastBeepSec && sec >= 1) {
        race.lastBeepSec = sec;
        this.onBeep?.(440, 0.12);
        this.bus.emit('message', { text: `${sec}`, sub: 'REV YOUR ENGINE!', color: '#ffc800', time: 0.85 });
      }
      if (race.countdown <= 0) {
        this.onBeep?.(880, 0.25);
        this.bus.emit('message', { text: 'GO! GO! GO!', sub: race.def.name, color: '#39ff7a', time: 1.4 });
      } else {
        player.setForwardSpeed(0);
      }
    } else {
      race.elapsed += dt;
    }

    const playerScore = this.progressScore(race.lap, race.cpIndex, player.x, player.z, false, 0);
    for (const opp of race.opponents) {
      this.updateAiRacer(dt, time, opp, playerScore);
    }

    // Update live standings (1..4)
    let aheadCount = 0;
    for (const opp of race.opponents) {
      const oppScore = this.progressScore(opp.lap, opp.cpIndex, opp.car.x, opp.car.z, opp.finished, opp.finishTime);
      if (oppScore > playerScore) aheadCount++;
    }
    race.playerPosition = 1 + aheadCount;

    // Check player checkpoint capture
    const t = this.target;
    if (t && race.countdown <= 0 && Math.hypot(player.x - t.x, player.z - t.z) < 16.5) {
      const prevX = t.x;
      const prevZ = t.z;
      race.cpIndex++;
      if (race.cpIndex >= race.def.checkpoints.length) {
        if (race.lap < race.def.laps) {
          race.lap++;
          race.cpIndex = 0;
          this.syncGates(prevX, prevZ);
          this.onBeep?.(740, 0.14);
          this.bus.emit('message', {
            text: `LAP ${race.lap} / ${race.def.laps}`,
            sub: `POSITION ${race.playerPosition}/4`,
            color: '#ff2a6d',
            time: 1.6,
          });
        } else {
          this.finish(true);
          return;
        }
      } else {
        this.syncGates(prevX, prevZ);
        this.onBeep?.(660, 0.1);
      }
    }
  }
}
