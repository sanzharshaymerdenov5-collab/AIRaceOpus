import * as THREE from 'three';

export const FOG_COLOR = new THREE.Color(0x0c1022);
export const DAY_FOG_COLOR = new THREE.Color(0x88c4ee);

/** Sky dome supporting both Palm City Day Mode (sun, corona, azure gradient) and Night Mode (stars, moon, neon glow). */
export function createSky(): THREE.Group {
  const g = new THREE.Group();

  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uHorizon: { value: FOG_COLOR.clone() },
      uTop: { value: new THREE.Color(0x02030a) },
      uGlow: { value: new THREE.Color(0x3a1f4a) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uHorizon; uniform vec3 uTop; uniform vec3 uGlow; varying vec3 vP;
      void main(){ float h = clamp(vP.y, 0.0, 1.0);
        vec3 c = mix(uHorizon, uTop, pow(h, 0.48));
        c += uGlow * exp(-h * 7.5) * 0.55;
        gl_FragColor = vec4(c, 1.0); }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1300, 24, 12), domeMat);
  dome.name = 'skyDome';
  dome.renderOrder = -10;
  g.add(dome);

  // Stars (night only)
  const starGeo = new THREE.BufferGeometry();
  const pos: number[] = [];
  for (let k = 0; k < 900; k++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * 0.9 + 0.08;
    const r = 1200;
    pos.push(Math.cos(u) * Math.cos(v * 1.4) * r, Math.sin(v * 1.4) * r, Math.sin(u) * Math.cos(v * 1.4) * r);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xbfcfff, size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false }));
  stars.name = 'skyStars';
  g.add(stars);

  // Moon (night)
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(44, 20),
    new THREE.MeshBasicMaterial({ color: 0xfff4d6, fog: false, toneMapped: false }),
  );
  moon.name = 'skyMoon';
  moon.position.set(-480, 580, -720);
  moon.lookAt(0, 0, 0);
  g.add(moon);

  // Blazing Sun + Corona Halo (day)
  const sunGroup = new THREE.Group();
  sunGroup.name = 'skySun';
  const sunCore = new THREE.Mesh(
    new THREE.CircleGeometry(56, 24),
    new THREE.MeshBasicMaterial({ color: 0xfffdf0, fog: false, toneMapped: false }),
  );
  const sunHalo = new THREE.Mesh(
    new THREE.RingGeometry(54, 135, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sunGroup.add(sunCore, sunHalo);
  sunGroup.position.set(420, 620, 380);
  sunGroup.lookAt(0, 0, 0);
  sunGroup.visible = false;
  g.add(sunGroup);

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
  const ringMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(1150, 1150, 160, 48, 1, true), ringMat);
  ring.name = 'skyRing';
  ring.position.y = 45;
  g.add(ring);

  g.renderOrder = -5;
  return g;
}

export function setSkyTimeOfDay(sky: THREE.Group, mode: 'day' | 'night') {
  const isDay = mode === 'day';
  const dome = sky.getObjectByName('skyDome') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | undefined;
  if (dome) {
    const u = dome.material.uniforms;
    if (isDay) {
      u.uHorizon.value.setHex(0x8fd0f6);
      u.uTop.value.setHex(0x1656c0);
      u.uGlow.value.setHex(0xffe09e);
    } else {
      u.uHorizon.value.copy(FOG_COLOR);
      u.uTop.value.setHex(0x02030a);
      u.uGlow.value.setHex(0x3a1f4a);
    }
  }
  const stars = sky.getObjectByName('skyStars');
  if (stars) stars.visible = !isDay;
  const moon = sky.getObjectByName('skyMoon');
  if (moon) moon.visible = !isDay;
  const sun = sky.getObjectByName('skySun');
  if (sun) sun.visible = isDay;
  const ring = sky.getObjectByName('skyRing') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined;
  if (ring) {
    ring.material.opacity = isDay ? 0.35 : 1.0;
  }
}
