import * as THREE from 'three';

export const FOG_COLOR = new THREE.Color(0x0c1022);

/** Night sky dome with gradient, stars, moon and a distant skyline silhouette. */
export function createSky(): THREE.Group {
  const g = new THREE.Group();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1000, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uHorizon: { value: FOG_COLOR.clone() }, uTop: { value: new THREE.Color(0x02030a) }, uGlow: { value: new THREE.Color(0x3a1f4a) } },
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uHorizon; uniform vec3 uTop; uniform vec3 uGlow; varying vec3 vP;
        void main(){ float h = clamp(vP.y, 0.0, 1.0);
          vec3 c = mix(uHorizon, uTop, pow(h, 0.45));
          c += uGlow * exp(-h * 9.0) * 0.6; // city light pollution glow
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  dome.renderOrder = -10;
  g.add(dome);

  // Stars
  const starGeo = new THREE.BufferGeometry();
  const pos: number[] = [];
  for (let k = 0; k < 900; k++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * 0.9 + 0.08;
    const r = 950;
    pos.push(Math.cos(u) * Math.cos(v * 1.4) * r, Math.sin(v * 1.4) * r, Math.sin(u) * Math.cos(v * 1.4) * r);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xbfcfff, size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false })));

  // Moon
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(38, 20),
    new THREE.MeshBasicMaterial({ color: 0xfff4d6, fog: false, toneMapped: false }),
  );
  moon.position.set(-420, 520, -620);
  moon.lookAt(0, 0, 0);
  g.add(moon);

  // Distant skyline silhouette ring
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 128;
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, c.width, c.height);
  let px = 0;
  while (px < c.width) {
    const w = 12 + Math.random() * 40;
    const h = 20 + Math.random() * 100;
    x.fillStyle = '#05070f';
    x.fillRect(px, c.height - h, w, h);
    for (let k = 0; k < h / 6; k++) {
      if (Math.random() < 0.25) {
        x.fillStyle = Math.random() < 0.5 ? '#ffcf7a' : '#9fd8ff';
        x.fillRect(px + 2 + Math.random() * (w - 4), c.height - h + k * 6 + 2, 2, 2);
      }
    }
    px += w + Math.random() * 6;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.x = 2;
  tex.magFilter = THREE.NearestFilter;
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(900, 900, 140, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  ring.position.y = 40;
  g.add(ring);

  g.renderOrder = -5;
  return g;
}
