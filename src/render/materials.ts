import * as THREE from 'three';

/**
 * Shared material helpers. Every material is patched with an optional
 * "PS1 mode" vertex-snapping step driven by global uniforms.
 */
export const retroUniforms = {
  uSnap: { value: 0 },
  uSnapRes: { value: new THREE.Vector2(320, 224) },
};

export function patchRetro<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnap = retroUniforms.uSnap;
    shader.uniforms.uSnapRes = retroUniforms.uSnapRes;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uSnap;\nuniform vec2 uSnapRes;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        if (uSnap > 0.5) {
          vec2 snapped = floor((gl_Position.xy / gl_Position.w) * uSnapRes * 0.5 + 0.5) / (uSnapRes * 0.5);
          gl_Position.xy = snapped * gl_Position.w;
        }`,
      );
  };
  return mat;
}

export const lambert = (p: THREE.MeshLambertMaterialParameters) => patchRetro(new THREE.MeshLambertMaterial(p));
export const basic = (p: THREE.MeshBasicMaterialParameters) => patchRetro(new THREE.MeshBasicMaterial(p));
export const phong = (p: THREE.MeshPhongMaterialParameters) => patchRetro(new THREE.MeshPhongMaterial(p));

/** Emissive-looking unlit material (neon, lights) with additive bloom feel. */
export const glowMat = (color: THREE.ColorRepresentation) => basic({ color, toneMapped: false });

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function toTex(c: HTMLCanvasElement, repeat = true, nearest = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (nearest) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  t.anisotropy = 4;
  return t;
}

export type WallStyle = 'downtown' | 'suburbs' | 'industrial';

/** Procedural window façade: returns [albedo, emissive] textures. 16x16 windows per tile. */
export function makeWindowTextures(style: WallStyle, seed = 1): [THREE.Texture, THREE.Texture] {
  let s = seed * 9973;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const N = 256;
  const [ca, a] = canvas(N, N);
  const [ce, e] = canvas(N, N);
  const cols = style === 'industrial' ? 8 : 16;
  const rows = style === 'industrial' ? 6 : 16;
  const cw = N / cols;
  const rh = N / rows;
  a.fillStyle = style === 'downtown' ? '#4a5260' : style === 'suburbs' ? '#7d7466' : '#5b5a55';
  a.fillRect(0, 0, N, N);
  e.fillStyle = '#000';
  e.fillRect(0, 0, N, N);
  // subtle noise/grime
  for (let k = 0; k < 1800; k++) {
    const g = Math.floor(rnd() * 40);
    a.fillStyle = `rgba(${g},${g},${g},0.12)`;
    a.fillRect(rnd() * N, rnd() * N, 2, 2);
  }
  const litP = style === 'downtown' ? 0.42 : style === 'suburbs' ? 0.3 : 0.15;
  const warm = ['#ffd27a', '#ffc35a', '#ffe7b0'];
  const cool = ['#bfe6ff', '#9fd0ff', '#e6f4ff', '#7ff0ff'];
  for (let r = 0; r < rows; r++) {
    // whole floors sometimes dark (offices at night)
    const floorDark = rnd() < 0.18;
    for (let c = 0; c < cols; c++) {
      const pad = style === 'downtown' ? 2 : style === 'suburbs' ? 4 : 3;
      const x = c * cw + pad;
      const y = r * rh + pad;
      const w = cw - pad * 2;
      const h = rh - pad * (style === 'downtown' ? 1.5 : 2);
      if (style === 'industrial' && r > 1) continue; // only top-row windows on warehouses
      a.fillStyle = style === 'downtown' ? '#151a24' : '#1d1a18';
      a.fillRect(x, y, w, h);
      if (!floorDark && rnd() < litP) {
        const col = style === 'downtown' && rnd() < 0.6 ? cool[Math.floor(rnd() * cool.length)] : warm[Math.floor(rnd() * warm.length)];
        e.fillStyle = col;
        e.globalAlpha = 0.55 + rnd() * 0.45;
        e.fillRect(x, y, w, h);
        e.globalAlpha = 1;
        a.fillStyle = col;
        a.fillRect(x, y, w, h);
      }
    }
  }
  if (style === 'industrial') {
    // corrugated stripes + big door
    for (let x = 0; x < N; x += 6) {
      a.fillStyle = 'rgba(0,0,0,0.18)';
      a.fillRect(x, 0, 2, N);
    }
    a.fillStyle = '#3d3c38';
    a.fillRect(N * 0.35, N * 0.55, N * 0.3, N * 0.45);
  }
  return [toTex(ca), toTex(ce)];
}

export function makeAsphaltTexture(): THREE.Texture {
  const N = 256;
  const [c, g] = canvas(N, N);
  g.fillStyle = '#26272c';
  g.fillRect(0, 0, N, N);
  for (let k = 0; k < 6000; k++) {
    const v = 20 + Math.floor(Math.random() * 40);
    g.fillStyle = `rgb(${v},${v},${v + 4})`;
    g.fillRect(Math.random() * N, Math.random() * N, 1, 1);
  }
  for (let k = 0; k < 12; k++) {
    g.strokeStyle = 'rgba(10,10,12,0.5)';
    g.beginPath();
    let x = Math.random() * N;
    let y = Math.random() * N;
    g.moveTo(x, y);
    for (let s = 0; s < 6; s++) g.lineTo((x += (Math.random() - 0.5) * 30), (y += (Math.random() - 0.5) * 30));
    g.stroke();
  }
  return toTex(c);
}

export function makeConcreteTexture(base = '#77777a'): THREE.Texture {
  const N = 128;
  const [c, g] = canvas(N, N);
  g.fillStyle = base;
  g.fillRect(0, 0, N, N);
  for (let k = 0; k < 2000; k++) {
    const v = Math.floor(Math.random() * 30) - 15;
    g.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},0.15)`;
    g.fillRect(Math.random() * N, Math.random() * N, 2, 2);
  }
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1;
  for (let x = 0; x <= N; x += 32) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, N);
    g.stroke();
    g.beginPath();
    g.moveTo(0, x);
    g.lineTo(N, x);
    g.stroke();
  }
  return toTex(c);
}

/** Soft radial gradient used for light pools, glows and blob shadows. */
export function makeRadialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.Texture {
  const N = 64;
  const [c, g] = canvas(N, N);
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let _glowTex: THREE.Texture | null = null;
export const glowTexture = () => (_glowTex ??= makeRadialTexture());
let _shadowTex: THREE.Texture | null = null;
export const shadowTexture = () => (_shadowTex ??= makeRadialTexture('rgba(0,0,0,0.85)', 'rgba(0,0,0,0)'));

/** Additive ground light pool material. */
export function lightPoolMat(color: THREE.ColorRepresentation, opacity = 0.5) {
  return basic({
    map: glowTexture(),
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}
