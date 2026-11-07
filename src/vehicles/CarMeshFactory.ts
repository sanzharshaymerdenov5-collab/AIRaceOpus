import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BodyStyle, VehicleSpec } from './carSpecs';
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

export interface HeliRig {
  root: THREE.Group;
  body: THREE.Group;
  rotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  strobe: THREE.Object3D;
}

// ---------------------------------------------------------------------------------------------
// Shared materials & procedural textures (created lazily: canvases need a DOM)
// ---------------------------------------------------------------------------------------------

let _env: THREE.CubeTexture | null = null;
/** Tiny procedural night-city cube map used for fake paint/chrome/glass reflections. */
function envMap(): THREE.CubeTexture {
  if (_env) return _env;
  const S = 64;
  const face = (kind: 'side' | 'top' | 'bottom', seed: number) => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    if (kind === 'top') {
      const gr = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S * 0.7);
      gr.addColorStop(0, '#2a3a66');
      gr.addColorStop(1, '#0a0f22');
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
    } else if (kind === 'bottom') {
      g.fillStyle = '#0c0c10';
      g.fillRect(0, 0, S, S);
    } else {
      const gr = g.createLinearGradient(0, 0, 0, S);
      gr.addColorStop(0, '#0d1430');
      gr.addColorStop(0.5, '#3a3550');
      gr.addColorStop(0.56, '#c9a070');
      gr.addColorStop(0.62, '#1a1a22');
      gr.addColorStop(1, '#0a0a0e');
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
      // distant neon / windows
      let s = seed * 7919;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const neon = ['#ff2a6d', '#05d9e8', '#fffb00', '#ffd27a', '#bfe6ff'];
      for (let k = 0; k < 26; k++) {
        g.fillStyle = neon[Math.floor(rnd() * neon.length)];
        g.globalAlpha = 0.5 + rnd() * 0.5;
        g.fillRect(rnd() * S, S * 0.28 + rnd() * S * 0.26, 1 + rnd() * 3, 1 + rnd() * 2);
      }
      g.globalAlpha = 1;
    }
    return c;
  };
  _env = new THREE.CubeTexture([face('side', 1), face('side', 2), face('top', 0), face('bottom', 0), face('side', 3), face('side', 4)]);
  _env.colorSpace = THREE.SRGBColorSpace;
  _env.needsUpdate = true;
  return _env;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, nearest = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (nearest) t.magFilter = THREE.NearestFilter;
  return t;
}

interface SharedMats {
  tire: THREE.Material;
  rim: THREE.Material;
  steel: THREE.Material;
  dark: THREE.Material;
  trim: THREE.Material;
  chrome: THREE.Material;
  glass: THREE.Material;
  head: THREE.Material;
  reverse: THREE.Material;
  amber: THREE.Material;
  plate: THREE.Material;
  policeDecal: THREE.Material;
  checker: THREE.Material;
  taxiSign: THREE.Material;
  caliperRed: THREE.Material;
  caliperGrey: THREE.Material;
}
let _mats: SharedMats | null = null;
function mats(): SharedMats {
  if (_mats) return _mats;
  const env = envMap();
  const plateTex = canvasTex(128, 32, (g) => {
    g.fillStyle = '#e9e6d6';
    g.fillRect(0, 0, 128, 32);
    g.strokeStyle = '#1a2a55';
    g.lineWidth = 3;
    g.strokeRect(2, 2, 124, 28);
    g.fillStyle = '#1a2a55';
    g.font = 'bold 20px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('ND·2077', 64, 17);
  });
  const policeTex = canvasTex(512, 128, (g) => {
    g.fillStyle = '#f4f6fa';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#0e1d4a';
    g.fillRect(0, 92, 512, 14);
    g.fillStyle = '#c8102e';
    g.fillRect(0, 106, 512, 6);
    g.fillStyle = '#0e1d4a';
    g.font = 'bold 62px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('POLICE', 290, 50);
    // star badge
    g.save();
    g.translate(70, 50);
    g.fillStyle = '#d4a017';
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 15 : 34;
      const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
    g.fill();
    g.restore();
  });
  const checkerTex = canvasTex(
    128,
    16,
    (g) => {
      for (let i = 0; i < 16; i++)
        for (let j = 0; j < 2; j++) {
          g.fillStyle = (i + j) % 2 ? '#111' : '#f2f2f2';
          g.fillRect(i * 8, j * 8, 8, 8);
        }
    },
    true,
  );
  _mats = {
    tire: lambert({ color: 0x131315, side: THREE.DoubleSide }),
    rim: phong({ color: 0xc9ced6, shininess: 110, specular: 0x999999, envMap: env, combine: THREE.MixOperation, reflectivity: 0.55 }),
    steel: phong({ color: 0x24262b, shininess: 50, specular: 0x444444, envMap: env, combine: THREE.MixOperation, reflectivity: 0.15 }),
    dark: lambert({ color: 0x17181c }),
    trim: phong({ color: 0x0d0e11, shininess: 60, specular: 0x333333 }),
    chrome: phong({ color: 0xe6e9ef, shininess: 140, specular: 0xffffff, envMap: env, combine: THREE.MixOperation, reflectivity: 0.85 }),
    glass: phong({ color: 0x0d1724, emissive: 0x050b14, shininess: 160, specular: 0xbbd4ff, envMap: env, combine: THREE.MixOperation, reflectivity: 0.45, side: THREE.DoubleSide }),
    head: glowMat(0xfff6d8),
    reverse: lambert({ color: 0xd8d8d8, emissive: 0x2a2a2a }),
    amber: basic({ color: 0xc87810, toneMapped: false }),
    plate: lambert({ map: plateTex }),
    policeDecal: phong({ map: policeTex, shininess: 70, specular: 0x444444, polygonOffset: true, polygonOffsetFactor: -2 }),
    checker: lambert({ map: checkerTex, polygonOffset: true, polygonOffsetFactor: -2 }),
    taxiSign: glowMat(0xffe066),
    caliperRed: lambert({ color: 0xc81e1e }),
    caliperGrey: lambert({ color: 0x55585e }),
  };
  return _mats;
}

