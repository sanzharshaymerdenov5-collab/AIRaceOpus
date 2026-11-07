import * as THREE from 'three';
import { basic } from './materials';

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  s0: number;
  s1: number;
  r: number;
  g: number;
  b: number;
  grav: number;
}

/** Ring-buffer instanced particle pool (sparks, tyre smoke, engine smoke, debris). */
export class ParticleSystem {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private pool: P[] = [];
  private cursor = 0;
  private readonly max = 260;
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private c = new THREE.Color();

  // Skidmark ribbon ring buffer
  private skids: THREE.InstancedMesh;
  private skidCursor = 0;
  private readonly maxSkids = 300;

  constructor() {
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      basic({ color: 0xffffff, toneMapped: false }),
      this.max,
    );
    this.mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) {
      this.pool.push({ x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 1, s0: 0, s1: 0, r: 1, g: 1, b: 1, grav: 0 });
      this.mesh.setMatrixAt(i, zero);
      this.mesh.setColorAt(i, this.c);
    }
    this.skids = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.28, 0.9).rotateX(-Math.PI / 2),
      basic({ color: 0x0d0d10, transparent: true, opacity: 0.65, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }),
      this.maxSkids,
    );
    this.skids.frustumCulled = false;
    for (let i = 0; i < this.maxSkids; i++) this.skids.setMatrixAt(i, zero);
    this.group.add(this.mesh, this.skids);
  }

  private emit(p: Omit<P, 'age'>) {
    const slot = this.pool[this.cursor];
    Object.assign(slot, p, { age: 0 });
    this.cursor = (this.cursor + 1) % this.max;
  }

  sparks(x: number, y: number, z: number, count = 14) {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 12;
      this.emit({
        x,
        y,
        z,
        vx: Math.cos(a) * sp,
        vy: 2 + Math.random() * 7,
        vz: Math.sin(a) * sp,
        life: 0.25 + Math.random() * 0.35,
        s0: 0.16,
        s1: 0.02,
        r: 1,
        g: 0.65 + Math.random() * 0.35,
        b: 0.15,
        grav: 18,
      });
    }
  }

  smoke(x: number, y: number, z: number, dark = false) {
    const g = dark ? 0.18 : 0.75;
    this.emit({
      x: x + (Math.random() - 0.5) * 0.3,
      y,
      z: z + (Math.random() - 0.5) * 0.3,
      vx: (Math.random() - 0.5) * 1.5,
      vy: 0.8 + Math.random() * 1.2,
      vz: (Math.random() - 0.5) * 1.5,
      life: 0.5 + Math.random() * 0.4,
      s0: 0.25,
      s1: 1.1,
      r: g,
      g,
      b: g + 0.05,
      grav: -0.5,
    });
  }

  skid(x: number, z: number, yaw: number) {
    const rx = -Math.cos(yaw);
    const rz = Math.sin(yaw);
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (const side of [-0.75, 0.75]) {
      this.p.set(x + rx * side, 0.03, z + rz * side);
      this.m.compose(this.p, this.q, this.s.set(1, 1, 1));
      this.skids.setMatrixAt(this.skidCursor, this.m);
      this.skidCursor = (this.skidCursor + 1) % this.maxSkids;
    }
    this.skids.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (p.age >= p.life) continue;
      p.age += dt;
      if (p.age >= p.life) {
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        continue;
      }
      p.vy -= p.grav * dt;
      p.x += p.vx * dt;
      p.y = Math.max(0.05, p.y + p.vy * dt);
      p.z += p.vz * dt;
      const t = p.age / p.life;
      const sc = p.s0 + (p.s1 - p.s0) * t;
      this.m.makeTranslation(p.x, p.y, p.z).scale(this.s.set(sc, sc, sc));
      this.mesh.setMatrixAt(i, this.m);
      const fade = 1 - t * 0.7;
      this.mesh.setColorAt(i, this.c.setRGB(p.r * fade, p.g * fade, p.b * fade));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
