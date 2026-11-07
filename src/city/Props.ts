import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PropSpec, PropType } from './CityLayout';
import { G, groups, type PhysicsWorld } from '../physics/PhysicsWorld';
import { glowMat, lambert, lightPoolMat } from '../render/materials';
import type { EventBus } from '../core/events';

interface LiveProp {
  spec: PropSpec;
  idx: number;
  body?: RAPIER.RigidBody;
  collider?: RAPIER.Collider;
  smashed: boolean;
  despawnAt: number;
  poolIdx: number; // lamp light pool
}

/** Merge a list of translated/scaled boxes of a single colour into one BufferGeometry. */
function makePart(boxes: [number, number, number, number, number, number][]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const [cx, cy, cz, w, h, d] of boxes) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    const b = pos.length / 3;
    const p = g.attributes.position.array as Float32Array;
    const n = g.attributes.normal.array as Float32Array;
    const ix = g.index!.array;
    for (let k = 0; k < p.length; k++) pos.push(p[k]), nor.push(n[k]);
    for (let k = 0; k < ix.length; k++) idx.push(ix[k] + b);
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

const PROP_BOX: Record<PropType, [number, number, number, number]> = {
  // hx, hy, hz, mass
  lamp: [0.2, 3.3, 0.2, 55],
  hydrant: [0.3, 0.45, 0.3, 35],
  bench: [0.9, 0.45, 0.35, 30],
  bin: [0.35, 0.55, 0.35, 22],
  newsstand: [0.6, 0.85, 0.45, 45],
  cone: [0.25, 0.4, 0.25, 8],
  tree: [0.35, 2.2, 0.35, 90],
  camera: [0.25, 2.2, 0.25, 60],
};

/**
 * All street furniture rendered via per-type InstancedMeshes.
 * Only props within ~90 m of the player get a sleeping Rapier body; when hit,
 * they ragdoll, emit `propSmashed`, and respawn once the player is far away.
 */
export class PropManager {
  readonly group = new THREE.Group();
  private items: LiveProp[] = [];
  private meshes = new Map<PropType, THREE.InstancedMesh[]>();
  private lampPools!: THREE.InstancedMesh;
  private lampHeads!: THREE.InstancedMesh;
  private tmpM = new THREE.Matrix4();
  private tmpP = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
  readonly cameras: { x: number; z: number }[] = [];

  constructor(
    specs: PropSpec[],
    private phys: PhysicsWorld,
    private bus: EventBus,
  ) {
    const byType = new Map<PropType, PropSpec[]>();
    for (const s of specs) {
      let arr = byType.get(s.type);
      if (!arr) byType.set(s.type, (arr = []));
      arr.push(s);
      if (s.type === 'camera') this.cameras.push({ x: s.x, z: s.z });
    }
    this.buildMeshes(byType);

    let lampIdx = 0;
    for (const [type, list] of byType) {
      list.forEach((spec, idx) => {
        const poolIdx = type === 'lamp' ? lampIdx++ : -1;
        this.items.push({ spec, idx, smashed: false, despawnAt: 0, poolIdx });
        this.writeRestMatrix(spec, idx, poolIdx);
      });
    }
  }