// ---------------------------------------------------------------------------------------------
// Body profiles (side silhouette parameters). Heights are fractions of spec.height, z of spec.length.
// ---------------------------------------------------------------------------------------------

interface Profile {
  gc: number; // ground clearance (m)
  nose: number; // front fascia top
  beltF: number; // hood height at the cowl
  beltR: number; // deck height at the base of the rear glass
  tail: number; // rear fascia top
  cowl: number; // windshield base z
  roofF: number; // roof front z
  roofR: number; // roof rear z
  deck: number; // rear glass base z
  cabW: number; // greenhouse width / body width
  tumble: number; // greenhouse top width scale
  wheelR: number;
  wheelW: number;
  wheelZ: number; // axle z (± fraction of length)
  spokes: number; // 0 = steel wheel with hubcap
  windows: 1 | 2 | 3;
  archTrim?: boolean;
}

const SEDAN: Profile = { gc: 0.2, nose: 0.5, beltF: 0.6, beltR: 0.63, tail: 0.62, cowl: 0.17, roofF: 0.04, roofR: -0.2, deck: -0.32, cabW: 0.84, tumble: 0.82, wheelR: 0.33, wheelW: 0.24, wheelZ: 0.31, spokes: 0, windows: 2 };
const SUV: Profile = { gc: 0.3, nose: 0.5, beltF: 0.56, beltR: 0.58, tail: 0.58, cowl: 0.24, roofF: 0.14, roofR: -0.44, deck: -0.48, cabW: 0.9, tumble: 0.9, wheelR: 0.4, wheelW: 0.3, wheelZ: 0.31, spokes: 6, windows: 2, archTrim: true };

const PROFILES: Record<BodyStyle, Profile> = {
  sports: { gc: 0.17, nose: 0.47, beltF: 0.58, beltR: 0.62, tail: 0.6, cowl: 0.14, roofF: -0.04, roofR: -0.2, deck: -0.38, cabW: 0.8, tumble: 0.78, wheelR: 0.32, wheelW: 0.28, wheelZ: 0.32, spokes: 5, windows: 1 },
  super: { gc: 0.13, nose: 0.5, beltF: 0.66, beltR: 0.7, tail: 0.66, cowl: 0.22, roofF: 0.04, roofR: -0.12, deck: -0.36, cabW: 0.74, tumble: 0.76, wheelR: 0.32, wheelW: 0.3, wheelZ: 0.33, spokes: 10, windows: 1 },
  tuner: { gc: 0.15, nose: 0.48, beltF: 0.58, beltR: 0.62, tail: 0.62, cowl: 0.16, roofF: 0.0, roofR: -0.24, deck: -0.39, cabW: 0.82, tumble: 0.8, wheelR: 0.31, wheelW: 0.26, wheelZ: 0.32, spokes: 6, windows: 1 },
  muscle: { gc: 0.18, nose: 0.52, beltF: 0.6, beltR: 0.62, tail: 0.62, cowl: 0.08, roofF: -0.08, roofR: -0.24, deck: -0.35, cabW: 0.8, tumble: 0.82, wheelR: 0.34, wheelW: 0.3, wheelZ: 0.31, spokes: 5, windows: 1, archTrim: true },
  sedan: SEDAN,
  taxi: SEDAN,
  police: SEDAN,
  hatch: { ...SEDAN, cowl: 0.2, roofF: 0.06, roofR: -0.38, deck: -0.47, wheelZ: 0.32 },
  suv: SUV,
  policeSuv: { ...SUV, spokes: 0 },
  van: { gc: 0.22, nose: 0.4, beltF: 0.44, beltR: 0.45, tail: 0.45, cowl: 0.36, roofF: 0.25, roofR: -0.48, deck: -0.49, cabW: 0.94, tumble: 0.95, wheelR: 0.35, wheelW: 0.25, wheelZ: 0.33, spokes: 0, windows: 3 },
  pickup: { gc: 0.3, nose: 0.52, beltF: 0.56, beltR: 0.57, tail: 0.57, cowl: 0.22, roofF: 0.12, roofR: -0.08, deck: -0.12, cabW: 0.9, tumble: 0.9, wheelR: 0.38, wheelW: 0.3, wheelZ: 0.32, spokes: 6, windows: 2, archTrim: true },
};

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

type Slot =
  | 'paint'
  | 'paint2'
  | 'glass'
  | 'dark'
  | 'trim'
  | 'chrome'
  | 'head'
  | 'brake'
  | 'reverse'
  | 'amber'
  | 'plate'
  | 'policeDecal'
  | 'checker'
  | 'taxiSign'
  | 'red'
  | 'blue';

type V2 = [number, number];

const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

/** Collects parts per material slot, then merges each slot into a single geometry. */
class PartBag {
  readonly parts = new Map<Slot, THREE.BufferGeometry[]>();

  add(slot: Slot, geo: THREE.BufferGeometry) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    g.clearGroups();
    let list = this.parts.get(slot);
    if (!list) this.parts.set(slot, (list = []));
    list.push(g);
  }

  box(slot: Slot, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx || ry || rz) g.applyMatrix4(_m.makeRotationFromEuler(_e.set(rx, ry, rz)));
    g.translate(x, y, z);
    this.add(slot, g);
  }

  /** Box at +x and its mirror at -x. */
  pair(slot: Slot, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
    this.box(slot, w, h, d, x, y, z, rx, ry, rz);
    this.box(slot, w, h, d, -x, y, z, rx, -ry, -rz);
  }

  cyl(slot: Slot, rt: number, rb: number, len: number, seg: number, axis: 'x' | 'y' | 'z', x: number, y: number, z: number) {
    const g = new THREE.CylinderGeometry(rt, rb, len, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.add(slot, g);
  }

  build(): Map<Slot, THREE.BufferGeometry> {
    const out = new Map<Slot, THREE.BufferGeometry>();
    for (const [slot, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      if (merged) {
        merged.computeBoundingSphere();
        out.set(slot, merged);
      }
    }
    return out;
  }
}

/** Two-triangle quad with flat normal (used for windshields, decals). */
function quadGeo(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3) {
  const g = new THREE.BufferGeometry();
  const pos = [p0, p1, p2, p0, p2, p3].flatMap((p) => [p.x, p.y, p.z]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  g.computeVertexNormals();
  return g;
}

/** Extrude a side-profile polygon (z, y) across the car width, centred on x = 0. */
function extrudeProfile(pts: V2[], width: number, bevel = 0) {
  const s = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = width - bevel * 2;
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 2,
    steps: 1,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2); // shape x -> world +z, extrusion -> world x
  return g;
}

/** Narrow the greenhouse towards the roof (tumblehome). */
function tumblehome(g: THREE.BufferGeometry, yBase: number, yTop: number, k: number) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.clamp((p.getY(i) - yBase) / (yTop - yBase), 0, 1);
    p.setX(i, p.getX(i) * (1 - (1 - k) * t));
  }
  g.computeVertexNormals();
}

