import RAPIER from '@dimforge/rapier3d-compat';
import type { VehicleSpec } from '../vehicles/carSpecs';
import { G, groups, type EntityRef, type PhysicsWorld } from './PhysicsWorld';
import { clamp, damp, lerp } from '../core/rng';

export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (brake, then reverse when slow)
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
  nitro: boolean;
}

export const emptyInput = (): DriveInput => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false });

/**
 * Arcade car model on a single Rapier rigid body.
 * Roll/pitch are locked so the car never flips; we directly shape the
 * forward/lateral velocity each step for a forgiving, PS2-arcade feel,
 * while Rapier resolves all collisions (rams, props, buildings).
 */
export class ArcadeVehicle {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  input: DriveInput = emptyInput();

  // State exposed for rendering/audio/gameplay
  speed = 0; // signed forward speed m/s
  lateral = 0; // lateral slip m/s
  yaw = 0;
  drifting = false;
  nitro = 1; // 0..1 tank
  nitroActive = false;
  spikedTime = 0;
  /** Multiplier on top speed (AI rubber-banding etc.) */
  topSpeedScale = 1;
  /** When true, controls are ignored and grip is reduced (crashed traffic). */
  uncontrolled = false;
  lastDeltaV = 0;
  private prevVx = 0;
  private prevVz = 0;

  constructor(
    readonly phys: PhysicsWorld,
    readonly spec: VehicleSpec,
    x: number,
    z: number,
    yaw: number,
    membership: number,
    ent: EntityRef,
  ) {
    const hy = spec.height * 0.32;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, hy + 0.12, z)
      .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
      .enabledRotations(false, true, false)
      .setCanSleep(false)
      .setCcdEnabled(true);
    this.body = phys.world.createRigidBody(desc);
    const cdesc = RAPIER.ColliderDesc.cuboid(spec.width / 2, hy, spec.length / 2)
      .setMass(spec.mass)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0.15)
      .setCollisionGroups(groups(membership, G.ALL))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.collider = phys.world.createCollider(cdesc, this.body);
    phys.register(this.collider, ent);
    this.yaw = yaw;
  }

  get x() {
    return this.body.translation().x;
  }
  get z() {
    return this.body.translation().z;
  }
  get fwdX() {
    return Math.sin(this.yaw);
  }
  get fwdZ() {
    return Math.cos(this.yaw);
  }

  /** Apply controls for one fixed step. Call before world.step(). */
  update(dt: number) {
    const r = this.body.rotation();
    this.yaw = 2 * Math.atan2(r.y, r.w);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    // right vector (matches lane convention): (-fz, fx)... but for steering, positive steer = turn right
    const rx = -fz;
    const rz = fx;

    const v = this.body.linvel();
    // Impact detection from velocity discontinuity (collisions happen inside step)
    this.lastDeltaV = Math.hypot(v.x - this.prevVx, v.z - this.prevVz);

    let vF = v.x * fx + v.z * fz;
    let vR = v.x * rx + v.z * rz;
    const s = this.spec;
    const inp = this.uncontrolled ? emptyInput() : this.input;

    const spiked = this.spikedTime > 0;
    if (spiked) this.spikedTime -= dt;

    // --- Nitro
    this.nitroActive = inp.nitro && this.nitro > 0.01 && inp.throttle > 0.1;
    if (this.nitroActive) this.nitro = Math.max(0, this.nitro - 0.28 * dt);
    let top = s.topSpeed * this.topSpeedScale * (this.nitroActive ? 1.28 : 1) * (spiked ? 0.55 : 1);

    // --- Longitudinal
    if (inp.throttle > 0) {
      const x = clamp(vF / top, 0, 1);
      let a = s.accel * (1 - x * x) * inp.throttle;
      if (this.nitroActive) a += s.nitroAccel;
      if (vF < 0) a += s.brake * 0.5; // throttle while rolling backwards brakes first
      vF += a * dt;
    }
    if (inp.brake > 0) {
      if (vF > 0.5) vF -= s.brake * inp.brake * dt;
      else {
        const maxRev = s.topSpeed * 0.3;
        if (vF > -maxRev) vF -= s.accel * 0.6 * inp.brake * dt;
      }
    }
    if (inp.throttle === 0 && inp.brake === 0) {
      // engine braking + rolling resistance
      const drag = 2.2 + 0.0035 * vF * vF;
      if (Math.abs(vF) < drag * dt) vF = 0;
      else vF -= Math.sign(vF) * drag * dt;
    }
    if (vF > top) vF = lerp(vF, top, damp(1.5, dt)); // soft limiter (after nitro ends)
    if (inp.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 9 * dt);

    // --- Lateral grip
    let grip = s.grip;
    if (inp.handbrake) grip = 1.3;
    if (spiked) grip *= 0.35;
    if (this.uncontrolled) grip = 2.5;
    vR *= Math.exp(-grip * dt);
    this.drifting = Math.abs(vR) > 3.2 && Math.abs(vF) > 8;
    if (this.drifting && !this.nitroActive) this.nitro = Math.min(1, this.nitro + 0.12 * dt);
    this.nitro = Math.min(1, this.nitro + 0.012 * dt);

    // --- Steering (yaw rate), weaker at speed
    const absF = Math.abs(vF);
    const lowSpeed = clamp(absF / 5, 0, 1);
    const highSpeed = lerp(1, 0.42, clamp(absF / s.topSpeed, 0, 1));
    let yawTarget = -inp.steer * s.turnRate * lowSpeed * highSpeed * Math.sign(vF || 1);
    if (inp.handbrake) yawTarget *= 1.45;
    if (spiked) yawTarget += Math.sin(performance.now() * 0.004) * 0.25;
    const w = this.body.angvel();
    const yawRate = lerp(w.y, yawTarget, this.uncontrolled ? damp(1.5, dt) : damp(12, dt));

    const nvx = fx * vF + rx * vR;
    const nvz = fz * vF + rz * vR;
    this.body.setLinvel({ x: nvx, y: Math.min(v.y, 3), z: nvz }, true);
    this.body.setAngvel({ x: 0, y: yawRate, z: 0 }, true);
    this.prevVx = nvx;
    this.prevVz = nvz;
    this.speed = vF;
    this.lateral = vR;
  }

  teleport(x: number, z: number, yaw: number) {
    this.body.setTranslation({ x, y: this.spec.height * 0.32 + 0.12, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVx = this.prevVz = 0;
    this.yaw = yaw;
    this.speed = 0;
  }

  /** Give the car an initial forward speed (used when spawning traffic/cops). */
  setForwardSpeed(v: number) {
    this.body.setLinvel({ x: Math.sin(this.yaw) * v, y: 0, z: Math.cos(this.yaw) * v }, true);
    this.prevVx = Math.sin(this.yaw) * v;
    this.prevVz = Math.cos(this.yaw) * v;
    this.speed = v;
  }

  dispose() {
    this.phys.unregister(this.collider);
    this.phys.world.removeRigidBody(this.body);
  }
}
