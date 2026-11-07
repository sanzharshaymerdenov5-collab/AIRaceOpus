import * as THREE from 'three';
import { clamp, damp, lerp, wrapAngle } from '../core/rng';
import type { ArcadeVehicle } from '../physics/ArcadeVehicle';

export type CamMode = 'chase' | 'far' | 'hood';
const MODES: CamMode[] = ['chase', 'far', 'hood'];

export class ChaseCamera {
  readonly cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 950);
  mode: CamMode = 'chase';
  private yaw = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shake = 0;

  snap(car: ArcadeVehicle) {
    this.yaw = car.yaw;
    this.pos.set(car.x - Math.sin(car.yaw) * 7, 3, car.z - Math.cos(car.yaw) * 7);
  }

  cycleMode() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
  }

  kick(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  update(dt: number, car: ArcadeVehicle, lookBack = false) {
    this.cam.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const targetYaw = lookBack ? car.yaw + Math.PI : car.yaw;
    this.yaw += wrapAngle(targetYaw - this.yaw) * (lookBack ? 1 : damp(6.5, dt));

    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    if (this.mode === 'hood') {
      this.pos.set(car.x + Math.sin(car.yaw) * 0.6, car.spec.height + 0.35, car.z + Math.cos(car.yaw) * 0.6);
      this.look.set(car.x + fx * 30, 1.3, car.z + fz * 30);
    } else {
      const dist = (this.mode === 'far' ? 9.5 : 6.6) + (car.nitroActive ? 1.1 : 0);
      const h = this.mode === 'far' ? 3.8 : 2.55;
      const tx = car.x - fx * dist;
      const tz = car.z - fz * dist;
      this.pos.x = lerp(this.pos.x, tx, damp(14, dt));
      this.pos.y = lerp(this.pos.y, h, damp(10, dt));
      this.pos.z = lerp(this.pos.z, tz, damp(14, dt));
      this.look.set(car.x + fx * 6, 1.2, car.z + fz * 6);
    }

    if (this.shake > 0.001) {
      this.pos.x += (Math.random() - 0.5) * this.shake * 0.6;
      this.pos.y += (Math.random() - 0.5) * this.shake * 0.4;
      this.shake *= Math.exp(-8 * dt);
    }

    const sp01 = clamp(Math.abs(car.speed) / 65, 0, 1);
    const targetFov = 60 + sp01 * 16 + (car.nitroActive ? 9 : 0);
    this.cam.fov = lerp(this.cam.fov, targetFov, damp(8, dt));
    this.cam.updateProjectionMatrix();
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
  }
}
