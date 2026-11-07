import * as THREE from 'three';
import { CITY, lineCoord, type Building, type CityLayout } from './CityLayout';
import { lightState } from './TrafficLights';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import {
  basic,
  glowMat,
  lambert,
  lightPoolMat,
  makeAsphaltTexture,
  makeConcreteTexture,
  makeWindowTextures,
  type WallStyle,
} from '../render/materials';

/** Minimal geometry accumulator (positions, normals, uvs, colors) to batch thousands of boxes into one mesh. */
class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  quad(
    p0: number[],
    p1: number[],
    p2: number[],
    p3: number[],
    n: number[],
    uv: [number, number, number, number],
    c: THREE.Color,
  ) {
    const b = this.pos.length / 3;
    this.pos.push(...p0, ...p1, ...p2, ...p3);
    for (let k = 0; k < 4; k++) this.nor.push(...n), this.col.push(c.r, c.g, c.b);
    const [u0, v0, u1, v1] = uv;
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }

  /** Horizontal rectangle at height y. */
  flat(x0: number, z0: number, x1: number, z1: number, y: number, c: THREE.Color, uvScale = 0) {
    const s = uvScale;
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], s ? [x0 * s, z1 * s, x1 * s, z0 * s] : [0, 0, 1, 1], c);
  }

  /** Axis-aligned box walls (4 sides) with world-scaled UVs. */
  walls(cx: number, y0: number, cz: number, w: number, h: number, d: number, c: THREE.Color, uS: number, vS: number, uOff = 0) {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - d / 2;
    const z1 = cz + d / 2;
    const y1 = y0 + h;
    const v0 = y0 * vS;
    const v1 = y1 * vS;
    // +z
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [uOff, v0, uOff + w * uS, v1], c);
    // -z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [uOff + 0.3, v0, uOff + 0.3 + w * uS, v1], c);
    // +x
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [uOff + 0.6, v0, uOff + 0.6 + d * uS, v1], c);
    // -x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [uOff + 0.15, v0, uOff + 0.15 + d * uS, v1], c);
  }

  box(cx: number, y0: number, cz: number, w: number, h: number, d: number, c: THREE.Color) {
    this.walls(cx, y0, cz, w, h, d, c, 0, 0);
    this.flat(cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, y0 + h, c);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const PALETTES: Record<WallStyle, number[]> = {
  downtown: [0x9aa6b8, 0x7f8ea6, 0xb5b0a8, 0x8a9a9a, 0x6f7a90, 0xc0c8d0],
  suburbs: [0xd8c8a8, 0xc9a68a, 0xb8c4b0, 0xe0d8c8, 0xa8b8c8, 0xd0a090],
  industrial: [0x9a9080, 0x8a8f94, 0x7a8a7a, 0xa09070, 0x6a7a8a],
};
const NEON = [0xff2a6d, 0x05d9e8, 0xfffb00, 0x39ff14, 0xff6b00, 0xd400ff, 0x00ffa2];

export interface SignalHead {
  intersection: number;
  axis: 'x' | 'z';
}

/** Builds all static city geometry + colliders from a layout. */
export class CityBuilder {
  readonly group = new THREE.Group();
  private signalMesh!: THREE.InstancedMesh;
  private signalHeads: SignalHead[] = [];
  private signalCache: string[] = [];
  private beacons: THREE.Mesh[] = [];
  private col = new THREE.Color();

  constructor(
    private layout: CityLayout,
    private phys: PhysicsWorld,
  ) {
    this.buildGround();
    this.buildBlocks();
    this.buildMarkings();
    this.buildBuildings();
    this.buildSignals();
    this.buildBoundary();
  }

  private buildGround() {
    const size = CITY.HALF * 2 + 400;
    const tex = makeAsphaltTexture();
    tex.repeat.set(size / 12, size / 12);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), lambert({ map: tex, color: 0x9a9aa6 }));
    ground.rotation.x = -Math.PI / 2;
    this.group.add(ground);
    this.phys.addGround(size / 2);
  }

  private buildBlocks() {
    const side = new GeoBuilder();
    const grass = new GeoBuilder();
    const B = CITY.BLOCK;
    const curb = 0.14;
    const cSide = new THREE.Color(0xffffff);
    const cGrass = new THREE.Color(0xffffff);
    for (const b of this.layout.blocks) {
      const x0 = b.cx - B / 2;
      const z0 = b.cz - B / 2;
      side.flat(x0, z0, x0 + B, z0 + B, curb, cSide, 1 / 8);
      side.walls(b.cx, 0, b.cz, B, curb, B, new THREE.Color(0xb0b0b0), 1 / 8, 1 / 8);
      if (b.district === 'park' || b.district === 'suburbs') {
        const inset = b.district === 'park' ? CITY.SIDEWALK : CITY.SIDEWALK + 1;
        grass.flat(x0 + inset, z0 + inset, x0 + B - inset, z0 + B - inset, curb + 0.02, cGrass, 1 / 6);
      }
    }
    // plazas over removed road segments
    const plaza = new GeoBuilder();
    for (const s of this.layout.segments) {
      if (!s.removed) continue;
      const A = this.layout.intersections[s.a];
      const Bn = this.layout.intersections[s.b];
      const h = CITY.ROAD / 2;
      if (s.axis === 'x') plaza.flat(A.x + h, A.z - h, Bn.x - h, A.z + h, 0.06, cSide, 1 / 4);
      else plaza.flat(A.x - h, A.z + h, A.x + h, Bn.z - h, 0.06, cSide, 1 / 4);
    }
    this.group.add(new THREE.Mesh(side.build(), lambert({ map: makeConcreteTexture('#6d6d72'), vertexColors: true })));
    const gt = makeConcreteTexture('#2f4a2a');
    this.group.add(new THREE.Mesh(grass.build(), lambert({ map: gt, color: 0x88aa77, vertexColors: true })));
    this.group.add(new THREE.Mesh(plaza.build(), lambert({ map: makeConcreteTexture('#7a6656'), vertexColors: true })));
  }

  private buildMarkings() {
    const m = new GeoBuilder();
    const white = new THREE.Color(0xd8d8d0);
    const yellow = new THREE.Color(0xe0b020);
    const y = 0.025;
    const h = CITY.ROAD / 2;
    for (const s of this.layout.segments) {
      if (s.removed) continue;
      const A = this.layout.intersections[s.a];
      const B = this.layout.intersections[s.b];
      const len = Math.hypot(B.x - A.x, B.z - A.z) - CITY.ROAD;
      const along = (t: number, off: number, l: number, w: number, c: THREE.Color) => {
        // rectangle centred at road position (t along, off across)
        if (s.axis === 'x') m.flat(A.x + h + t, A.z + off - w / 2, A.x + h + t + l, A.z + off + w / 2, y, c);
        else m.flat(A.x + off - w / 2, A.z + h + t, A.x + off + w / 2, A.z + h + t + l, y, c);
      };
      if (s.ring) {
        along(0, -0.2, len, 0.15, yellow);
        along(0, 0.2, len, 0.15, yellow);
      } else {
        for (let t = 2; t < len - 3; t += 7) along(t, 0, 3, 0.18, white);
      }
      // edge lines
      along(0, h - 0.6, len, 0.12, white);
      along(0, -h + 0.6, len, 0.12, white);
      // crosswalks at both ends (only where the intersection has signals)
      for (const [end, I] of [
        [0, A],
        [len - 3, B],
      ] as const) {
        if (!I.hasLights) continue;
        for (let k = -h + 1; k < h - 0.5; k += 1.4) along(end, k + 0.35, 3, 0.7, white);
      }
    }
    const mat = lambert({ vertexColors: true, emissive: 0x222222, polygonOffset: true, polygonOffsetFactor: -1 });
    this.group.add(new THREE.Mesh(m.build(), mat));
  }

  private buildBuildings() {
    const styles: WallStyle[] = ['downtown', 'suburbs', 'industrial'];
    const walls: Record<WallStyle, GeoBuilder> = { downtown: new GeoBuilder(), suburbs: new GeoBuilder(), industrial: new GeoBuilder() };
    const roofs = new GeoBuilder();
    const neon = new GeoBuilder();
    const roofLights: THREE.Vector3[] = [];
    let seed = this.layout.seed;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    const styleOf = (b: Building): WallStyle => (b.district === 'downtown' ? 'downtown' : b.district === 'industrial' ? 'industrial' : 'suburbs');
    for (const b of this.layout.buildings) {
      const st = styleOf(b);
      const pal = PALETTES[st];
      const c = new THREE.Color(pal[Math.floor(b.tint * pal.length)]);
      const uS = 1 / 64;
      const vS = st === 'industrial' ? 1 / 24 : 1 / 64;
      const uOff = Math.floor(b.tint * 8) / 8;
      walls[st].walls(b.x, 0, b.z, b.w, b.h, b.d, c, uS, vS, uOff);
      const rc = new THREE.Color(0x3a3b40).lerp(c, 0.15);
      roofs.flat(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, b.h, rc);
      // parapet + rooftop clutter
      if (st !== 'suburbs') {
        for (let k = 0; k < (st === 'downtown' ? 3 : 2); k++) {
          const w = 2 + rnd() * 5;
          roofs.box(b.x + (rnd() - 0.5) * (b.w - w), b.h, b.z + (rnd() - 0.5) * (b.d - w), w, 1 + rnd() * 3, w, rc.clone().multiplyScalar(0.8));
        }
      } else {
        // pitched-roof look: a smaller dark box on top
        roofs.box(b.x, b.h, b.z, b.w * 0.8, 1.6, b.d * 0.8, new THREE.Color(0x4a2f2a));
      }
      if (st === 'downtown' && b.h > 70) roofLights.push(new THREE.Vector3(b.x, b.h + 1.5, b.z));
      if (b.neon) {
        const nc = new THREE.Color(NEON[Math.floor(rnd() * NEON.length)]);
        const face = Math.floor(rnd() * 4);
        const vertical = rnd() < 0.5 && b.h > 25;
        const sw = vertical ? 1.6 : Math.min(b.w, b.d) * (0.4 + rnd() * 0.4);
        const sh = vertical ? Math.min(14, b.h * 0.4) : 1.8;
        const sy = vertical ? 6 + rnd() * 6 : Math.min(b.h - 3, 5 + rnd() * 8);
        const off = 0.25;
        if (face === 0) neon.box(b.x, sy, b.z + b.d / 2 + off, sw, sh, 0.3, nc);
        else if (face === 1) neon.box(b.x, sy, b.z - b.d / 2 - off, sw, sh, 0.3, nc);
        else if (face === 2) neon.box(b.x + b.w / 2 + off, sy, b.z, 0.3, sh, sw, nc);
        else neon.box(b.x - b.w / 2 - off, sy, b.z, 0.3, sh, sw, nc);
        // rooftop neon strip
        if (st === 'downtown' && rnd() < 0.5) neon.box(b.x, b.h, b.z + b.d / 2 + 0.1, b.w, 0.4, 0.2, nc);
      }
      this.phys.addStaticBox(b.x, b.h / 2, b.z, b.w / 2, b.h / 2, b.d / 2);
    }
    for (const st of styles) {
      const [map, em] = makeWindowTextures(st, st.length * 31);
      const mat = lambert({ map, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: 1.25, vertexColors: true });
      this.group.add(new THREE.Mesh(walls[st].build(), mat));
    }
    this.group.add(new THREE.Mesh(roofs.build(), lambert({ vertexColors: true })));
    this.group.add(new THREE.Mesh(neon.build(), basic({ vertexColors: true, toneMapped: false })));

    // blinking aircraft warning lights
    const rl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.7, 6, 4), glowMat(0xff2020), Math.max(1, roofLights.length));
    const m = new THREE.Matrix4();
    roofLights.forEach((p, i) => rl.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    rl.count = roofLights.length;
    rl.name = 'roofLights';
    this.group.add(rl);
  }

  private buildSignals() {
    const poles: THREE.Matrix4[] = [];
    const heads: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const off = CITY.ROAD / 2 + 1;
    for (const I of this.layout.intersections) {
      if (!I.hasLights) continue;
      for (const l of this.layout.graph.incoming[I.id]) {
        // pole on the near-right corner of the approach
        const rx = -l.dz;
        const rz = l.dx;
        const px = I.x - l.dx * off + rx * off;
        const pz = I.z - l.dz * off + rz * off;
        const yaw = Math.atan2(-l.dx, -l.dz);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        poles.push(new THREE.Matrix4().compose(new THREE.Vector3(px, 0, pz), q, new THREE.Vector3(1, 1, 1)));
        // head hangs over the lane
        const hx = px - rx * 3.2;
        const hz = pz - rz * 3.2;
        heads.push(new THREE.Matrix4().compose(new THREE.Vector3(hx, 5.4, hz), q, new THREE.Vector3(1, 1, 1)));
        this.signalHeads.push({ intersection: I.id, axis: l.axis });
        this.phys.addStaticBox(px, 2.5, pz, 0.15, 2.5, 0.15);
      }
    }
    // Pole with arm (merged)
    const poleGeo = new THREE.BoxGeometry(0.22, 6, 0.22).translate(0, 3, 0);
    const armGeo = new THREE.BoxGeometry(3.6, 0.16, 0.16);
    const poleMat = lambert({ color: 0x3a3d42 });
    const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, poles.length);
    poles.forEach((p, i) => poleMesh.setMatrixAt(i, p));
    this.group.add(poleMesh);
    const arms = new THREE.InstancedMesh(armGeo, poleMat, poles.length);
    const housing = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 1.3, 0.4), lambert({ color: 0x1a1a1a }), heads.length);
    this.signalMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.42, 0.12), basic({ color: 0xffffff, toneMapped: false }), heads.length);
    heads.forEach((h, i) => {
      // arm midpoint between pole and head
      const pp = new THREE.Vector3().setFromMatrixPosition(poles[i]);
      const hp = new THREE.Vector3().setFromMatrixPosition(h);
      const mid = pp.clone().add(hp).multiplyScalar(0.5);
      mid.y = 5.95;
      const rq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), hp.clone().sub(pp).setY(0).normalize());
      arms.setMatrixAt(i, m.compose(mid, rq, new THREE.Vector3(1, 1, 1)));
      housing.setMatrixAt(i, h);
      const lamp = h.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.22));
      this.signalMesh.setMatrixAt(i, lamp);
      this.signalMesh.setColorAt(i, this.col.set(0x00ff66));
      this.signalCache.push('');
    });
    this.group.add(arms, housing, this.signalMesh);
  }

  private buildBoundary() {
    const H = CITY.HALF + 30;
    const wallMat = lambert({ color: 0x55565c, map: makeConcreteTexture('#6a6a6a') });
    const stripe = basic({ color: 0xffa000, toneMapped: false });
    for (const [x, z, w, d] of [
      [0, -H, H * 2, 2],
      [0, H, H * 2, 2],
      [-H, 0, 2, H * 2],
      [H, 0, 2, H * 2],
    ]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), wallMat);
      mesh.position.set(x, 2, z);
      this.group.add(mesh);
      const s = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.3, d + 0.1), stripe);
      s.position.set(x, 3.2, z);
      this.group.add(s);
      this.phys.addStaticBox(x, 2, z, w / 2, 4, d / 2);
    }
  }

  /** Job beacons (tall translucent light columns). */
  addBeacon(x: number, z: number, color: number): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(3, 3, 60, 16, 1, true).translate(0, 30, 0);
    const mat = basic({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0, z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.5, 4.5, 24).rotateX(-Math.PI / 2), lightPoolMat(color, 0.9));
    ring.position.y = 0.1;
    mesh.add(ring);
    this.group.add(mesh);
    this.beacons.push(mesh);
    return mesh;
  }

  /** Update signal head colours (cheap: only writes changed instances). */
  update(time: number) {
    let dirty = false;
    for (let i = 0; i < this.signalHeads.length; i++) {
      const h = this.signalHeads[i];
      const st = lightState(this.layout.intersections[h.intersection], h.axis, time);
      if (st !== this.signalCache[i]) {
        this.signalCache[i] = st;
        this.signalMesh.setColorAt(i, this.col.set(st === 'green' ? 0x00ff66 : st === 'yellow' ? 0xffb000 : 0xff1a1a));
        dirty = true;
      }
    }
    if (dirty && this.signalMesh.instanceColor) this.signalMesh.instanceColor.needsUpdate = true;
    const rl = this.group.getObjectByName('roofLights') as THREE.InstancedMesh | undefined;
    if (rl) rl.visible = Math.sin(time * 3) > 0;
    for (const b of this.beacons) b.rotation.y = time * 0.5;
  }
}

export { lineCoord };
