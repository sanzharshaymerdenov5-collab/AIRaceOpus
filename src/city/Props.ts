import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PropSpec, PropType } from './CityLayout';
import { G, groups, type PhysicsWorld } from '../physics/PhysicsWorld';
import { glowMat, lambert, lightPoolMat, phong } from '../render/materials';
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

/** Merge a list of BufferGeometries into one single-material prototype for InstancedMesh. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const norm = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    n.clearGroups();
    return n;
  });
  const out = mergeGeometries(norm, false)!;
  out.computeBoundingSphere();
  return out;
}

const boxAt = (w: number, h: number, d: number, x = 0, y = 0, z = 0, rx = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  return g.translate(x, y, z);
};

const cylAt = (rt: number, rb: number, h: number, seg: number, x = 0, y = 0, z = 0, rx = 0, rz = 0) => {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  return g.translate(x, y, z);
};

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
    const metal = phong({ color: 0x383d46, shininess: 65, specular: 0x555555 });
    const darkIron = lambert({ color: 0x22252b });
    const silver = phong({ color: 0xc8cdd6, shininess: 90 });

    // Streetlamp: octagonal plinth + tapered shaft + curved luminaire arm + cobra head
    add(
      'lamp',
      mergeParts([
        cylAt(0.2, 0.25, 0.35, 8, 0, 0.175, 0),
        cylAt(0.14, 0.19, 0.45, 8, 0, 0.55, 0),
        cylAt(0.065, 0.12, 5.4, 10, 0, 3.45, 0),
        cylAt(0.05, 0.065, 0.9, 8, 0, 6.2, 0.38, Math.PI * 0.36),
        cylAt(0.045, 0.05, 0.85, 8, 0, 6.38, 1.12, Math.PI * 0.48),
        boxAt(0.38, 0.12, 0.62, 0, 6.38, 1.52),
      ]),
      metal,
    );
    const nLamp = byType.get('lamp')?.length ?? 0;
    this.lampHeads = new THREE.InstancedMesh(
      mergeParts([boxAt(0.32, 0.07, 0.48, 0, 6.3, 1.54)]),
      glowMat(0xffd48a),
      Math.max(1, nLamp),
    );
    this.lampHeads.count = nLamp;
    this.lampHeads.frustumCulled = false;
    this.meshes.get('lamp')!.push(this.lampHeads);
    this.lampPools = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2), lightPoolMat(0xffc978, 0.42), Math.max(1, nLamp));
    this.lampPools.count = nLamp;
    this.lampPools.frustumCulled = false;
    this.group.add(this.lampHeads, this.lampPools);

    // Fire hydrant: flanged base + barrel + domed bonnet + side/front nozzles
    add(
      'hydrant',
      mergeParts([
        cylAt(0.22, 0.25, 0.12, 12, 0, 0.06, 0),
        cylAt(0.17, 0.18, 0.56, 12, 0, 0.4, 0),
        cylAt(0.21, 0.21, 0.08, 12, 0, 0.68, 0),
        new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.72, 0),
      ]),
      phong({ color: 0xd9251d, shininess: 70 }),
    );
    add(
      'hydrant',
      mergeParts([
        cylAt(0.09, 0.09, 0.48, 10, 0, 0.52, 0, 0, Math.PI / 2),
        cylAt(0.11, 0.11, 0.12, 10, 0, 0.5, 0.17, Math.PI / 2),
        cylAt(0.05, 0.06, 0.08, 6, 0, 0.91, 0),
      ]),
      silver,
    );

    // Park bench: wooden slats + cast-iron legs & armrests
    add(
      'bench',
      mergeParts([
        boxAt(1.68, 0.045, 0.11, 0, 0.42, 0.16),
        boxAt(1.68, 0.045, 0.11, 0, 0.42, 0.03),
        boxAt(1.68, 0.045, 0.11, 0, 0.41, -0.1),
        boxAt(1.68, 0.11, 0.04, 0, 0.58, -0.2, -0.18),
        boxAt(1.68, 0.11, 0.04, 0, 0.72, -0.23, -0.18),
        boxAt(1.68, 0.11, 0.04, 0, 0.86, -0.26, -0.18),
      ]),
      lambert({ color: 0x865936 }),
    );
    add(
      'bench',
      mergeParts([
        boxAt(0.07, 0.42, 0.48, -0.72, 0.21, -0.02),
        boxAt(0.07, 0.42, 0.48, 0.72, 0.21, -0.02),
        boxAt(0.07, 0.5, 0.07, -0.72, 0.65, -0.22, -0.18),
        boxAt(0.07, 0.5, 0.07, 0.72, 0.65, -0.22, -0.18),
        boxAt(0.06, 0.05, 0.46, -0.72, 0.56, 0.0),
        boxAt(0.06, 0.05, 0.46, 0.72, 0.56, 0.0),
      ]),
      darkIron,
    );

    // Street bin: ribbed cylindrical bin with domed hood
    add(
      'bin',
      mergeParts([
        cylAt(0.31, 0.27, 0.82, 14, 0, 0.41, 0),
        cylAt(0.33, 0.33, 0.06, 14, 0, 0.82, 0),
        new THREE.SphereGeometry(0.31, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 0.84, 0),
      ]),
      phong({ color: 0x245638, shininess: 50 }),
    );
    add('bin', mergeParts([cylAt(0.325, 0.325, 0.04, 14, 0, 0.55, 0), boxAt(0.34, 0.14, 0.08, 0, 0.92, 0.25)]), darkIron);

    // Newsstand: kiosk cabinet + pitched awning roof + illuminated magazine rack
    add(
      'newsstand',
      mergeParts([
        boxAt(1.16, 1.55, 0.82, 0, 0.775, 0),
        boxAt(1.28, 0.14, 1.02, 0, 1.62, 0.06, 0.1),
        boxAt(1.2, 0.06, 0.22, 0, 0.78, 0.46),
      ]),
      phong({ color: 0x1e5aa8, shininess: 55 }),
    );
    add('newsstand', mergeParts([boxAt(0.96, 0.66, 0.04, 0, 1.15, 0.42), boxAt(0.96, 0.16, 0.04, 0, 1.62, 0.56)]), glowMat(0xffe08a));

    // Traffic cone: square weighted base + orange cone + white reflective collar
    add(
      'cone',
      mergeParts([
        boxAt(0.52, 0.06, 0.52, 0, 0.03, 0),
        cylAt(0.055, 0.22, 0.76, 12, 0, 0.44, 0),
      ]),
      lambert({ color: 0xff6200, emissive: 0x331100 }),
    );
    add('cone', mergeParts([cylAt(0.095, 0.135, 0.18, 12, 0, 0.56, 0)]), glowMat(0xf4f6fa));

    // Tree: tapered trunk + main boughs + multi-sphere leafy crown
    add(
      'tree',
      mergeParts([
        cylAt(0.18, 0.28, 2.5, 10, 0, 1.25, 0),
        cylAt(0.08, 0.14, 1.1, 7, 0.28, 2.3, 0.1, 0.15, -0.45),
        cylAt(0.08, 0.13, 1.0, 7, -0.25, 2.2, -0.15, -0.2, 0.42),
      ]),
      lambert({ color: 0x5a3c24 }),
    );
    add(
      'tree',
      mergeParts([
        new THREE.DodecahedronGeometry(1.45, 1).scale(1.1, 0.95, 1.1).translate(0, 3.6, 0),
        new THREE.DodecahedronGeometry(1.1, 1).translate(0.75, 3.25, 0.45),
        new THREE.DodecahedronGeometry(1.05, 1).translate(-0.7, 3.3, -0.45),
        new THREE.DodecahedronGeometry(0.95, 1).translate(-0.25, 4.45, 0.25),
      ]),
      lambert({ color: 0x28542e }),
    );

    // Speed camera: post + high-vis yellow enclosure + dark visor & dual lenses
    add('camera', mergeParts([cylAt(0.08, 0.1, 3.5, 10, 0, 1.75, 0), boxAt(0.54, 0.06, 0.52, 0, 4.08, 0.04)]), metal);
    add('camera', mergeParts([boxAt(0.52, 0.72, 0.44, 0, 3.7, 0)]), phong({ color: 0xf5c400, emissive: 0x332800, shininess: 70 }));
    add(
      'camera',
      mergeParts([
        cylAt(0.1, 0.1, 0.08, 12, 0, 3.82, 0.23, Math.PI / 2),
        cylAt(0.07, 0.07, 0.08, 10, 0, 3.54, 0.23, Math.PI / 2),
      ]),
      darkIron,
    );
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
