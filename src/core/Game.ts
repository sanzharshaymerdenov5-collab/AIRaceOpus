import * as THREE from 'three';
import { CITY, generateCity, type CityLayout } from '../city/CityLayout';
import { CityBuilder } from '../city/CityBuilder';
import { PropManager } from '../city/Props';
import { lightState } from '../city/TrafficLights';
import { EventBus, type CrimeType } from './events';
import { Loop } from './Loop';
import { G, PhysicsWorld } from '../physics/PhysicsWorld';
import { ArcadeVehicle } from '../physics/ArcadeVehicle';
import { PLAYER_CARS } from '../vehicles/carSpecs';
import { animateCarRig, buildCarMesh, setCarColor, type CarRig } from '../vehicles/CarMeshFactory';
import { RenderPipeline } from '../render/RenderPipeline';
import { createSky, FOG_COLOR } from '../render/Sky';
import { ParticleSystem } from '../render/Particles';
import { ChaseCamera } from '../render/ChaseCamera';
import { InputManager } from '../input/InputManager';
import { TrafficSystem, type TrafficUnit } from '../ai/TrafficSystem';
import { PoliceSystem } from '../ai/PoliceSystem';
import { HeatSystem } from '../gameplay/HeatSystem';
import { JobSystem } from '../gameplay/JobSystem';
import { loadSave, writeSave, type SaveData } from '../gameplay/Save';
import { AudioEngine } from '../audio/AudioEngine';
import { HUD } from '../ui/HUD';
import { Menus } from '../ui/Menus';

export type GameState = 'title' | 'garage' | 'roam' | 'paused' | 'splash';

const CRIME_LABELS: Record<CrimeType, string> = {
  speeding: 'SPEEDING',
  redLight: 'RAN RED LIGHT',
  reckless: 'RECKLESS DRIVING',
  hitAndRun: 'HIT & RUN',
  propertyDamage: 'PROPERTY DAMAGE',
  rammingCop: 'ASSAULT ON POLICE',
  evading: 'FELONY EVASION',
};

export class Game {
  readonly bus = new EventBus();
  readonly save: SaveData = loadSave();
  readonly input = new InputManager();
  readonly audio = new AudioEngine();
  readonly scene = new THREE.Scene();
  readonly pipeline: RenderPipeline;
  readonly phys = new PhysicsWorld();
  readonly layout: CityLayout;
  readonly city: CityBuilder;
  readonly props: PropManager;
  readonly particles = new ParticleSystem();
  readonly traffic: TrafficSystem;
  readonly police: PoliceSystem;
  readonly heat: HeatSystem;
  readonly jobs: JobSystem;
  readonly chaseCam = new ChaseCamera();
  readonly hud: HUD;
  readonly menus: Menus;
  readonly loop: Loop;

  state: GameState = 'title';
  time = 0;
  player!: ArcadeVehicle;
  playerRig!: CarRig;
  health = 100;
  private sky: THREE.Group;