  private buildMeshes(byType: Map<PropType, PropSpec[]>) {
    const add = (t: PropType, geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const n = byType.get(t)?.length ?? 0;
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      im.count = n;
      im.frustumCulled = false;
      this.group.add(im);
      let a = this.meshes.get(t);
      if (!a) this.meshes.set(t, (a = []));
      a.push(im);
    };
    const metal = lambert({ color: 0x3a3f48 });
    // lamp: pole + overhang arm; emissive bulb + ground light pool
    add('lamp', makePart([[0, 3.2, 0, 0.18, 6.4, 0.18], [0, 6.3, 0.7, 0.14, 0.14, 1.6]]), metal);
    const nLamp = byType.get('lamp')?.length ?? 0;
    this.lampHeads = new THREE.InstancedMesh(makePart([[0, 6.18, 1.35, 0.45, 0.16, 0.55]]), glowMat(0xffd48a), Math.max(1, nLamp));
    this.lampHeads.count = nLamp;
    this.lampHeads.frustumCulled = false;
    this.meshes.get('lamp')!.push(this.lampHeads);
    this.lampPools = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2), lightPoolMat(0xffc978, 0.42), Math.max(1, nLamp));
    this.lampPools.count = nLamp;
    this.lampPools.frustumCulled = false;
    this.group.add(this.lampHeads, this.lampPools);

    add('hydrant', makePart([[0, 0.4, 0, 0.38, 0.8, 0.38], [0, 0.55, 0, 0.58, 0.18, 0.22], [0, 0.85, 0, 0.26, 0.18, 0.26]]), lambert({ color: 0xd9251d }));
    add('bench', makePart([[0, 0.4, 0, 1.7, 0.1, 0.55], [0, 0.7, -0.22, 1.7, 0.45, 0.1], [-0.7, 0.2, 0, 0.12, 0.4, 0.5], [0.7, 0.2, 0, 0.12, 0.4, 0.5]]), lambert({ color: 0x7c5333 }));
    add('bin', makePart([[0, 0.55, 0, 0.65, 1.1, 0.65]]), lambert({ color: 0x2b5b3c }));
    add('newsstand', makePart([[0, 0.85, 0, 1.1, 1.7, 0.8]]), lambert({ color: 0x1e5aa8 }));
    add('newsstand', makePart([[0, 1.1, 0.41, 0.9, 0.6, 0.04]]), glowMat(0xffe08a));
    add('cone', new THREE.ConeGeometry(0.28, 0.8, 6).translate(0, 0.4, 0), lambert({ color: 0xff6600, emissive: 0x331100 }));
    // tree: trunk + foliage
    add('tree', makePart([[0, 1.3, 0, 0.38, 2.6, 0.38]]), lambert({ color: 0x5a3c24 }));
    add('tree', new THREE.ConeGeometry(1.7, 3.6, 7).translate(0, 3.6, 0), lambert({ color: 0x264d2b }));
    // speed camera: pole + yellow box
    add('camera', makePart([[0, 1.8, 0, 0.16, 3.6, 0.16]]), metal);
    add('camera', makePart([[0, 3.7, 0, 0.55, 0.7, 0.45]]), lambert({ color: 0xf5c400, emissive: 0x332800 }));
  }

  private writeRestMatrix(s: PropSpec, idx: number, poolIdx: number) {
    this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot);
    this.tmpM.compose(this.tmpP.set(s.x, 0.14, s.z), this.tmpQ, this.tmpS);
    for (const im of this.meshes.get(s.type)!) {
      im.setMatrixAt(idx, this.tmpM);
      im.instanceMatrix.needsUpdate = true;
    }
    if (poolIdx >= 0) {
      const fx = Math.sin(s.rot);
      const fz = Math.cos(s.rot);
      this.tmpM.makeTranslation(s.x + fx * 1.4, 0.04, s.z + fz * 1.4);
      this.lampPools.setMatrixAt(poolIdx, this.tmpM);
      this.lampPools.instanceMatrix.needsUpdate = true;
    }
  }

  private spawnBody(p: LiveProp) {
    const [hx, hy, hz, mass] = PROP_BOX[p.spec.type];
    const s = p.spec;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(s.x, 0.14 + hy, s.z)
      .setRotation({ x: 0, y: Math.sin(s.rot / 2), z: 0, w: Math.cos(s.rot / 2) })
      .setLinearDamping(0.6)
      .setAngularDamping(0.8)
      .setSleeping(true);
    p.body = this.phys.world.createRigidBody(desc);
    p.collider = this.phys.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setMass(mass).setFriction(0.5).setCollisionGroups(groups(G.PROP, G.ALL)),
      p.body,
    );
    this.phys.register(p.collider, { kind: 'prop', ref: p });
  }

  private removeBody(p: LiveProp) {
    if (!p.body) return;
    if (p.collider) this.phys.unregister(p.collider);
    this.phys.world.removeRigidBody(p.body);
    p.body = undefined;
    p.collider = undefined;
  }

  update(px: number, pz: number, time: number) {
    const dirty = new Set<THREE.InstancedMesh>();
    let poolsDirty = false;
    for (const p of this.items) {
      const dx = p.spec.x - px;
      const dz = p.spec.z - pz;
      const d2 = dx * dx + dz * dz;
      if (!p.smashed) {
        if (d2 < 85 * 85 && !p.body) this.spawnBody(p);
        else if (d2 > 105 * 105 && p.body) this.removeBody(p);
        if (p.body && !p.body.isSleeping()) {
          const t = p.body.translation();
          const moved = Math.hypot(t.x - p.spec.x, t.z - p.spec.z) > 0.35 || Math.abs(t.y - (0.14 + PROP_BOX[p.spec.type][1])) > 0.25;
          if (moved) {
            p.smashed = true;
            p.despawnAt = time + 5;
            // kick upwards a bit for dramatic arcade scatter
            const v = p.body.linvel();
            p.body.setLinvel({ x: v.x * 1.25, y: Math.max(v.y, 4.5), z: v.z * 1.25 }, true);
            this.bus.emit('propSmashed', { x: p.spec.x, z: p.spec.z });
            if (p.poolIdx >= 0) {
              this.lampPools.setMatrixAt(p.poolIdx, this.zeroM);
              poolsDirty = true;
            }
          }
        }
      }
      if (p.smashed && p.body) {
        const hy = PROP_BOX[p.spec.type][1];
        const t = p.body.translation();
        const r = p.body.rotation();
        this.tmpQ.set(r.x, r.y, r.z, r.w);
        this.tmpP.set(0, -hy, 0).applyQuaternion(this.tmpQ).add(t as THREE.Vector3);
        this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
        for (const im of this.meshes.get(p.spec.type)!) {
          im.setMatrixAt(p.idx, this.tmpM);
          dirty.add(im);
        }
        if (time > p.despawnAt) this.removeBody(p);
      } else if (p.smashed && !p.body && d2 > 180 * 180) {
        // respawn once the player is far away
        p.smashed = false;
        this.writeRestMatrix(p.spec, p.idx, p.poolIdx);
      }
    }
    for (const im of dirty) im.instanceMatrix.needsUpdate = true;
    if (poolsDirty) this.lampPools.instanceMatrix.needsUpdate = true;
  }
}
