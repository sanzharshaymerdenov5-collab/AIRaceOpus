import * as THREE from 'three';
import type { VehicleSpec } from './carSpecs';
import { basic, glowMat, lambert, lightPoolMat, phong, shadowTexture } from '../render/materials';

export interface CarRig {
  root: THREE.Group;
  body: THREE.Group; // pitches/rolls + shakes on damage
  wheels: THREE.Object3D[]; // 0=FL, 1=FR, 2=RL, 3=RR
  frontPivots: THREE.Object3D[]; // steer around Y
  paintMats: THREE.MeshPhongMaterial[];
  brakeMat: THREE.MeshBasicMaterial;
  lightbar?: { red: THREE.MeshBasicMaterial; blue: THREE.MeshBasicMaterial; poolRed: THREE.Mesh; poolBlue: THREE.Mesh };
  underglow?: THREE.Mesh;
  nitroFlames: THREE.Mesh[];
  hood: THREE.Object3D;
}

const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12).rotateZ(Math.PI / 2);
const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.27, 8).rotateZ(Math.PI / 2);
const tireMat = lambert({ color: 0x161618 });
const rimMat = lambert({ color: 0xc8ccd4 });
const darkMat = lambert({ color: 0x1a1c22 });
const chromeMat = phong({ color: 0xd8dce4, shininess: 90 });
const glassMat = phong({ color: 0x152232, emissive: 0x0a1522, shininess: 120 });
const headMat = glowMat(0xfff6d8);