  // Crime detection timers
  private speedCrimeCd = 0;
  private recklessAcc = 0;
  private lastIntersection = -1;
  private collisionCd = 0;
  private driftScoreAcc = 0;
  private flippedFor = 0;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.pipeline = new RenderPipeline(canvas, this.save.retro);
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, this.save.retro.fogDensity);

    // Night lighting: cool moonlight + warm street bounce hemisphere + player headlight spot
    this.scene.add(new THREE.HemisphereLight(0x4460a8, 0x2c2218, 0.85));
    const moon = new THREE.DirectionalLight(0x9bb8ff, 0.75);
    moon.position.set(-120, 220, -160);
    this.scene.add(moon);
    this.sky = createSky();
    this.scene.add(this.sky);

    this.layout = generateCity(1337);
    this.city = new CityBuilder(this.layout, this.phys);
    this.props = new PropManager(this.layout.props, this.phys, this.bus);
    this.traffic = new TrafficSystem(this.layout, this.phys);
    this.traffic.targetCount = this.save.trafficDensity;
    this.police = new PoliceSystem(this.layout, this.phys);
    this.heat = new HeatSystem(this.bus);
    this.jobs = new JobSystem(this.layout, this.heat, this.bus, (x, z, c) => this.city.addBeacon(x, z, c));

    this.scene.add(this.city.group, this.props.group, this.traffic.group, this.police.group, this.jobs.group, this.particles.group);

    this.spawnPlayer(this.save.carId, this.save.colorIdx);
    this.hud = new HUD(uiRoot, this.layout);
    this.menus = new Menus(uiRoot, this.save, {
      onStartDrive: () => this.enterRoam(),
      onOpenGarage: () => this.enterGarage(),
      onSelectCar: (id, cIdx) => this.spawnPlayer(id, cIdx),
      onBuyCar: (def) => {
        if (this.save.cash < def.price) return false;
        this.save.cash -= def.price;
        if (!this.save.unlocked.includes(def.spec.id)) this.save.unlocked.push(def.spec.id);
        this.save.carId = def.spec.id;
        writeSave(this.save);
        this.audio.stinger(true);
        return true;
      },
      onResume: () => this.setState('roam'),
      onSettingsChanged: () => {
        this.pipeline.resize();
        (this.scene.fog as THREE.FogExp2).density = this.save.retro.fogDensity;
        this.traffic.targetCount = this.save.trafficDensity;
        this.audio.setVolumes(this.save.masterVolume, this.save.musicVolume, this.save.vehicleVolume, this.save.sfxVolume);
        writeSave(this.save);
      },
      onSplashContinue: () => {
        this.respawnPlayer();
        this.setState('roam');
      },
      onPreviewSound: (kind) => {
        if (kind === 'vehicle') this.audio.previewVehicle();
        else if (kind === 'soundtrack') this.audio.previewSoundtrack();
        else if (kind === 'master' || kind === 'sfx') this.audio.previewSfx();
      },
    });
    this.audio.setVolumes(this.save.masterVolume, this.save.musicVolume, this.save.vehicleVolume, this.save.sfxVolume);

    this.wireEvents();
    window.addEventListener('resize', () => this.pipeline.resize());
    window.addEventListener('pointerdown', () => this.audio.unlock(), { once: false });
    window.addEventListener('keydown', () => this.audio.unlock(), { once: false });

    this.setState('title');
    this.loop = new Loop((dt) => this.step(dt), (_, fdt) => this.render(fdt));
    this.loop.start();
  }

  private spawnPlayer(carId: string, colorIdx: number) {
    const def = PLAYER_CARS.find((c) => c.spec.id === carId) ?? PLAYER_CARS[0];
    const color = def.colors[colorIdx % def.colors.length];
    const pos = this.player ? { x: this.player.x, z: this.player.z, yaw: this.player.yaw } : this.layout.spawn;
    if (this.player) {
      this.scene.remove(this.playerRig.root);
      this.player.dispose();
    }
    this.player = new ArcadeVehicle(this.phys, def.spec, pos.x, pos.z, pos.yaw, G.PLAYER, { kind: 'player' });
    this.playerRig = buildCarMesh(def.spec, color, true);
    setCarColor(this.playerRig, color);
    this.playerRig.root.position.set(pos.x, 0, pos.z);
    this.playerRig.root.rotation.y = pos.yaw;
    const keyLight = new THREE.PointLight(0xffe6bf, 3.2, 11, 1.2);
    keyLight.position.set(0, 3.2, 0.6);
    this.playerRig.root.add(keyLight);
    this.scene.add(this.playerRig.root);
    this.heat.minorImmune = !!def.minorCrimeImmune;
    this.audio.setTone(def.spec);
    this.health = 100;
    this.chaseCam.snap(this.player);
  }

  private respawnPlayer() {
    const near = this.layout.graph.nearestLane(this.player.x, this.player.z);
    const l = near.lane;
    const x = l.sx + l.dx * (l.len * 0.5);
    const z = l.sz + l.dz * (l.len * 0.5);
    this.player.teleport(x, z, Math.atan2(l.dx, l.dz));
    this.player.spikedTime = 0;
    this.player.nitro = 1;
    this.health = 100;
    this.police.clearRoadblocks();
    this.chaseCam.snap(this.player);
  }

  private setState(s: GameState) {
    this.state = s;
    this.hud.root.style.display = s === 'roam' ? 'block' : 'none';
    if (s === 'title') (this.audio.muteContinuous(), this.menus.showTitle());
    else if (s === 'garage') (this.audio.muteContinuous(), this.menus.showGarage());
    else if (s === 'paused') (this.audio.muteContinuous(), this.menus.showPause());
    else if (s === 'roam') this.menus.hide();
  }

  enterRoam() {
    this.audio.unlock();
    if (!this.save.unlocked.includes(this.player.spec.id)) this.spawnPlayer(this.save.carId, this.save.colorIdx);
    writeSave(this.save);
    this.setState('roam');
    this.hud.banner('NEON DISTRICT', 'FREE ROAM — DRIVE RECKLESSLY OR FIND A BEACON', '#ffae00', 2.4);
  }

  enterGarage() {
    this.audio.unlock();
    this.heat.resetClean();
    this.jobs.finish(false);
    this.setState('garage');
  }

  private wireEvents() {
    this.bus.on('crime', ({ type, witnessed, heat }) => {
      if (witnessed && heat > 0) {
        const pv = this.player.body.linvel();
        this.police.reportSighting(this.player.x, this.player.z, pv.x, pv.z, this.time);
      }
      if (heat > 0) this.hud.toast(`+HEAT · ${CRIME_LABELS[type]}`, '#ff5566');
      else if (!witnessed && type !== 'propertyDamage') this.hud.toast(`${CRIME_LABELS[type]} (UNSEEN)`, '#7a8ea8');
    });
    this.bus.on('pursuitStarted', ({ stars }) => {
      const pv = this.player.body.linvel();
      this.police.reportSighting(this.player.x, this.player.z, pv.x, pv.z, this.time);
      this.hud.banner(`PURSUIT ★${stars}`, 'LOSE LINE OF SIGHT TO ESCAPE', '#ff2035', 2.4);
      this.audio.stinger(true);
    });
    this.bus.on('heatChanged', ({ stars }) => {
      if (stars >= 3) this.hud.toast(`WANTED LEVEL ★${stars} — ROADBLOCKS DEPLOYED`, '#ffae00');
    });
    this.bus.on('cooldownStarted', () => this.hud.toast('OUT OF SIGHT — COPS SEARCHING LAST KNOWN POS', '#20b8ff'));
    this.bus.on('spotted', () => this.hud.toast('SPOTTED BY POLICE!', '#ff2035'));
    this.bus.on('ticket', ({ fine }) => {
      const paid = Math.min(this.save.cash, fine);
      this.save.cash -= paid;
      writeSave(this.save);
      this.hud.banner('TICKETED', `PAID $${paid} FINE`, '#ffae00', 2);
    });
    this.bus.on('busted', ({ fine }) => {
      const paid = Math.min(this.save.cash, fine);
      this.save.cash -= paid;
      writeSave(this.save);
      this.pipeline.flash = 0.85;
      this.pipeline.flashColor.setHex(0xff1020);
      this.audio.stinger(false);
      this.setState('splash');
      this.menus.showSplash('BUSTED', `IMPOUND & FINES: -$${paid}`, '#ff2035');
    });
    this.bus.on('escaped', ({ bonus, heat }) => {
      this.save.cash += bonus;
      this.save.bestHeat = Math.max(this.save.bestHeat, heat);
      writeSave(this.save);
      this.hud.banner('ESCAPED!', `+$${bonus} BOUNTY BONUS`, '#39ff7a', 3);
      this.audio.stinger(true);
    });
    this.bus.on('propSmashed', ({ x, z }) => {
      this.particles.sparks(x, 0.8, z, 10);
      this.audio.crash(0.25);
      this.save.cash += 15;
      const wit = this.police.isWitnessed(this.player.x, this.player.z, this.props.cameras);
      this.heat.reportCrime('propertyDamage', wit);
    });
    this.bus.on('jobStarted', ({ name }) => {
      this.hud.banner(name, 'GO GO GO!', '#05d9e8', 2);
      this.audio.beep(880, 0.15);
    });
    this.bus.on('jobEnded', ({ name, success, reward }) => {
      if (success) {
        this.save.cash += reward;
        writeSave(this.save);
        this.hud.banner(`${name} COMPLETE`, `+$${reward}`, '#39ff7a', 2.8);
        this.audio.stinger(true);
      } else {
        this.hud.banner(`${name} FAILED`, 'TRY AGAIN AT ANY BEACON', '#ff2035', 2.4);
        this.audio.stinger(false);
      }
    });
    this.bus.on('message', ({ text, sub, color, time }) => this.hud.banner(text, sub ?? '', color ?? '#05d9e8', time ?? 1.8));
  }

  private step(dt: number) {
    this.time += dt;
    this.pipeline.flash = Math.max(0, this.pipeline.flash - dt * 2.2);

    // Global one-shot keys
    if (this.input.wasPressed('Escape')) {
      if (this.state === 'roam') this.setState('paused');
      else if (this.state === 'paused') this.setState('roam');
    }
    if (this.input.wasPressed('Enter')) {
      if (this.state === 'title') {
        this.enterRoam();
        this.input.endFrame();
        return;
      } else if (this.state === 'splash') {
        this.respawnPlayer();
        this.setState('roam');
        this.input.endFrame();
        return;
      }
    }

    if (this.state !== 'roam') {
      this.city.update(this.time);
      this.input.endFrame();
      return;
    }

    if (this.input.wasPressed('KeyC')) this.chaseCam.cycleMode();
    if (this.input.wasPressed('KeyH')) this.audio.horn();
    if (this.input.wasPressed('KeyR')) this.respawnPlayer();
    const startJob = this.input.wasPressed('KeyE') || this.input.wasPressed('Enter');

    this.player.input = this.input.drive(dt);
    this.player.update(dt);

    const camFwd = new THREE.Vector3();
    this.chaseCam.cam.getWorldDirection(camFwd);
    this.traffic.update(dt, this.time, this.player.x, this.player.z, camFwd.x, camFwd.z, this.police.nearestSiren);
    this.police.update(dt, this.time, this.player, this.heat);
    this.props.update(this.player.x, this.player.z, this.time);

    this.phys.step();
    this.handleCollisions(dt);
    this.detectContinuousCrimes(dt);

    // Self-righting / out-of-bounds guard
    if (Math.abs(this.player.x) > CITY.HALF + 60 || Math.abs(this.player.z) > CITY.HALF + 60) this.respawnPlayer();
    if (Math.abs(this.player.speed) < 0.5 && this.player.input.throttle > 0.5) {
      this.flippedFor += dt;
      if (this.flippedFor > 4) (this.respawnPlayer(), (this.flippedFor = 0));
    } else this.flippedFor = 0;

    // Drift cash drip + particles
    if (this.player.drifting) {
      this.particles.smoke(this.player.x - this.player.fwdX * 1.6, 0.2, this.player.z - this.player.fwdZ * 1.6);
      this.particles.skid(this.player.x - this.player.fwdX * 1.3, this.player.z - this.player.fwdZ * 1.3, this.player.yaw);
      this.driftScoreAcc += Math.abs(this.player.lateral) * dt;
      if (this.driftScoreAcc > 28) {
        this.driftScoreAcc = 0;
        this.save.cash += 25;
        this.hud.toast('+$25 DRIFT STYLE', '#05d9e8');
      }
    }
    if (this.health < 45 && Math.random() < 0.4) {
      this.particles.smoke(this.player.x + this.player.fwdX * 1.6, 0.9, this.player.z + this.player.fwdZ * 1.6, true);
    }

    this.heat.update(dt, {
      playerSpeed: Math.abs(this.player.speed),
      nearestCopDist: this.police.nearestDist,
      copSeesPlayer: this.police.anySees,
    });
    this.jobs.update(dt, this.time, this.player.x, this.player.z, startJob);
    this.city.update(this.time);
    this.particles.update(dt);

    // Visual sync for player
    this.playerRig.root.position.set(this.player.x, 0, this.player.z);
    this.playerRig.root.rotation.y = this.player.yaw;
    animateCarRig(
      this.playerRig,
      dt,
      this.player.speed,
      this.player.input.steer,
      this.player.input.brake > 0.1,
      this.player.nitroActive,
      false,
      1 - this.health / 100,
      this.time,
    );

    const lookBack = this.input.isDown('KeyB') || this.input.isDown('KeyV');
    this.chaseCam.update(dt, this.player, lookBack);
    this.sky.position.set(this.player.x, 0, this.player.z);
    const spFactor = Math.max(0, (Math.abs(this.player.speed) - 20) / 42);
    this.pipeline.speedBlur = Math.min(1.4, spFactor * 0.75 + (this.player.nitroActive ? 0.85 : 0));

    const pv = this.player.body.linvel();
    const rightX = Math.cos(this.chaseCam.cam.rotation.y);
    const rightZ = -Math.sin(this.chaseCam.cam.rotation.y);
    this.audio.update(
      dt,
      this.player.spec,
      this.player.speed,
      this.player.input.throttle,
      Math.abs(this.player.lateral),
      this.player.nitroActive,
      this.heat.stars,
      rightX,
      rightZ,
      this.player.x,
      this.player.z,
      pv.x,
      pv.z,
      this.police.nearestSiren,
    );

    this.hud.update(dt, this.time, this.player, this.health / 100, this.save.cash, this.heat, this.police, this.traffic.units, this.jobs, this.loop.fps);
    this.input.endFrame();
  }

  private handleCollisions(dt: number) {
    this.collisionCd = Math.max(0, this.collisionCd - dt);
    const pHandle = this.player.collider.handle;
    let hitKind: 'static' | 'traffic' | 'cop' | null = null;
    this.phys.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const other = h1 === pHandle ? h2 : h2 === pHandle ? h1 : -1;
      if (other < 0) return;
      const ent = this.phys.entity(other);
      if (!ent) return;
      if (ent.kind === 'traffic') {
        hitKind = 'traffic';
        this.traffic.notifyHit(ent.ref as TrafficUnit);
      } else if (ent.kind === 'cop') {
        hitKind = 'cop';
      } else if (ent.kind === 'static' && !hitKind) {
        hitKind = 'static';
      }
    });

    const dv = this.player.lastDeltaV;
    if ((hitKind || dv > 4.5) && this.collisionCd <= 0) {
      const sev = Math.max(dv, hitKind === 'cop' || hitKind === 'traffic' ? 6 : 0);
      if (sev < 3.5) return;
      this.collisionCd = 0.25;
      this.particles.sparks(this.player.x + this.player.fwdX * 1.8, 0.7, this.player.z + this.player.fwdZ * 1.8, 16);
      this.chaseCam.kick(Math.min(1, sev / 18));
      this.audio.crash(sev / 22);

      // Armor scaling: heavy SUV takes much less damage
      const armor = 1400 / this.player.spec.mass;
      this.health = Math.max(0, this.health - sev * 0.85 * armor);

      const wit = this.police.isWitnessed(this.player.x, this.player.z, this.props.cameras);
      if (hitKind === 'cop') this.heat.reportCrime('rammingCop', true);
      else if (hitKind === 'traffic' && Math.abs(this.player.speed) > 5.5) this.heat.reportCrime('hitAndRun', wit);

      if (this.health <= 0) {
        this.bus.emit('wrecked', {});
        if (this.heat.stars > 0) this.heat.bust();
        else {
          this.setState('splash');
          this.menus.showSplash('WRECKED', 'YOUR RIDE WAS TOTALLED', '#ff5533');
        }
      }
    }
  }

  private detectContinuousCrimes(dt: number) {
    const px = this.player.x;
    const pz = this.player.z;
    const sp = Math.abs(this.player.speed);
    const g = this.layout.graph;
    const near = g.nearestLane(px, pz, this.player.fwdX, this.player.fwdZ);

    // 1. Speeding (> limit * 1.4, witnessed by cop or speed camera)
    this.speedCrimeCd = Math.max(0, this.speedCrimeCd - dt);
    if (sp > near.lane.limit * 1.4 && this.speedCrimeCd <= 0) {
      const camWit = this.props.cameras.some((c) => Math.hypot(c.x - px, c.z - pz) < 34);
      const copWit = this.police.isWitnessed(px, pz, this.props.cameras, false);
      if (camWit || copWit) {
        this.speedCrimeCd = 6;
        if (camWit) {
          this.pipeline.flash = 0.55;
          this.pipeline.flashColor.setHex(0xffffff);
        }
        this.heat.reportCrime('speeding', true);
      }
    }

    // 2. Running a red light (entering a signalised intersection on red at speed)
    const inter = g.intersectionAt(px, pz);
    if (inter >= 0 && inter !== this.lastIntersection && sp > 6) {
      const I = g.intersections[inter];
      const axis = Math.abs(this.player.fwdX) > Math.abs(this.player.fwdZ) ? 'x' : 'z';
      if (lightState(I, axis, this.time) === 'red') {
        const wit = this.police.isWitnessed(px, pz, this.props.cameras, true);
        this.heat.reportCrime('redLight', wit);
      }
    }
    this.lastIntersection = inter;

    // 3. Reckless driving (wrong way or driving on sidewalks)
    const wrongWay = near.dist < CITY.ROAD / 2 && near.lane.dx * this.player.fwdX + near.lane.dz * this.player.fwdZ < -0.5 && sp > 8;
    const offRoad = !g.onRoad(px, pz) && sp > 8;
    if (wrongWay || offRoad) {
      this.recklessAcc += dt;
      if (this.recklessAcc >= 2.5) {
        this.recklessAcc = 0;
        const wit = this.police.isWitnessed(px, pz, this.props.cameras);
        this.heat.reportCrime('reckless', wit);
      }
    } else {
      this.recklessAcc = Math.max(0, this.recklessAcc - dt * 0.5);
    }
  }

  private render(frameDt: number) {
    if (this.state === 'title' || this.state === 'garage') {
      const a = this.time * (this.state === 'garage' ? 0.65 : 0.25);
      const r = this.state === 'garage' ? 5.2 : 10;
      const h = this.state === 'garage' ? 1.85 : 3.8;
      this.chaseCam.cam.aspect = window.innerWidth / Math.max(1, window.innerHeight);
      this.chaseCam.cam.fov = 50;
      this.chaseCam.cam.updateProjectionMatrix();
      this.chaseCam.cam.position.set(this.player.x + Math.cos(a) * r, h, this.player.z + Math.sin(a) * r);
      // In garage, pan look-at slightly to the car's left so the car appears on the right side of the screen
      const pan = this.state === 'garage' ? -1.4 : 0;
      this.chaseCam.cam.lookAt(this.player.x - Math.sin(a) * pan, 0.85, this.player.z + Math.cos(a) * pan);
      this.pipeline.speedBlur = 0;
    }
    this.pipeline.render(this.scene, this.chaseCam.cam);
  }
}
