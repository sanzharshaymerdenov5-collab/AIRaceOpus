import * as THREE from 'three';
import type { CityLayout } from '../city/CityLayout';
import type { EventBus } from '../core/events';
import type { HeatSystem } from './HeatSystem';
import { basic, lightPoolMat } from '../render/materials';

export type JobType = 'getaway' | 'sprint' | 'smash';

export interface ActiveJob {
  type: JobType;
  name: string;
  timeLeft: number;
  reward: number;
  // sprint / getaway target
  checkpoints: { x: number; z: number }[];
  cpIndex: number;
  // smash spree
  smashGoal: number;
  smashed: number;
}

const COLORS: Record<JobType, number> = { getaway: 0xff2a6d, sprint: 0x05d9e8, smash: 0xffc800 };
const NAMES: Record<JobType, string> = { getaway: 'HOT GETAWAY', sprint: 'CHECKPOINT SPRINT', smash: 'SMASH SPREE' };

export class JobSystem {
  readonly group = new THREE.Group();
  active: ActiveJob | null = null;
  nearSpot: { idx: number; type: JobType; x: number; z: number } | null = null;
  private cpRing: THREE.Group;
  private beacons: THREE.Mesh[] = [];

  constructor(
    private layout: CityLayout,
    private heat: HeatSystem,
    private bus: EventBus,
    addBeacon: (x: number, z: number, color: number) => THREE.Mesh,
  ) {
    for (const s of layout.jobSpots) this.beacons.push(addBeacon(s.x, s.z, COLORS[s.type]));

    this.cpRing = new THREE.Group();
    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(4.5, 0.35, 8, 24),
      basic({ color: 0x05d9e8, toneMapped: false }),
    );
    torus.position.y = 4.5;
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(4.5, 4.5, 45, 16, 1, true).translate(0, 22.5, 0),
      basic({ color: 0x05d9e8, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), lightPoolMat(0x05d9e8, 0.9));
    pool.position.y = 0.08;
    this.cpRing.add(torus, col, pool);
    this.cpRing.visible = false;
    this.group.add(this.cpRing);

    this.bus.on('propSmashed', () => {
      if (this.active?.type === 'smash') {
        this.active.smashed++;
        if (this.active.smashed >= this.active.smashGoal) this.finish(true);
      }
    });
    this.bus.on('busted', () => this.active && this.finish(false));
    this.bus.on('wrecked', () => this.active && this.finish(false));
  }

  /** Current objective world position for minimap / HUD arrow, if any. */
  get target(): { x: number; z: number } | null {
    if (!this.active || !this.active.checkpoints.length) return null;
    return this.active.checkpoints[this.active.cpIndex] ?? null;
  }

  start(spotIdx: number) {
    const spot = this.layout.jobSpots[spotIdx];
    const type = spot.type;
    const I = this.layout.intersections.filter((n) => n.degree >= 3 && Math.hypot(n.x - spot.x, n.z - spot.z) > 260);
    const pick = () => I[Math.floor(Math.random() * I.length)];

    if (type === 'getaway') {
      const dst = pick();
      this.active = { type, name: NAMES[type], timeLeft: 95, reward: 1800, checkpoints: [{ x: dst.x, z: dst.z }], cpIndex: 0, smashGoal: 0, smashed: 0 };
      this.heat.forceStars(2);
    } else if (type === 'sprint') {
      const cps: { x: number; z: number }[] = [];
      let last = { x: spot.x, z: spot.z };
      for (let k = 0; k < 5; k++) {
        const cand = this.layout.intersections.filter((n) => {
          const d = Math.hypot(n.x - last.x, n.z - last.z);
          return d > 150 && d < 320;
        });
        const c = cand[Math.floor(Math.random() * cand.length)] ?? pick();
        cps.push({ x: c.x, z: c.z });
        last = c;
      }
      this.active = { type, name: NAMES[type], timeLeft: 75, reward: 1500, checkpoints: cps, cpIndex: 0, smashGoal: 0, smashed: 0 };
    } else {
      this.active = { type, name: NAMES[type], timeLeft: 50, reward: 1200, checkpoints: [], cpIndex: 0, smashGoal: 22, smashed: 0 };
    }
    for (const b of this.beacons) b.visible = false;
    this.syncRing();
    this.bus.emit('jobStarted', { name: this.active.name });
  }

  private syncRing() {
    const t = this.target;
    this.cpRing.visible = !!t;
    if (t) this.cpRing.position.set(t.x, 0, t.z);
  }

  finish(success: boolean) {
    if (!this.active) return;
    const j = this.active;
    this.active = null;
    this.cpRing.visible = false;
    for (const b of this.beacons) b.visible = true;
    this.bus.emit('jobEnded', { name: j.name, success, reward: success ? j.reward : 0 });
  }

  update(dt: number, time: number, px: number, pz: number, startPressed: boolean) {
    let found: { idx: number; type: JobType; x: number; z: number } | null = null;
    if (!this.active) {
      this.layout.jobSpots.forEach((s, idx) => {
        if (Math.hypot(s.x - px, s.z - pz) < 9) found = { idx, type: s.type, x: s.x, z: s.z };
      });
      this.nearSpot = found;
      if (found && startPressed) this.start((found as { idx: number }).idx);
      return;
    }
    this.nearSpot = null;

    this.cpRing.children[0].rotation.y = time * 2.2;
    this.active.timeLeft -= dt;
    if (this.active.timeLeft <= 0) {
      this.finish(false);
      return;
    }
    const t = this.target;
    if (t && Math.hypot(px - t.x, pz - t.z) < 11) {
      this.active.cpIndex++;
      if (this.active.cpIndex >= this.active.checkpoints.length) this.finish(true);
      else {
        this.active.timeLeft += 8;
        this.syncRing();
        this.bus.emit('message', { text: `CHECKPOINT ${this.active.cpIndex}/${this.active.checkpoints.length}`, sub: '+8s', color: '#05d9e8', time: 1.4 });
      }
    }
  }
}