function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/** Build a low-poly PS2-style car from primitives. +Z is forward. */
export function buildCarMesh(spec: VehicleSpec, color: number, isPlayer = false): CarRig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const W = spec.width;
  const L = spec.length;
  const H = spec.height;
  const paint = phong({ color, shininess: 75, specular: 0x555555 });
  const paint2 = phong({ color, shininess: 75, specular: 0x555555 });
  const paintMats = [paint, paint2];
  const st = spec.style;
  const isCop = st === 'police' || st === 'policeSuv';
  if (isCop) paint.color.set(0x111318), paint2.color.set(0xf2f4f8);

  // Blob shadow on the road
  const sh = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.35, L * 1.25).rotateX(-Math.PI / 2),
    basic({ map: shadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }),
  );
  sh.position.y = 0.03;
  root.add(sh);

  // Lower hull + bumpers
  const beltH = H * (st === 'van' ? 0.55 : st === 'suv' || st === 'policeSuv' || st === 'pickup' ? 0.48 : 0.42);
  const hullY = 0.28 + beltH / 2;
  body.add(box(W, beltH, L * 0.96, 0, hullY, 0, paint));
  // Front hood (separate pivot so damage can pop it up)
  const hood = new THREE.Group();
  hood.position.set(0, 0.28 + beltH, L * 0.12);
  const hoodMesh = box(W * 0.92, 0.08, L * 0.34, 0, 0.02, L * 0.16, isCop ? paint : paint2);
  hood.add(hoodMesh);
  body.add(hood);

  // Cabin / greenhouse (tapered box)
  const cabLen = st === 'van' ? L * 0.72 : st === 'pickup' ? L * 0.36 : st === 'super' ? L * 0.44 : L * 0.48;
  const cabZ = st === 'van' ? -L * 0.04 : st === 'pickup' ? L * 0.06 : st === 'muscle' ? -L * 0.06 : -L * 0.03;
  const cabH = H - beltH - 0.18;
  const cabGeo = new THREE.BoxGeometry(W * 0.86, cabH, cabLen);
  const cp = cabGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    if (cp.getY(i) > 0) {
      cp.setX(i, cp.getX(i) * 0.82);
      cp.setZ(i, cp.getZ(i) * (st === 'van' ? 0.92 : 0.72));
    }
  }
  cabGeo.computeVertexNormals();
  const cab = new THREE.Mesh(cabGeo, isCop ? paint2 : paint);
  cab.position.set(0, 0.28 + beltH + cabH / 2 - 0.02, cabZ);
  body.add(cab);

  // Windows band (slightly wider/longer slice inside the cabin)
  const winGeo = cabGeo.clone();
  winGeo.scale(1.01, 0.72, 1.01);
  const win = new THREE.Mesh(winGeo, glassMat);
  win.position.copy(cab.position);
  body.add(win);

  // Style-specific details
  if (st === 'pickup') body.add(box(W * 0.92, beltH * 0.35, L * 0.38, 0, 0.28 + beltH + 0.05, -L * 0.26, darkMat));
  if (st === 'muscle') body.add(box(W * 0.36, 0.14, L * 0.28, 0, 0.28 + beltH + 0.06, L * 0.24, darkMat)); // blower scoop
  if (st === 'sports' || st === 'tuner' || st === 'super') {
    const spY = 0.28 + beltH + 0.22;
    const spZ = -L * 0.44;
    body.add(box(W * 0.9, 0.06, 0.28, 0, spY, spZ, st === 'tuner' ? darkMat : paint));
    body.add(box(0.08, 0.22, 0.2, -W * 0.34, spY - 0.11, spZ, darkMat));
    body.add(box(0.08, 0.22, 0.2, W * 0.34, spY - 0.11, spZ, darkMat));
  }
  if (st === 'suv' || st === 'policeSuv') {
    // bullbar
    body.add(box(W * 0.7, 0.35, 0.12, 0, 0.48, L * 0.5, darkMat));
  }
  if (st === 'taxi') {
    const sign = box(0.7, 0.22, 0.32, 0, 0.28 + beltH + cabH + 0.08, cabZ, glowMat(0xffe066));
    body.add(sign);
  }
  if (st === 'tuner' && isPlayer) {
    const ug = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.4, L * 1.1).rotateX(-Math.PI / 2), lightPoolMat(0x00ffd5, 0.55));
    ug.position.y = 0.05;
    root.add(ug);
  }

  // Grille + bumpers + Lights
  body.add(box(W * 0.52, beltH * 0.45, 0.06, 0, hullY - 0.03, L * 0.485, darkMat));
  body.add(box(W * 0.98, 0.16, 0.18, 0, 0.28, L * 0.47, darkMat));
  body.add(box(W * 0.98, 0.18, 0.18, 0, 0.28, -L * 0.47, darkMat));
  body.add(box(W * 0.24, 0.14, 0.06, -W * 0.32, hullY + 0.05, L * 0.485, headMat));
  body.add(box(W * 0.24, 0.14, 0.06, W * 0.32, hullY + 0.05, L * 0.485, headMat));
  // Ground headlight cone pool
  const hPool = new THREE.Mesh(new THREE.PlaneGeometry(W * 2.6, 12).rotateX(-Math.PI / 2), lightPoolMat(0xfff0c2, isPlayer ? 0.55 : 0.28));
  hPool.position.set(0, 0.04, L * 0.5 + 5.5);
  root.add(hPool);

  const brakeMat = basic({ color: 0x990000, toneMapped: false });
  body.add(box(W * 0.26, 0.14, 0.06, -W * 0.32, hullY + 0.05, -L * 0.485, brakeMat));
  body.add(box(W * 0.26, 0.14, 0.06, W * 0.32, hullY + 0.05, -L * 0.485, brakeMat));

  // Police lightbar
  let lightbar: CarRig['lightbar'];
  if (isCop) {
    const topY = 0.28 + beltH + cabH + 0.06;
    const red = glowMat(0xff1020);
    const blue = glowMat(0x1060ff);
    body.add(box(0.45, 0.16, 0.28, -0.26, topY, cabZ, red));
    body.add(box(0.45, 0.16, 0.28, 0.26, topY, cabZ, blue));
    body.add(box(0.14, 0.14, 0.26, 0, topY, cabZ, chromeMat));
    // push bar on standard cruiser too
    body.add(box(W * 0.55, 0.32, 0.1, 0, 0.42, L * 0.5, darkMat));
    const poolRed = new THREE.Mesh(new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2), lightPoolMat(0xff1020, 0.6));
    const poolBlue = new THREE.Mesh(new THREE.PlaneGeometry(11, 11).rotateX(-Math.PI / 2), lightPoolMat(0x1060ff, 0.6));
    poolRed.position.set(-2.5, 0.05, 0);
    poolBlue.position.set(2.5, 0.05, 0);
    poolRed.visible = poolBlue.visible = false;
    root.add(poolRed, poolBlue);
    lightbar = { red, blue, poolRed, poolBlue };
  }

  // Nitro exhaust flames (player)
  const nitroFlames: THREE.Mesh[] = [];
  if (isPlayer) {
    const fGeo = new THREE.ConeGeometry(0.16, 0.9, 6).rotateX(-Math.PI / 2);
    const fMat = basic({ color: 0x33ccff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, toneMapped: false });
    for (const sx of [-0.45, 0.45]) {
      const f = new THREE.Mesh(fGeo, fMat);
      f.position.set(sx, 0.26, -L * 0.52);
      f.visible = false;
      body.add(f);
      nitroFlames.push(f);
    }
  }

  // 4 wheels
  const wheels: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  const wx = W * 0.46;
  const wz = L * 0.31;
  const positions: [number, number, boolean][] = [
    [-wx, wz, true],
    [wx, wz, true],
    [-wx, -wz, false],
    [wx, -wz, false],
  ];
  for (const [x, z, front] of positions) {
    const piv = new THREE.Group();
    piv.position.set(x, 0.34, z);
    const w = new THREE.Group();
    w.add(new THREE.Mesh(wheelGeo, tireMat), new THREE.Mesh(hubGeo, rimMat));
    piv.add(w);
    root.add(piv);
    wheels.push(w);
    if (front) frontPivots.push(piv);
  }

  return { root, body, wheels, frontPivots, paintMats, brakeMat, lightbar, nitroFlames, hood };
}

