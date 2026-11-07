import * as THREE from 'three';
import { retroUniforms } from './materials';

export interface RetroSettings {
  resHeight: number; // internal render height (448 = PS2 NTSC)
  dither: boolean;
  scanlines: boolean;
  bloom: boolean;
  ps1: boolean;
  fogDensity: number;
  motionBlur: number; // 0 (off) .. 2 (200% intense)
}

export const defaultRetro = (): RetroSettings => ({
  resHeight: 448,
  dither: true,
  scanlines: false,
  bloom: true,
  ps1: false,
  fogDensity: 0.0042,
  motionBlur: 1,
});

const fsQuadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const brightFrag = /* glsl */ `
uniform sampler2D tDiffuse; uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0);
}`;

const blurFrag = /* glsl */ `
uniform sampler2D tDiffuse; uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227;
  s += texture2D(tDiffuse, vUv + uDir * 1.385).rgb * 0.316;
  s += texture2D(tDiffuse, vUv - uDir * 1.385).rgb * 0.316;
  s += texture2D(tDiffuse, vUv + uDir * 3.231).rgb * 0.070;
  s += texture2D(tDiffuse, vUv - uDir * 3.231).rgb * 0.070;
  gl_FragColor = vec4(s, 1.0);
}`;

const compositeFrag = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform vec2 uRes; uniform float uDither; uniform float uScan; uniform float uBloom;
uniform float uFlash; uniform vec3 uFlashColor; uniform float uBlur; uniform float uTime;
varying vec2 vUv;
float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0)); int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  float m[16];
  m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;
  m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
  for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0 - 0.5;
  return 0.0;
}
vec3 toSRGB(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
void main() {
  vec2 uv = vUv;
  vec3 c = texture2D(tScene, uv).rgb;
  // PS2-style edge-weighted radial motion blur (keeps car centre sharp)
  if (uBlur > 0.001) {
    vec2 rel = uv - 0.5;
    float edge = smoothstep(0.08, 0.62, length(rel));
    vec2 d = rel * edge * uBlur * 0.032;
    for (int k = 1; k < 8; k++) c += texture2D(tScene, clamp(uv - d * float(k), 0.002, 0.998)).rgb;
    c /= 8.0;
  }
  if (uBloom > 0.5) c += texture2D(tBloom, uv).rgb * 0.9;
  c = toSRGB(c);
  // slight PS2-style contrast / saturation curve
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 1.12);
  vec2 px = floor(uv * uRes);
  if (uDither > 0.5) {
    c += bayer4(px) / 32.0;            // ordered dither
    c = floor(c * 31.0 + 0.5) / 31.0;  // 15-bit colour
  }
  if (uScan > 0.5) {
    c *= 0.86 + 0.14 * step(0.5, mod(px.y, 2.0));
    vec2 q = uv - 0.5;
    c *= 1.0 - dot(q, q) * 0.7;
  }
  c = mix(c, uFlashColor, uFlash);
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * Low-res render target -> bloom -> dithered/quantised composite, upscaled
 * with nearest filtering to the full canvas for a crisp PS2 look.
 */
export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  private rt!: THREE.WebGLRenderTarget;
  private bA!: THREE.WebGLRenderTarget;
  private bB!: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bright: THREE.ShaderMaterial;
  private blur: THREE.ShaderMaterial;
  private composite: THREE.ShaderMaterial;
  settings: RetroSettings;
  flash = 0;
  flashColor = new THREE.Color(1, 1, 1);
  speedBlur = 0;

  constructor(
    canvas: HTMLCanvasElement,
    settings: RetroSettings,
  ) {
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;
    this.bright = new THREE.ShaderMaterial({
      vertexShader: fsQuadVert,
      fragmentShader: brightFrag,
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.62 } },
      depthTest: false,
    });
    this.blur = new THREE.ShaderMaterial({
      vertexShader: fsQuadVert,
      fragmentShader: blurFrag,
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: fsQuadVert,
      fragmentShader: compositeFrag,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uRes: { value: new THREE.Vector2() },
        uDither: { value: 1 },
        uScan: { value: 0 },
        uBloom: { value: 1 },
        uFlash: { value: 0 },
        uFlashColor: { value: new THREE.Color() },
        uBlur: { value: 0 },
        uTime: { value: 0 },
      },
      depthTest: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.resize();
  }

  get lowResSize() {
    const w = Math.max(2, window.innerWidth);
    const h = Math.max(2, window.innerHeight);
    const rh = Math.min(this.settings.resHeight, h);
    return { w: Math.round((rh * w) / h), h: rh };
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const { w: lw, h: lh } = this.lowResSize;
    this.rt?.dispose();
    this.bA?.dispose();
    this.bB?.dispose();
    this.rt = new THREE.WebGLRenderTarget(lw, lh, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    const bw = Math.max(1, Math.floor(lw / 4));
    const bh = Math.max(1, Math.floor(lh / 4));
    const bopts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, depthBuffer: false };
    this.bA = new THREE.WebGLRenderTarget(bw, bh, bopts);
    this.bB = new THREE.WebGLRenderTarget(bw, bh, bopts);
    this.composite.uniforms.uRes.value.set(lw, lh);
    retroUniforms.uSnapRes.value.set(lw / 2, lh / 2);
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const s = this.settings;
    retroUniforms.uSnap.value = s.ps1 ? 1 : 0;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(scene, camera);
    if (s.bloom) {
      this.bright.uniforms.tDiffuse.value = this.rt.texture;
      this.pass(this.bright, this.bA);
      for (let k = 0; k < 2; k++) {
        this.blur.uniforms.tDiffuse.value = this.bA.texture;
        this.blur.uniforms.uDir.value.set(1 / this.bA.width, 0);
        this.pass(this.blur, this.bB);
        this.blur.uniforms.tDiffuse.value = this.bB.texture;
        this.blur.uniforms.uDir.value.set(0, 1 / this.bA.height);
        this.pass(this.blur, this.bA);
      }
    }
    const u = this.composite.uniforms;
    u.tScene.value = this.rt.texture;
    u.tBloom.value = this.bA.texture;
    u.uDither.value = s.dither ? 1 : 0;
    u.uScan.value = s.scanlines ? 1 : 0;
    u.uBloom.value = s.bloom ? 1 : 0;
    u.uFlash.value = this.flash;
    u.uFlashColor.value.copy(this.flashColor);
    u.uBlur.value = this.speedBlur * (s.motionBlur ?? 1);
    this.pass(this.composite, null);
  }
}
