import { damp } from '../core/rng';
import type { DriveInput } from '../physics/ArcadeVehicle';

export class InputManager {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private steerSmooth = 0;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  isDown(code: string) {
    return this.down.has(code);
  }
  wasPressed(code: string) {
    const p = this.pressed.has(code);
    this.pressed.delete(code);
    return p;
  }
  endFrame() {
    this.pressed.clear();
  }

  drive(dt: number): DriveInput {
    const throttle = this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0;
    const brake = this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0;
    const raw = (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0) - (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0);
    this.steerSmooth += (raw - this.steerSmooth) * damp(raw === 0 ? 16 : 11, dt);
    return {
      throttle,
      brake,
      steer: Math.abs(this.steerSmooth) < 0.01 ? 0 : this.steerSmooth,
      handbrake: this.isDown('Space'),
      nitro: this.isDown('ShiftLeft') || this.isDown('ShiftRight'),
    };
  }
}
