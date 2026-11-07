/**
 * Fixed-timestep game loop: simulation runs at a constant 60 Hz using an
 * accumulator, rendering happens once per animation frame with an
 * interpolation alpha in [0,1).
 */
export class Loop {
  readonly dt = 1 / 60;
  private acc = 0;
  private last = 0;
  private running = false;
  private raf = 0;
  fps = 60;
  private fpsAcc = 0;
  private fpsFrames = 0;

  constructor(
    private step: (dt: number) => void,
    private render: (alpha: number, frameDt: number) => void,
    private maxSubSteps = 5,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      let frameDt = (now - this.last) / 1000;
      this.last = now;
      if (frameDt > 0.25) frameDt = 0.25;
      this.acc += frameDt;
      let steps = 0;
      while (this.acc >= this.dt && steps < this.maxSubSteps) {
        this.step(this.dt);
        this.acc -= this.dt;
        steps++;
      }
      if (steps === this.maxSubSteps) this.acc = 0; // spiral-of-death guard
      this.fpsAcc += frameDt;
      this.fpsFrames++;
      if (this.fpsAcc >= 0.5) {
        this.fps = this.fpsFrames / this.fpsAcc;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
      }
      this.render(this.acc / this.dt, frameDt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