export function setCarColor(rig: CarRig, hex: number) {
  for (const m of rig.paintMats) m.color.setHex(hex);
}

/** Update wheels, body roll/pitch, brake glow, nitro flames, police flashers, damage look. */
export function animateCarRig(
  rig: CarRig,
  dt: number,
  speed: number,
  steer: number,
  braking: boolean,
  nitro: boolean,
  sirenOn: boolean,
  damage01: number,
  time: number,
) {
  const spin = (speed / 0.34) * dt;
  for (const w of rig.wheels) w.rotation.x += spin;
  for (const p of rig.frontPivots) p.rotation.y = -steer * 0.45;
  rig.body.rotation.z = THREE.MathUtils.lerp(rig.body.rotation.z, steer * Math.min(1, Math.abs(speed) / 20) * 0.06, 0.2);
  rig.body.rotation.x = THREE.MathUtils.lerp(rig.body.rotation.x, braking ? 0.03 : nitro ? -0.025 : 0, 0.2);
  rig.brakeMat.color.setHex(braking ? 0xff2211 : 0x660000);
  for (const f of rig.nitroFlames) {
    f.visible = nitro;
    if (nitro) f.scale.set(1, 1, 0.8 + Math.random() * 0.6);
  }
  if (rig.lightbar) {
    const on = sirenOn && Math.floor(time * 9) % 2 === 0;
    rig.lightbar.red.color.setHex(sirenOn ? (on ? 0xff2030 : 0x330008) : 0x330008);
    rig.lightbar.blue.color.setHex(sirenOn ? (!on ? 0x2080ff : 0x001033) : 0x001033);
    rig.lightbar.poolRed.visible = sirenOn && on;
    rig.lightbar.poolBlue.visible = sirenOn && !on;
  }
  rig.hood.rotation.x = -damage01 * 0.35;
}
