import { clamp } from '../core/rng';
import type { VehicleSpec } from '../vehicles/carSpecs';

/**
 * Pure Web Audio synthesizer — zero external audio assets.
 * - Multi-oscillator + filtered noise engine model with automatic 6-speed gearbox & shift blip.
 * - Band-pass noise tyre screech.
 * - 3D-panned police siren with LFO wail/yelp and Doppler pitch shift.
 * - Crash, nitro, horn, camera-shutter and UI one-shots.
 * - Procedural 120 BPM synthwave loop whose layers open up with wanted stars.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxGain!: GainNode;
  private vehicleGain!: GainNode;
  private musicGain!: GainNode;

  // Engine nodes
  private engOsc1!: OscillatorNode;
  private engOsc2!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private gear = 1;
  private shiftMute = 0;

  // Screech + nitro continuous
  private screechGain!: GainNode;
  private nitroGain!: GainNode;

  // Siren
  private sirenOsc!: OscillatorNode;
  private sirenGain!: GainNode;
  private sirenPan!: StereoPannerNode;
  private sirenPhase = 0;

  private noiseBuf!: AudioBuffer;
  private stepTimer = 0;
  private stepIdx = 0;

  masterVolume = 0.85;
  musicVolume = 0.70;
  vehicleVolume = 0.85;
  sfxVolume = 0.85;

  get sfxEnabled(): boolean {
    return this.sfxVolume > 0 || this.vehicleVolume > 0;
  }
  set sfxEnabled(v: boolean) {
    if (!v) {
      this.sfxVolume = 0;
      this.vehicleVolume = 0;
    } else {
      if (this.sfxVolume === 0) this.sfxVolume = 0.85;
      if (this.vehicleVolume === 0) this.vehicleVolume = 0.85;
    }
    this.applyVolumes();
  }

  get musicEnabled(): boolean {
    return this.musicVolume > 0;
  }
  set musicEnabled(v: boolean) {
    this.musicVolume = v ? (this.musicVolume > 0 ? this.musicVolume : 0.7) : 0;
    this.applyVolumes();
  }

  setVolumes(master: number, music: number, vehicle: number, sfx = 0.85) {
    this.masterVolume = clamp(master, 0, 1);
    this.musicVolume = clamp(music, 0, 1);
    this.vehicleVolume = clamp(vehicle, 0, 1);
    this.sfxVolume = clamp(sfx, 0, 1);
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.masterVolume, t, 0.02);
    this.musicGain.gain.setTargetAtTime(this.musicVolume * 0.42, t, 0.02);
    this.vehicleGain.gain.setTargetAtTime(this.vehicleVolume, t, 0.02);
    this.sfxGain.gain.setTargetAtTime(this.sfxVolume, t, 0.02);
  }

  /** Create or resume the audio graph (call from a user gesture). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.applyVolumes();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(ctx.destination);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume;
    this.sfxGain.connect(this.master);

    this.vehicleGain = ctx.createGain();
    this.vehicleGain.gain.value = this.vehicleVolume;
    this.vehicleGain.connect(this.master);

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.musicVolume * 0.42;
    this.musicGain.connect(this.master);

    // 2s white-noise buffer reused everywhere
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Engine chain -> vehicleGain
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 400;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter.connect(this.engGain).connect(this.vehicleGain);
    this.engOsc1 = ctx.createOscillator();
    this.engOsc2 = ctx.createOscillator();
    this.engSub = ctx.createOscillator();
    this.engOsc1.type = 'sawtooth';
    this.engOsc2.type = 'square';
    this.engSub.type = 'triangle';
    const subG = ctx.createGain();
    subG.gain.value = 0.5;
    this.engOsc1.connect(this.engFilter);
    this.engOsc2.connect(this.engFilter);
    this.engSub.connect(subG).connect(this.engFilter);
    this.engOsc1.start();
    this.engOsc2.start();
    this.engSub.start();

    // Tyre screech: bandpass-filtered noise -> vehicleGain
    const scNoise = ctx.createBufferSource();
    scNoise.buffer = this.noiseBuf;
    scNoise.loop = true;
    const scBp = ctx.createBiquadFilter();
    scBp.type = 'bandpass';
    scBp.frequency.value = 1650;
    scBp.Q.value = 5;
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    scNoise.connect(scBp).connect(this.screechGain).connect(this.vehicleGain);
    scNoise.start();

    // Nitro hiss -> vehicleGain
    const nNoise = ctx.createBufferSource();
    nNoise.buffer = this.noiseBuf;
    nNoise.loop = true;
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass';
    nBp.frequency.value = 900;
    nBp.Q.value = 1.5;
    this.nitroGain = ctx.createGain();
    this.nitroGain.gain.value = 0;
    nNoise.connect(nBp).connect(this.nitroGain).connect(this.vehicleGain);
    nNoise.start();

    // Police siren -> sfxGain
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'sawtooth';
    const sLp = ctx.createBiquadFilter();
    sLp.type = 'lowpass';
    sLp.frequency.value = 2200;
    this.sirenPan = ctx.createStereoPanner();
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(sLp).connect(this.sirenPan).connect(this.sirenGain).connect(this.sfxGain);
    this.sirenOsc.start();
  }

  setTone(spec: VehicleSpec) {
    if (!this.ctx) return;
    this.engOsc2.type = spec.engineTone === 'i4' || spec.engineTone === 'v12' ? 'sawtooth' : 'square';
  }

  muteContinuous() {
    if (!this.ctx) return;
    this.engGain.gain.value = 0;
    this.screechGain.gain.value = 0;
    this.nitroGain.gain.value = 0;
    this.sirenGain.gain.value = 0;
  }

  update(
    dt: number,
    spec: VehicleSpec,
    speed: number,
    throttle: number,
    slip: number,
    nitro: boolean,
    stars: number,
    camRightX: number,
    camRightZ: number,
    px: number,
    pz: number,
    pvx: number,
    pvz: number,
    siren?: { x: number; z: number; vx: number; vz: number },
  ) {
    if (!this.ctx) return;

    // --- 6-speed gearbox + engine pitch
    const ratio = clamp(Math.abs(speed) / spec.topSpeed, 0, 1.2);
    const newGear = Math.min(6, Math.max(1, Math.floor(ratio * 5.6) + 1));
    if (newGear !== this.gear) {
      this.gear = newGear;
      this.shiftMute = 0.08;
    }
    this.shiftMute = Math.max(0, this.shiftMute - dt);
    const gMin = (this.gear - 1) / 6;
    const gMax = this.gear / 6;
    const rpm = clamp((ratio - gMin) / (gMax - gMin) * 0.72 + 0.28 + throttle * 0.1, 0.22, 1.15);
    const f = spec.engineBase * (0.9 + rpm * 3.1);
    const detune = spec.engineTone === 'v8' ? 1.505 : spec.engineTone === 'v12' ? 2.01 : 1.008;
    this.engOsc1.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
    this.engOsc2.frequency.setTargetAtTime(f * detune, this.ctx.currentTime, 0.02);
    this.engSub.frequency.setTargetAtTime(f * 0.5, this.ctx.currentTime, 0.02);
    this.engFilter.frequency.setTargetAtTime(280 + rpm * 1400 + throttle * 900, this.ctx.currentTime, 0.03);
    const eVol = this.shiftMute > 0 ? 0.04 : 0.11 + throttle * 0.09 + rpm * 0.05;
    this.engGain.gain.setTargetAtTime(eVol, this.ctx.currentTime, 0.02);

    // --- Screech & nitro
    const sc = clamp((slip - 2.6) / 9, 0, 1) * clamp(Math.abs(speed) / 8, 0, 1);
    this.screechGain.gain.setTargetAtTime(sc * 0.22, this.ctx.currentTime, 0.03);
    this.nitroGain.gain.setTargetAtTime(nitro ? 0.22 : 0, this.ctx.currentTime, 0.04);

    // --- 3D Police siren with Doppler
    if (siren) {
      const dx = siren.x - px;
      const dz = siren.z - pz;
      const d = Math.max(1, Math.hypot(dx, dz));
      const att = clamp(1 - d / 160, 0, 1);
      // radial closing speed
      const rvx = siren.vx - pvx;
      const rvz = siren.vz - pvz;
      const closing = -(dx * rvx + dz * rvz) / d;
      const doppler = clamp(1 + closing / 340, 0.85, 1.18);
      this.sirenPhase += dt * (stars >= 3 ? 3.8 : 1.4); // yelp at high stars, wail at low
      const lfo = Math.sin(this.sirenPhase * Math.PI * 2);
      this.sirenOsc.frequency.setTargetAtTime((780 + lfo * 320) * doppler, this.ctx.currentTime, 0.02);
      this.sirenPan.pan.setTargetAtTime(clamp(((dx * camRightX + dz * camRightZ) / d) * 0.9, -1, 1), this.ctx.currentTime, 0.04);
      this.sirenGain.gain.setTargetAtTime(att * att * 0.16, this.ctx.currentTime, 0.04);
    } else {
      this.sirenGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    }

    // --- Synthwave sequencer (16th notes @ 122 BPM -> 0.123 s)
    this.stepTimer += dt;
    if (this.stepTimer >= 0.123) {
      this.stepTimer -= 0.123;
      if (this.musicVolume > 0.005 && this.masterVolume > 0.005) {
        this.musicStep(this.stepIdx++, stars);
      }
    }
  }

  private musicStep(step: number, stars: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const s = step % 16;
    // Kick on 0, 4, 8, 12
    if (s % 4 === 0) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(125, t);
      o.frequency.exponentialRampToValueAtTime(36, t + 0.11);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g).connect(this.musicGain);
      o.start(t);
      o.stop(t + 0.15);
    }
    // Snare on 4, 12
    if (s === 4 || s === 12) this.noiseShot(0.11, 1400, 0.25, this.musicGain);
    // Hi-hat (16ths when wanted, 8ths when cruising)
    if (stars > 0 || s % 2 === 0) this.noiseShot(0.03, 7000, 0.08, this.musicGain);
    // Driving bassline (A minor -> F -> G -> E)
    const roots = [55, 43.65, 49, 41.2];
    const bar = Math.floor(step / 16) % 4;
    const root = roots[bar] * (s % 2 === 1 && stars >= 2 ? 2 : 1);
    const bo = ctx.createOscillator();
    bo.type = 'sawtooth';
    bo.frequency.setValueAtTime(root, t);
    const bf = ctx.createBiquadFilter();
    bf.type = 'lowpass';
    bf.frequency.setValueAtTime(300 + stars * 180, t);
    bf.frequency.exponentialRampToValueAtTime(110, t + 0.11);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.28, t);
    bg.gain.exponentialRampToValueAtTime(0.01, t + 0.11);
    bo.connect(bf).connect(bg).connect(this.musicGain);
    bo.start(t);
    bo.stop(t + 0.12);
    // High-heat arpeggio lead
    if (stars >= 1 && s % 2 === 0) {
      const arp = [220, 261.6, 329.6, 392, 440, 392, 329.6, 261.6];
      const lo = ctx.createOscillator();
      lo.type = 'square';
      lo.frequency.setValueAtTime(arp[(s / 2 + bar) % arp.length] * (stars >= 4 ? 2 : 1), t);
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0.07 + stars * 0.015, t);
      lg.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
      lo.connect(lg).connect(this.musicGain);
      lo.start(t);
      lo.stop(t + 0.12);
    }
  }

  private noiseShot(dur: number, freq: number, vol: number, dest: AudioNode) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random(), dur);
  }

  crash(intensity01: number) {
    if (!this.ctx || this.masterVolume <= 0.001 || this.sfxVolume <= 0.001) return;
    const v = clamp(intensity01, 0.15, 1);
    this.noiseShot(0.22 + v * 0.25, 450, v * 0.55, this.sfxGain);
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.2);
    g.gain.setValueAtTime(v * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(this.sfxGain);
    o.start(t);
    o.stop(t + 0.23);
  }

  horn() {
    this.tone(340, 0.22, 'sawtooth', 0.15, this.vehicleGain);
    this.tone(425, 0.22, 'sawtooth', 0.15, this.vehicleGain);
  }

  beep(freq = 660, dur = 0.07) {
    this.tone(freq, dur, 'square', 0.12, this.sfxGain);
  }

  stinger(up: boolean) {
    const notes = up ? [330, 440, 554, 660] : [440, 392, 330, 220];
    notes.forEach((n, i) => setTimeout(() => this.tone(n, 0.16, 'sawtooth', 0.16, this.sfxGain), i * 90));
  }

  /** Quick throttle rev preview when adjusting vehicle sound setting. */
  previewVehicle() {
    if (!this.ctx || this.masterVolume <= 0.001 || this.vehicleVolume <= 0.001) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(65, t);
    o.frequency.exponentialRampToValueAtTime(185, t + 0.12);
    o.frequency.exponentialRampToValueAtTime(80, t + 0.28);
    f.type = 'lowpass';
    f.frequency.setValueAtTime(450, t);
    f.frequency.exponentialRampToValueAtTime(1250, t + 0.12);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.28);
    g.gain.setValueAtTime(0.24, t);
    g.gain.exponentialRampToValueAtTime(0.01, t + 0.28);
    o.connect(f).connect(g).connect(this.vehicleGain);
    o.start(t);
    o.stop(t + 0.3);
  }

  /** Quick synth chime preview when adjusting soundtrack setting. */
  previewSoundtrack() {
    this.tone(330, 0.12, 'square', 0.1, this.musicGain);
    setTimeout(() => this.tone(440, 0.14, 'square', 0.12, this.musicGain), 70);
  }

  /** Quick preview beep when adjusting master or SFX setting. */
  previewSfx() {
    this.tone(700, 0.09, 'sawtooth', 0.15, this.sfxGain);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, dest: GainNode = this.sfxGain) {
    if (!this.ctx || this.masterVolume <= 0.001) return;
    if (dest === this.vehicleGain && this.vehicleVolume <= 0.001) return;
    if (dest === this.sfxGain && this.sfxVolume <= 0.001) return;
    if (dest === this.musicGain && this.musicVolume <= 0.001) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.01);
  }
}