/** Inset a convex polygon by d. */
function insetPoly(pts: V2[], d: number): V2[] {
  const n = pts.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area += x0 * y1 - x1 * y0;
  }
  const sgn = area > 0 ? 1 : -1;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const dx = (q[0] - p[0]) / len;
    const dy = (q[1] - p[1]) / len;
    const nx = -dy * sgn;
    const ny = dx * sgn;
    return { px: p[0] + nx * d, py: p[1] + ny * d, dx, dy };
  });
  return lines.map((l1, i) => {
    const l0 = lines[(i + n - 1) % n];
    const den = l0.dx * l1.dy - l0.dy * l1.dx;
    if (Math.abs(den) < 1e-6) return [l1.px, l1.py] as V2;
    const t = ((l1.px - l0.px) * l1.dy - (l1.py - l0.py) * l1.dx) / den;
    return [l0.px + l0.dx * t, l0.py + l0.dy * t] as V2;
  });
}

/** Clip a polygon to zMin <= z <= zMax (Sutherland-Hodgman). */
function clipZ(pts: V2[], zMin: number, zMax: number): V2[] {
  const clip = (poly: V2[], inside: (p: V2) => boolean, edge: number) => {
    const out: V2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (edge - a[0]) / (b[0] - a[0]);
        out.push([edge, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  let p = clip(pts, (q) => q[0] >= zMin, zMin);
  if (p.length) p = clip(p, (q) => q[0] <= zMax, zMax);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------------------------

interface WheelGeo {
  tire: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  caliper: THREE.BufferGeometry | null;
}
const wheelCache = new Map<string, WheelGeo>();

/** Lathe-turned tyre with sidewall bulge + spoked or steel rim. Axle along +X (outer face at +X). */
function wheelGeo(r: number, w: number, spokes: number): WheelGeo {
  const key = `${r}|${w}|${spokes}`;
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const h = w / 2;
  const rimR = r * 0.64;
  const prof = [
    new THREE.Vector2(0.02, -h + 0.02),
    new THREE.Vector2(r * 0.55, -h),
    new THREE.Vector2(r - 0.05, -h),
    new THREE.Vector2(r - 0.012, -h + 0.03),
    new THREE.Vector2(r, -h + 0.07),
    new THREE.Vector2(r, h - 0.07),
    new THREE.Vector2(r - 0.012, h - 0.03),
    new THREE.Vector2(r - 0.05, h),
    new THREE.Vector2(rimR + 0.02, h),
    new THREE.Vector2(rimR, h - 0.05),
  ];
  const tireParts: THREE.BufferGeometry[] = [new THREE.LatheGeometry(prof, 22).rotateZ(-Math.PI / 2)];
  // dark barrel + brake rotor behind the spokes
  tireParts.push(new THREE.CylinderGeometry(rimR - 0.005, rimR - 0.005, 0.02, 18).rotateZ(Math.PI / 2).translate(h - 0.12, 0, 0));
  const rimParts: THREE.BufferGeometry[] = [];
  rimParts.push(new THREE.TorusGeometry(rimR, 0.022, 6, 22).rotateY(Math.PI / 2).translate(h - 0.03, 0, 0));
  if (spokes > 0) {
    const sw = spokes >= 10 ? 0.035 : spokes >= 6 ? 0.07 : 0.09;
    for (let k = 0; k < spokes; k++) {
      rimParts.push(
        new THREE.BoxGeometry(0.035, rimR * 0.92, sw)
          .translate(0, rimR * 0.48, 0)
          .rotateX((k / spokes) * Math.PI * 2)
          .translate(h - 0.045, 0, 0),
      );
    }
    rimParts.push(new THREE.CylinderGeometry(0.075, 0.085, 0.05, 12).rotateZ(Math.PI / 2).translate(h - 0.04, 0, 0));
  } else {
    // steel wheel: dished disc + hubcap + lug nuts
    rimParts.push(new THREE.CylinderGeometry(rimR * 0.98, rimR * 0.98, 0.03, 20).rotateZ(Math.PI / 2).translate(h - 0.07, 0, 0));
    rimParts.push(new THREE.CylinderGeometry(rimR * 0.5, rimR * 0.58, 0.05, 16).rotateZ(Math.PI / 2).translate(h - 0.04, 0, 0));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      rimParts.push(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 6).rotateZ(Math.PI / 2).translate(h - 0.015, Math.cos(a) * rimR * 0.32, Math.sin(a) * rimR * 0.32));
    }
  }
  const norm = (list: THREE.BufferGeometry[]) =>
    mergeGeometries(
      list.map((g) => {
        const n = g.index ? g.toNonIndexed() : g;
        for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') n.deleteAttribute(name);
        n.clearGroups();
        return n;
      }),
      false,
    )!;
  const res: WheelGeo = {
    tire: norm(tireParts),
    rim: norm(rimParts),
    caliper: spokes > 0 ? new THREE.BoxGeometry(0.06, 0.15, 0.12).translate(h - 0.1, 0.04, -rimR * 0.62) : null,
  };
  wheelCache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Body construction (cached per vehicle model)
// ---------------------------------------------------------------------------------------------

interface BodyCache {
  geos: Map<Slot, THREE.BufferGeometry>;
  hoodGeo: THREE.BufferGeometry;
  hoodPivot: THREE.Vector3;
  hoodTilt: number;
  P: Profile;
  wheelX: number;
  wheelZ: number;
  lightbarZ: number;
  lightbarY: number;
}
const bodyCache = new Map<string, BodyCache>();

function buildBody(spec: VehicleSpec): BodyCache {
  const key = `${spec.id}|${spec.style}|${spec.width}|${spec.length}|${spec.height}`;
  const hit = bodyCache.get(key);
  if (hit) return hit;

  const st = spec.style;
  const P = PROFILES[st];
  const isCop = st === 'police' || st === 'policeSuv';
  const W = spec.width;
  const L = spec.length;
  const H = spec.height;
  const F = L / 2;
  const R = -L / 2;
  const gc = P.gc;
  const wr = P.wheelR;
  const wz = P.wheelZ * L;
  const archR = wr + 0.055;
  const archTop = wr + archR;
  const yN = P.nose * H;
  const yBF = P.beltF * H;
  const yBR = P.beltR * H;
  const yT = P.tail * H;
  const zC = P.cowl * L;
  const zRF = P.roofF * L;
  const zRR = P.roofR * L;
  const zD = P.deck * L;
  const BEV = 0.05;
  const SKIN = BEV * 0.8; // outward growth of the bevelled outline
  const FX = F + SKIN;
  const RX = R - SKIN;
  const bag = new PartBag();

  // --- Top silhouette line (front -> rear)
  let top: V2[] = [
    [F, yN],
    [F - 0.18, Math.min(yBF, yN + 0.08)],
    [zC, yBF],
    [zD, yBR],
    [R + 0.24, yT],
    [R, yT - 0.07],
  ];
  // keep strictly decreasing z
  top = top.filter((p, i) => i === 0 || p[0] < top[i - 1][0] - 0.03 || i === top.length - 1);
  const topY = (z: number) => {
    for (let i = 0; i < top.length - 1; i++) {
      const [z0, y0] = top[i];
      const [z1, y1] = top[i + 1];
      if (z <= z0 && z >= z1) return y0 + ((z - z0) / (z1 - z0 || 1)) * (y1 - y0);
    }
    return top[top.length - 1][1];
  };
  // Fender humps if the wheel arch would poke through the hood/deck line
  const extra: V2[] = [];
  for (const zc of [wz, -wz])
    for (const dz of [archR * 0.85, 0, -archR * 0.85]) {
      const z = zc + dz;
      if (topY(z) < archTop + 0.03) extra.push([z, archTop + 0.03]);
    }
  if (extra.length) top = [...top, ...extra].sort((a, b) => b[0] - a[0]);

  // --- Lower body: side profile with wheel-arch cut-outs
  const side: V2[] = [[R + 0.1, gc]];
  for (const zc of [-wz, wz]) {
    side.push([zc - archR, gc], [zc - archR, wr]);
    for (let k = 1; k <= 10; k++) {
      const a = Math.PI * (1 - k / 10);
      side.push([zc + archR * Math.cos(a), wr + archR * Math.sin(a)]);
    }
    side.push([zc + archR, gc]);
  }
  side.push([F - 0.1, gc], [F, gc + 0.12], [F + 0.015, (gc + yN) / 2]);
  side.push(...top);
  side.push([R - 0.015, (gc + yT) / 2], [R, gc + 0.12]);
  bag.add('paint', extrudeProfile(side, W, BEV));

  // Underbody / wheel-well liners so arches don't show daylight through the car
  const lowTop = Math.min(yBF, yBR, yT) - 0.12;
  bag.box('dark', W - 0.36, lowTop - gc, L * 0.9, 0, (lowTop + gc) / 2, 0);

  // --- Greenhouse
  const cabD = W * P.cabW;
  const A: V2 = [zC + 0.02, yBF - 0.02];
  const B: V2 = [zRF, H];
  const C: V2 = [zRR, H];
  const D: V2 = [zD - 0.02, yBR - 0.02];
  const towards = (p: V2, q: V2, d: number): V2 => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [p[0] + ((q[0] - p[0]) / len) * d, p[1] + ((q[1] - p[1]) / len) * d];
  };
  const cabPts: V2[] = [A, towards(B, A, 0.1), towards(B, C, 0.1), towards(C, B, 0.1), towards(C, D, 0.1), D];
  const yBase = Math.min(A[1], D[1]);
  const tumble = (y: number) => 1 - (1 - P.tumble) * THREE.MathUtils.clamp((y - yBase) / (H - yBase), 0, 1);
  const cab = extrudeProfile(cabPts, cabD);
  tumblehome(cab, yBase, H, P.tumble);
  bag.add(isCop ? 'paint2' : 'paint', cab);

  // Side glass (split by pillars)
  const glassPoly = insetPoly([A, B, C, D], 0.065);
  const windows: V2[][] = [];
  if (P.windows === 1) windows.push(glassPoly);
  else {
    const n = P.windows;
    const z0 = Math.min(zRR, zD);
    const z1 = Math.max(zRF, zC);
    for (let k = 0; k < n; k++) {
      const a = z0 + ((z1 - z0) * k) / n;
      const b = z0 + ((z1 - z0) * (k + 1)) / n;
      windows.push(clipZ(glassPoly, k === 0 ? -99 : a + 0.05, k === n - 1 ? 99 : b - 0.05));
    }
  }
  for (const w of windows) {
    if (w.length < 3) continue;
    const g = extrudeProfile(w, cabD + 0.02);
    tumblehome(g, yBase, H, P.tumble);
    bag.add('glass', g);
  }
  // Windshield + rear glass sit on the sloped faces
  const slopeGlass = (p: V2, q: V2) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dz = (q[0] - p[0]) / len;
    const dy = (q[1] - p[1]) / len;
    const nz = dy;
    const ny = -dz;
    const a: V2 = [p[0] + dz * 0.07 + nz * 0.012, p[1] + dy * 0.07 + ny * 0.012];
    const b: V2 = [q[0] - dz * 0.07 + nz * 0.012, q[1] - dy * 0.07 + ny * 0.012];
    const ha = (cabD / 2 - 0.07) * tumble(a[1]);
    const hb = (cabD / 2 - 0.07) * tumble(b[1]);
    bag.add(
      'glass',
      quadGeo(new THREE.Vector3(-ha, a[1], a[0]), new THREE.Vector3(ha, a[1], a[0]), new THREE.Vector3(hb, b[1], b[0]), new THREE.Vector3(-hb, b[1], b[0])),
    );
  };
  slopeGlass(A, B);
  slopeGlass(C, D);

  // --- Front end
  const faceH = yN - gc - 0.12;
  bag.box('trim', W * 0.94, 0.1, 0.12, 0, gc + 0.07, F - 0.01); // lower lip
  const grilleH = Math.max(0.07, faceH * 0.45);
  const grilleY = gc + 0.14 + faceH * 0.42;
  const grilleW = st === 'super' || st === 'sports' ? W * 0.62 : W * 0.46;
  bag.box('trim', grilleW, grilleH, 0.04, 0, grilleY, FX - 0.005);
  if (st === 'sedan' || st === 'taxi' || st === 'police' || st === 'suv' || st === 'policeSuv' || st === 'pickup' || st === 'van') {
    for (let k = -1; k <= 1; k++) bag.box('chrome', grilleW * 0.96, 0.014, 0.02, 0, grilleY + k * grilleH * 0.28, FX + 0.018);
    bag.box('chrome', grilleW + 0.04, grilleH + 0.04, 0.012, 0, grilleY, FX - 0.012);
  }
  const headY = yN - 0.075;
  const headW = st === 'super' || st === 'sports' || st === 'tuner' ? W * 0.2 : W * 0.22;
  bag.pair('trim', headW + 0.04, 0.13, 0.04, W * 0.34, headY, FX - 0.008);
  bag.pair('head', headW, 0.085, 0.03, W * 0.34, headY, FX + 0.01);
  bag.pair('chrome', 0.05, 0.05, 0.02, W * 0.34 - headW * 0.22, headY, FX + 0.025); // projector
  bag.pair('amber', 0.07, 0.05, 0.03, W * 0.47, headY - 0.02, FX - 0.02);
  if (st !== 'super' && st !== 'sports') bag.pair('head', 0.09, 0.05, 0.02, W * 0.36, gc + 0.16, FX + 0.0); // fog lights
  bag.box('plate', 0.5, 0.11, 0.02, 0, gc + 0.27, FX + 0.012);
  if (st === 'super' || st === 'sports' || st === 'tuner') {
    bag.pair('trim', W * 0.18, faceH * 0.35, 0.03, W * 0.3, gc + 0.12 + faceH * 0.2, FX - 0.01); // side intakes
    bag.box('trim', W * 0.9, 0.025, 0.18, 0, gc + 0.02, F + 0.05); // splitter
  }

  // --- Rear end
  const tailLY = yT - 0.13;
  bag.pair('trim', W * 0.3, 0.15, 0.03, W * 0.32, tailLY, RX + 0.005);
  bag.pair('brake', W * 0.27, 0.11, 0.03, W * 0.32, tailLY, RX - 0.008);
  bag.pair('reverse', 0.1, 0.05, 0.02, W * 0.2, tailLY - 0.02, RX - 0.012);
  if (st === 'super' || st === 'sports' || st === 'tuner') bag.box('brake', W * 0.36, 0.035, 0.02, 0, tailLY + 0.03, RX - 0.008);
  bag.box('trim', W * 0.95, 0.13, 0.12, 0, gc + 0.08, R + 0.01); // bumper
  bag.box('plate', 0.5, 0.11, 0.02, 0, Math.max(gc + 0.3, (gc + tailLY) / 2), RX - 0.012);
  const pipeY = gc + 0.07;
  if (st === 'super') {
    for (const x of [-0.12, 0.12]) bag.cyl('chrome', 0.055, 0.06, 0.16, 12, 'z', x, pipeY + 0.04, R - 0.02);
    for (let k = -2; k <= 2; k++) bag.box('trim', 0.02, 0.1, 0.32, k * W * 0.12, gc + 0.03, R + 0.14); // diffuser fins
  } else if (st === 'sports' || st === 'muscle') {
    for (const s of [-1, 1]) for (const o of [0, 0.13]) bag.cyl('chrome', 0.045, 0.05, 0.16, 10, 'z', s * (W * 0.3 + o), pipeY, R - 0.02);
  } else if (st === 'tuner') {
    bag.cyl('chrome', 0.075, 0.08, 0.2, 12, 'z', W * 0.3, pipeY, R - 0.03);
  } else if (st !== 'van') {
    bag.cyl('chrome', 0.04, 0.045, 0.14, 8, 'z', W * 0.3, pipeY, R - 0.02);
  }

  // --- Sides: mirrors, door seams, handles, skirts
  const archY = (z: number) => {
    for (const zc of [wz, -wz]) {
      const dz = z - zc;
      if (Math.abs(dz) < archR + 0.04) return wr + Math.sqrt(Math.max(0, (archR + 0.04) ** 2 - dz * dz)) + 0.04;
    }
    return gc + 0.12;
  };
  const sx = W / 2 + 0.004;
  const seam = (z: number) => {
    const y0 = archY(z);
    const y1 = topY(z) - 0.05;
    if (y1 - y0 > 0.1) bag.pair('trim', 0.012, y1 - y0, 0.012, sx, (y0 + y1) / 2, z);
  };
  const midZ = (zRF + zRR) / 2;
  seam(zC - 0.04);
  if (P.windows >= 2) {
    seam(midZ);
    seam(Math.max(zD + 0.08, -wz + archR + 0.08));
  } else seam(midZ - 0.15);
  if (P.windows === 3) seam(zRR + (zRF - zRR) * 0.33);
  const handleY = Math.min(yBF, yBR) - 0.1;
  bag.pair('chrome', 0.03, 0.03, 0.13, W / 2 + 0.012, handleY, zC - 0.28);
  if (P.windows >= 2) bag.pair('chrome', 0.03, 0.03, 0.13, W / 2 + 0.012, handleY, midZ - 0.28);
  const skirtL = 2 * wz - 2 * archR - 0.12;
  if (skirtL > 0.2) bag.pair('trim', 0.05, 0.09, skirtL, W / 2 - 0.005, gc + 0.03, 0);
  // Mirrors
  const mx = cabD / 2 + 0.11;
  const my = yBF + 0.1;
  const mz = zC - 0.14;
  bag.pair('trim', 0.12, 0.03, 0.05, cabD / 2 + 0.04, my - 0.03, mz);
  bag.pair(isCop ? 'paint' : 'paint', 0.11, 0.1, 0.17, mx, my, mz, 0, 0.12);
  bag.pair('glass', 0.09, 0.075, 0.01, mx, my, mz - 0.09, 0, 0.12);
  // Wheel-arch flares
  if (P.archTrim) {
    for (const zc of [wz, -wz])
      for (const s of [-1, 1]) {
        const t = new THREE.TorusGeometry(archR + 0.015, 0.04, 4, 14, Math.PI).rotateY(Math.PI / 2).translate(s * (W / 2 - 0.015), wr, zc);
        bag.add('trim', t);
      }
  }

  // --- Style specific details
  if (st === 'sports' || st === 'tuner' || st === 'super') {
    const wingY = yT + (st === 'tuner' ? 0.34 : st === 'super' ? 0.1 : 0.14);
    const wingZ = R + 0.28;
    const wingSlot: Slot = st === 'sports' ? 'paint' : 'trim';
    bag.box(wingSlot, W * 0.92, 0.035, 0.3, 0, wingY, wingZ, -0.1);
    bag.pair('trim', 0.02, 0.15, 0.34, W * 0.46, wingY - 0.03, wingZ);
    const standH = wingY - yT + 0.04;
    bag.pair('trim', 0.04, standH, 0.08, W * 0.28, yT + standH / 2 - 0.04, wingZ + 0.02);
  }
  if (st === 'muscle') {
    const sz = zC + (F - zC) * 0.4;
    const sy = topY(sz) + SKIN;
    bag.box('trim', W * 0.32, 0.12, L * 0.2, 0, sy + 0.05, sz);
    bag.box('chrome', W * 0.26, 0.05, 0.08, 0, sy + 0.12, sz + L * 0.08);
    // twin racing stripes over hood/roof/deck
    const stripe = (z0: number, z1: number, y0: number, y1: number, h = 0.006) => {
      const len = Math.hypot(z1 - z0, y1 - y0);
      const ang = Math.atan2(y1 - y0, z0 - z1);
      for (const x of [-0.17, 0.17]) bag.box('paint2', 0.16, h, len, x, (y0 + y1) / 2 + 0.012, (z0 + z1) / 2, ang);
    };
    stripe(F - 0.18, zC, topY(F - 0.18) + SKIN, yBF + SKIN);
    stripe(zD, R + 0.24, yBR + SKIN, yT + SKIN);
  }
  if (st === 'suv' || st === 'policeSuv') {
    const rw = (cabD / 2) * P.tumble - 0.08;
    bag.pair('trim', 0.05, 0.05, (zRF - zRR) * 0.85, rw, H + 0.04, (zRF + zRR) / 2);
    bag.pair('trim', 0.04, 0.06, 0.04, rw, H + 0.015, zRF - 0.15);
    bag.pair('trim', 0.04, 0.06, 0.04, rw, H + 0.015, zRR + 0.15);
    // spare wheel
    bag.cyl('trim', 0.34, 0.34, 0.22, 16, 'z', 0, (gc + yT) / 2 + 0.12, R - 0.13);
    bag.cyl('chrome', 0.12, 0.12, 0.24, 10, 'z', 0, (gc + yT) / 2 + 0.12, R - 0.13);
    // bull bar
    bag.pair('trim', 0.06, 0.45, 0.06, W * 0.25, gc + 0.3, FX + 0.12);
    bag.box('trim', W * 0.62, 0.06, 0.06, 0, gc + 0.5, FX + 0.12);
    bag.box('trim', W * 0.62, 0.06, 0.06, 0, gc + 0.2, FX + 0.12);
  }
  if (st === 'van') {
    const rw = (cabD / 2) * P.tumble - 0.12;
    bag.pair('trim', 0.05, 0.05, (zRF - zRR) * 0.9, rw, H + 0.08, (zRF + zRR) / 2);
    for (let k = 0; k < 4; k++) bag.box('trim', rw * 2 + 0.05, 0.04, 0.05, 0, H + 0.08, zRR + 0.2 + ((zRF - zRR - 0.4) * k) / 3);
    bag.box('trim', 0.015, yT - gc - 0.2, 0.012, 0, (yT + gc) / 2 + 0.05, RX - 0.004); // rear door split
    bag.box('trim', W * 0.9, 0.03, 0.12, 0, (yT + gc) / 2, RX - 0.01); // step
  }
  if (st === 'pickup') {
    const bedF = zD - 0.06;
    const bedLen = bedF - R;
    const bedZ = (bedF + R) / 2;
    bag.box('trim', W - 0.2, 0.02, bedLen - 0.1, 0, yBR + SKIN + 0.012, bedZ); // tonneau/bed floor
    bag.pair('paint', 0.09, 0.1, bedLen, W / 2 - 0.045, yBR + SKIN + 0.05, bedZ);
    bag.box('paint', W, 0.1, 0.09, 0, yBR + SKIN + 0.05, R + 0.045);
    bag.box('paint', W, 0.1, 0.09, 0, yBR + SKIN + 0.05, bedF);
    bag.box('chrome', W * 0.96, 0.13, 0.13, 0, gc + 0.09, R - 0.01);
  }
  if (st === 'taxi') {
    bag.box('trim', 0.82, 0.05, 0.4, 0, H + 0.025, midZ);
    bag.box('taxiSign', 0.74, 0.22, 0.32, 0, H + 0.16, midZ);
    for (const s of [-1, 1]) {
      const zs = 0.05;
      const len = L * 0.62;
      const y = Math.min(yBF, yBR) - 0.13;
      const g = new THREE.PlaneGeometry(len, 0.09).rotateY((s * Math.PI) / 2).translate(s * (W / 2 + 0.006), y, zs);
      bag.add('checker', g);
    }
  }
  if (isCop) {
    // Door livery panels between the wheel arches
    const z0 = -(wz - archR) + 0.06;
    const z1 = Math.min(zC - 0.03, wz - archR - 0.05);
    const y0 = gc + 0.14;
    const y1 = Math.min(yBF, yBR) - 0.04;
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(z1 - z0, y1 - y0).rotateY((s * Math.PI) / 2).translate(s * (W / 2 + 0.006), (y0 + y1) / 2, (z0 + z1) / 2);
      bag.add('policeDecal', g);
    }
    // Push bar
    if (st === 'police') {
      bag.pair('trim', 0.06, 0.38, 0.06, W * 0.2, gc + 0.3, FX + 0.11);
      bag.box('trim', W * 0.5, 0.05, 0.06, 0, gc + 0.45, FX + 0.11);
      bag.box('trim', W * 0.5, 0.05, 0.06, 0, gc + 0.2, FX + 0.11);
    }
    // A-pillar spotlight + antenna
    bag.cyl('chrome', 0.05, 0.05, 0.14, 10, 'z', -(cabD / 2 + 0.04), yBF + 0.16, zC - 0.06);
    bag.cyl('trim', 0.006, 0.01, 0.6, 4, 'y', W * 0.3, yBR + 0.32, R + 0.35);
  }

  // --- Hood panel (separate pivot so damage can pop it)
  const hoodFrontZ = F - 0.2;
  const hl = hoodFrontZ - zC;
  let yC = topY(zC);
  let yF = topY(hoodFrontZ);
  let lift = 0;
  for (let k = 0; k <= 6; k++) {
    const z = zC + (hl * k) / 6;
    const lineY = yC + ((yF - yC) * k) / 6;
    lift = Math.max(lift, topY(z) - lineY);
  }
  yC += lift + SKIN + 0.012;
  yF += lift + SKIN + 0.012;
  const hoodLen = Math.hypot(hl, yC - yF);
  const hoodGeo = new THREE.BoxGeometry(W * 0.78, 0.025, hoodLen).translate(0, 0, hoodLen / 2);
  const hoodTilt = Math.atan2(yC - yF, hl);

  const res: BodyCache = {
    geos: bag.build(),
    hoodGeo,
    hoodPivot: new THREE.Vector3(0, yC, zC + 0.03),
    hoodTilt,
    P,
    wheelX: W / 2 - P.wheelW / 2 - 0.03,
    wheelZ: wz,
    lightbarZ: midZ + 0.05,
    lightbarY: H,
  };
  bodyCache.set(key, res);
  return res;
}

/** Build a detailed car from cached, per-material merged geometry. +Z is forward. */
export function buildCarMesh(spec: VehicleSpec, color: number, isPlayer = false): CarRig {
  const M = mats();
  const env = envMap();
  const cache = buildBody(spec);
  const P = cache.P;
  const st = spec.style;
  const isCop = st === 'police' || st === 'policeSuv';
  const W = spec.width;
  const L = spec.length;

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const paint = phong({ color, shininess: 90, specular: 0x666666, envMap: env, combine: THREE.MixOperation, reflectivity: 0.22 });
  const paint2 = phong({ color, shininess: 90, specular: 0x666666, envMap: env, combine: THREE.MixOperation, reflectivity: 0.22 });
  const paintMats = [paint, paint2];
  if (isCop) paint.color.set(0x111318), paint2.color.set(0xf2f4f8);
  if (st === 'muscle') paint2.color.set(0xf4f4f4); // racing stripes
  const brakeMat = basic({ color: 0x990000, toneMapped: false });
  const red = glowMat(0xff1020);
  const blue = glowMat(0x1060ff);

  const slotMat: Record<Slot, THREE.Material> = {
    paint,
    paint2,
    glass: M.glass,
    dark: M.dark,
    trim: M.trim,
    chrome: M.chrome,
    head: M.head,
    brake: brakeMat,
    reverse: M.reverse,
    amber: M.amber,
    plate: M.plate,
    policeDecal: M.policeDecal,
    checker: M.checker,
    taxiSign: M.taxiSign,
    red,
    blue,
  };
  for (const [slot, geo] of cache.geos) body.add(new THREE.Mesh(geo, slotMat[slot]));

  // Blob shadow on the road
  const sh = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.35, L * 1.25).rotateX(-Math.PI / 2),
    basic({ map: shadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }),
  );
  sh.position.y = 0.03;
  root.add(sh);

  // Hood (damage pivot)
  const hood = new THREE.Group();
  hood.position.copy(cache.hoodPivot);
  const hoodMesh = new THREE.Mesh(cache.hoodGeo, isCop ? paint : paint2);
  hoodMesh.rotation.x = cache.hoodTilt;
  hood.add(hoodMesh);
  body.add(hood);

  if (st === 'tuner' && isPlayer) {
    const ug = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.4, L * 1.1).rotateX(-Math.PI / 2), lightPoolMat(0x00ffd5, 0.55));
    ug.position.y = 0.05;
    root.add(ug);
  }

  // Ground headlight cone pool
  const hPool = new THREE.Mesh(new THREE.PlaneGeometry(W * 2.6, 12).rotateX(-Math.PI / 2), lightPoolMat(0xfff0c2, isPlayer ? 0.55 : 0.28));
  hPool.position.set(0, 0.04, L * 0.5 + 5.5);
  root.add(hPool);

  // Police lightbar (per-car materials so each car can flash independently)
  let lightbar: CarRig['lightbar'];
  if (isCop) {
    const lb = new THREE.Group();
    lb.position.set(0, cache.lightbarY, cache.lightbarZ);
    const bw = W * P.cabW * P.tumble * 0.88;
    const base = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.06, 0.3), M.trim);
    base.position.y = 0.03;
    lb.add(base);
    const seg = (bw / 2 - 0.1) / 2;
    for (let k = 0; k < 2; k++) {
      const x = 0.08 + seg * (k + 0.5);
      for (const [s, m] of [
        [-1, red],
        [1, blue],
      ] as const) {
        const lens = new THREE.Mesh(new THREE.BoxGeometry(seg - 0.02, 0.1, 0.26), m);
        lens.position.set(s * x, 0.11, 0);
        lb.add(lens);
      }
    }
    const mid = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 0.24), M.chrome);
    mid.position.y = 0.105;
    const takedown = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.02), M.head);
    takedown.position.set(0, 0.105, 0.125);
    lb.add(mid, takedown);
    for (const s of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.2), M.trim);
      foot.position.set(s * bw * 0.4, 0.0, 0);
      lb.add(foot);
    }
    body.add(lb);
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
    const fGeo = new THREE.ConeGeometry(0.16, 0.9, 8).rotateX(-Math.PI / 2);
    const fMat = basic({ color: 0x33ccff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, toneMapped: false });
    for (const fx of [-W * 0.3, W * 0.3]) {
      const f = new THREE.Mesh(fGeo, fMat);
      f.position.set(fx, P.gc + 0.07, -L * 0.5 - 0.5);
      f.visible = false;
      body.add(f);
      nitroFlames.push(f);
    }
  }

  // 4 wheels (left wheels mirrored so the rim face always points outward)
  const wg = wheelGeo(P.wheelR, P.wheelW, P.spokes);
  const rimMat = isCop ? M.steel : P.spokes > 0 ? M.rim : M.rim;
  const caliperMat = isPlayer || st === 'super' || st === 'sports' ? M.caliperRed : M.caliperGrey;
  const wheels: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  const wx = cache.wheelX;
  const wz = cache.wheelZ;
  const positions: [number, number, boolean][] = [
    [-wx, wz, true],
    [wx, wz, true],
    [-wx, -wz, false],
    [wx, -wz, false],
  ];
  for (const [x, z, front] of positions) {
    const piv = new THREE.Group();
    piv.position.set(x, P.wheelR, z);
    if (x < 0) piv.scale.x = -1;
    const w = new THREE.Group();
    w.add(new THREE.Mesh(wg.tire, M.tire), new THREE.Mesh(wg.rim, rimMat));
    piv.add(w);
    if (wg.caliper) piv.add(new THREE.Mesh(wg.caliper, caliperMat));
    root.add(piv);
    wheels.push(w);
    if (front) frontPivots.push(piv);
  }

  return { root, body, wheels, frontPivots, paintMats, brakeMat, lightbar, nitroFlames, hood };
}

export function setCarColor(rig: CarRig, hex: number) {
  rig.paintMats[0].color.setHex(hex);
  // paint2 doubles as racing-stripe colour on muscle cars; keep it white there
  if (!rig.paintMats[1].color.equals(new THREE.Color(0xf4f4f4))) rig.paintMats[1].color.setHex(hex);
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

// ---------------------------------------------------------------------------------------------
// Police helicopter
// ---------------------------------------------------------------------------------------------

/** Detailed police helicopter (~11 m long). Nose is +Z; main rotor spins about Y, tail rotor about X. */
export function buildHeliMesh(): HeliRig {
  const M = mats();
  const env = envMap();
  const navy = phong({ color: 0x15244a, shininess: 80, specular: 0x555555, envMap: env, combine: THREE.MixOperation, reflectivity: 0.2 });
  const white = phong({ color: 0xeef1f6, shininess: 80, specular: 0x555555, envMap: env, combine: THREE.MixOperation, reflectivity: 0.2 });
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  // Fuselage: navy upper, white belly
  add(new THREE.SphereGeometry(1, 20, 14).scale(1.2, 1.1, 2.3), navy, 0, 0, 0);
  add(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45).scale(1.22, 1.12, 2.32), white, 0, 0, 0);
  // Cockpit glazing
  add(new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1.02, 0.95, 1.25).rotateX(Math.PI * 0.42), M.glass, 0, 0.12, 1.15);
  // Engine housing + mast
  add(new THREE.BoxGeometry(1.0, 0.5, 1.8), navy, 0, 1.0, -0.4);
  add(new THREE.CylinderGeometry(0.09, 0.12, 0.45, 10), M.trim, 0, 1.45, 0);
  // Tail boom, fin, stabiliser
  add(new THREE.CylinderGeometry(0.2, 0.42, 4.4, 12).rotateX(Math.PI / 2), navy, 0, 0.35, -3.9);
  add(new THREE.BoxGeometry(0.08, 1.3, 0.85).rotateX(-0.25), navy, 0, 0.95, -5.9);
  add(new THREE.BoxGeometry(1.7, 0.06, 0.45), navy, 0, 0.42, -5.2);
  // Skids
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.06, 0.06, 3.8, 8).rotateX(Math.PI / 2), M.trim, s * 1.0, -1.35, 0.1);
    for (const z of [-0.8, 0.9]) {
      const strut = add(new THREE.BoxGeometry(0.07, 0.62, 0.07), M.trim, s * 0.88, -1.05, z);
      strut.rotation.z = s * 0.28;
    }
  }
  // Searchlight under the nose
  add(new THREE.CylinderGeometry(0.16, 0.2, 0.28, 12).rotateX(Math.PI / 2), M.chrome, 0, -0.95, 1.5);
  add(new THREE.CircleGeometry(0.15, 12), M.head, 0, -0.95, 1.645);
  // POLICE side decals
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(1.8, 0.45).rotateY((s * Math.PI) / 2);
    add(g, M.policeDecal, s * 1.205, -0.15, -0.3);
  }
  // Nav lights
  add(new THREE.SphereGeometry(0.07, 6, 4), glowMat(0xff2020), -1.2, 0.05, 0.2);
  add(new THREE.SphereGeometry(0.07, 6, 4), glowMat(0x20ff40), 1.2, 0.05, 0.2);
  const strobe = add(new THREE.SphereGeometry(0.09, 6, 4), glowMat(0xffffff), 0, 1.65, -5.95);

  // Main rotor (4 blades) + faint motion disc
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.72, 0);
  for (let k = 0; k < 4; k++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 5.3).translate(0, 0, 2.7), M.trim);
    blade.rotation.y = (k * Math.PI) / 2;
    rotor.add(blade);
  }
  rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 10), M.chrome));
  body.add(rotor);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(5.6, 32).rotateX(-Math.PI / 2),
    basic({ color: 0x9aa4b8, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.position.y = 1.72;
  body.add(disc);

  // Tail rotor
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.12, 1.0, -6.0);
  tailRotor.add(new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.3, 0.12), M.trim), new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 1.3), M.trim));
  body.add(tailRotor);

  return { root, body, rotor, tailRotor, strobe };
}
