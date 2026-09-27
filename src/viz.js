// Dithered three.js views. Every scene is rendered at low resolution into a
// render target, then collapsed to pure 1-bit with an 8x8 Bayer ordered dither.
import * as THREE from './vendor/three.module.js';

const DITHER_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DITHER_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float gamma;
  uniform float bias;
  varying vec2 vUv;
  float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
  #define bayer4(a) (bayer2(0.5 * (a)) * 0.25 + bayer2(a))
  #define bayer8(a) (bayer4(0.5 * (a)) * 0.25 + bayer2(a))
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = pow(clamp(dot(c, vec3(0.299, 0.587, 0.114)) + bias, 0.0, 1.0), gamma);
    float v = step(bayer8(gl_FragCoord.xy) + 0.001, l);
    gl_FragColor = vec4(vec3(v), 1.0);
  }
`;

class DitherStage {
  constructor(canvas, { pixel = 2, gamma = 0.8, bias = 0 } = {}) {
    this.canvas = canvas;
    this.pixel = pixel;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.rt = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.post = new THREE.Scene();
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.uniforms = { tDiffuse: { value: this.rt.texture }, gamma: { value: gamma }, bias: { value: bias } };
    this.post.add(new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: DITHER_VERT, fragmentShader: DITHER_FRAG, depthTest: false }),
    ));
    this.ro = new ResizeObserver(() => { this.resize(); this.draw(); });
    this.ro.observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const w = Math.max(8, Math.floor(this.canvas.clientWidth / this.pixel));
    const h = Math.max(8, Math.floor(this.canvas.clientHeight / this.pixel));
    this.renderer.setSize(w, h, false);
    this.rt.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  draw() {
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.post, this.postCam);
  }
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    const m = o.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => { mm.map?.dispose(); mm.dispose(); });
  });
}

// Simple drag-to-orbit camera rig.
function orbitRig(stage, { radius, height, onChange }) {
  const st = { yaw: 0.6, pitch: Math.atan2(height, radius), dist: Math.hypot(radius, height), drag: null, auto: true };
  const apply = () => {
    const cp = Math.cos(st.pitch);
    stage.camera.position.set(Math.sin(st.yaw) * cp * st.dist, Math.sin(st.pitch) * st.dist, Math.cos(st.yaw) * cp * st.dist);
    stage.camera.lookAt(0, 0, 0);
  };
  const el = stage.canvas;
  el.addEventListener('pointerdown', (e) => { st.drag = { x: e.clientX, y: e.clientY, moved: false }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    const dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) st.drag.moved = true;
    st.yaw -= dx * 0.008;
    st.pitch = Math.min(1.35, Math.max(0.05, st.pitch + dy * 0.006));
    st.drag.x = e.clientX; st.drag.y = e.clientY;
    st.auto = false;
    apply(); onChange?.();
  });
  el.addEventListener('pointerup', () => { setTimeout(() => { st.drag = null; }, 0); });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    st.dist = Math.min(40, Math.max(4, st.dist * (1 + Math.sign(e.deltaY) * 0.08)));
    apply(); onChange?.();
  }, { passive: false });
  el.addEventListener('dblclick', () => { st.auto = true; });
  apply();
  return {
    tick(dt) { if (st.auto) { st.yaw += dt * 0.06; apply(); } },
    wasDrag() { return st.drag?.moved; },
  };
}

// ============================================================ Orrery
// Each profile is a planet. Size ~ posts in its public feed, orbital speed ~
// posting cadence over the last 30 days, moons = posts in the last 90 days.
export class Orrery {
  constructor(canvas, { onPick, onHover } = {}) {
    this.stage = new DitherStage(canvas, { pixel: 2, gamma: 0.75 });
    this.onPick = onPick;
    this.onHover = onHover;
    const s = this.stage.scene;
    s.background = new THREE.Color(0x000000);
    s.add(new THREE.AmbientLight(0xffffff, 0.08));
    const sunLight = new THREE.PointLight(0xffffff, 60, 0, 1.6);
    s.add(sunLight);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(-6, 8, -4);
    s.add(rim);

    // The sun: a faceted icosahedron inside a wire cage.
    this.sun = new THREE.Group();
    this.sun.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), new THREE.MeshBasicMaterial({ color: 0xbbbbbb })));
    this.cage = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.35, 1)),
      new THREE.LineBasicMaterial({ color: 0xffffff }),
    );
    this.sun.add(this.cage);
    s.add(this.sun);

    // Stars.
    const pts = [];
    for (let i = 0; i < 700; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 30);
      pts.push(v.x, v.y, v.z);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    s.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1, sizeAttenuation: false })));

    this.system = new THREE.Group();
    s.add(this.system);
    this.planets = [];
    this.rig = orbitRig(this.stage, { radius: 11, height: 6.5, onChange: () => this.draw() });
    // Crisp Chicago labels live in the DOM, projected onto each planet.
    this.labels = document.createElement('div');
    this.labels.className = 'orb-labels';
    canvas.parentElement.append(this.labels);
    this.tmp = new THREE.Vector3();

    this.ray = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    canvas.addEventListener('click', (e) => {
      if (this.rig.wasDrag()) return;
      const hit = this.pick(e);
      if (hit) this.onPick?.(hit.userData.id);
    });
    canvas.addEventListener('mousemove', (e) => {
      const hit = this.pick(e);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      this.onHover?.(hit ? hit.userData : null);
    });
  }

  pick(e) {
    const r = this.stage.canvas.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.stage.camera);
    const hits = this.ray.intersectObjects(this.planets.map((p) => p.body), false);
    return hits[0]?.object || null;
  }

  setData(profiles, activeId) {
    disposeTree(this.system);
    this.system.clear();
    this.planets = [];
    this.labels.replaceChildren();
    const rings = Math.max(profiles.length, 3);
    for (let i = 0; i < rings; i++) {
      const p = profiles[i];
      const radius = 2.6 + i * 1.35;
      const tilt = (i % 2 ? 1 : -1) * (0.04 + i * 0.025);
      const pivot = new THREE.Group();
      pivot.rotation.x = tilt;
      pivot.rotation.z = tilt * 0.6;
      this.system.add(pivot);

      const ringPts = [];
      for (let k = 0; k <= 128; k++) {
        const a = (k / 128) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      }
      const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
      const ringMat = p
        ? new THREE.LineBasicMaterial({ color: p.id === activeId ? 0xffffff : 0x777777 })
        : new THREE.LineDashedMaterial({ color: 0x555555, dashSize: 0.2, gapSize: 0.3 });
      const ring = new THREE.Line(ringGeo, ringMat);
      if (!p) ring.computeLineDistances();
      pivot.add(ring);
      if (!p) continue;

      const posts = p.posts || 0;
      const size = 0.22 + Math.sqrt(posts) * 0.09;
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(size, 24, 16),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: i % 2 === 1 }),
      );
      body.userData = { id: p.id, name: p.name, handle: p.handle, posts, cadence: p.cadence };
      const holder = new THREE.Group();
      holder.add(body);

      const moons = [];
      const moonCount = Math.min(p.recent || 0, 12);
      for (let m = 0; m < moonCount; m++) {
        const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        moon.userData.phase = (m / moonCount) * Math.PI * 2;
        moon.userData.r = size + 0.18 + (m % 3) * 0.07;
        holder.add(moon);
        moons.push(moon);
      }

      let halo = null;
      if (p.id === activeId) {
        halo = new THREE.Mesh(new THREE.TorusGeometry(size + 0.28, 0.025, 6, 48), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        halo.rotation.x = Math.PI / 2.4;
        holder.add(halo);
      }
      const tag = document.createElement('div');
      tag.className = 'orb-label' + (p.id === activeId ? ' active' : '');
      tag.textContent = `${p.glyph || '✶'} ${p.name}`;
      this.labels.append(tag);

      pivot.add(holder);
      this.planets.push({
        body, holder, moons, halo, radius, tag, size,
        angle: (i * 2.39996) % (Math.PI * 2),             // golden-angle spread
        speed: 0.05 + Math.min(p.cadence || 0, 12) * 0.035,
      });
    }
    this.place(0);
    this.draw();
  }

  draw() {
    this.stage.draw();
    const w = this.stage.canvas.clientWidth, h = this.stage.canvas.clientHeight;
    for (const pl of this.planets) {
      pl.holder.getWorldPosition(this.tmp);
      this.tmp.y += pl.size + 0.35;
      this.tmp.project(this.stage.camera);
      const off = this.tmp.z > 1;
      pl.tag.style.display = off ? 'none' : '';
      pl.tag.style.transform = `translate(${Math.round((this.tmp.x + 1) / 2 * w)}px, ${Math.round((1 - this.tmp.y) / 2 * h)}px) translate(-50%, -100%)`;
    }
  }

  place(dt) {
    for (const pl of this.planets) {
      pl.angle += dt * pl.speed;
      pl.holder.position.set(Math.cos(pl.angle) * pl.radius, 0, Math.sin(pl.angle) * pl.radius);
      pl.body.rotation.y += dt * 0.4;
      for (const m of pl.moons) {
        m.userData.phase += dt * 1.1;
        m.position.set(Math.cos(m.userData.phase) * m.userData.r, Math.sin(m.userData.phase * 0.7) * 0.08, Math.sin(m.userData.phase) * m.userData.r);
      }
      if (pl.halo) pl.halo.rotation.z += dt * 0.8;
    }
  }

  frame(dt, t) {
    this.sun.rotation.y += dt * 0.25;
    this.sun.rotation.x = Math.sin(t * 0.3) * 0.2;
    this.cage.rotation.y -= dt * 0.4;
    const pulse = 1 + Math.sin(t * 1.7) * 0.03;
    this.cage.scale.setScalar(pulse);
    this.place(dt);
    this.rig.tick(dt);
    this.draw();
  }
}

// ============================================================ Loom
// 12 weeks x 7 days of publishing for the active profile, woven as bars.
export class Loom {
  constructor(canvas) {
    this.stage = new DitherStage(canvas, { pixel: 2, gamma: 0.9, bias: 0.02 });
    const s = this.stage.scene;
    s.background = new THREE.Color(0xffffff);
    s.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 9, 6);
    s.add(key);
    this.group = new THREE.Group();
    s.add(this.group);
    this.rig = orbitRig(this.stage, { radius: 11, height: 8, onChange: () => this.stage.draw() });
    this.bars = [];
  }

  setData(items) {
    disposeTree(this.group);
    this.group.clear();
    this.bars = [];
    const WEEKS = 12;
    const day = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = today.getTime() - (WEEKS * 7 - 1) * day;
    const counts = new Array(WEEKS * 7).fill(0);
    let inWindow = 0;
    for (const it of items || []) {
      const d = new Date(it.date); d.setHours(0, 0, 0, 0);
      const idx = Math.round((d.getTime() - start) / day);
      if (idx >= 0 && idx < counts.length) { counts[idx]++; inWindow++; }
    }

    const cell = 0.62;
    const ox = -((WEEKS - 1) * cell) / 2, oz = -(6 * cell) / 2;
    // Floor: outlined tiles.
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(WEEKS * cell + 0.5, 0.08, 7 * cell + 0.5),
      new THREE.MeshStandardMaterial({ color: 0xd4d4d4, roughness: 1 }),
    );
    floor.position.y = -0.04;
    this.group.add(floor);

    const tops = [];
    counts.forEach((n, i) => {
      const w = Math.floor(i / 7), dd = i % 7;
      const h = n ? 0.5 + n * 0.9 : 0.03;
      const geo = new THREE.BoxGeometry(cell * 0.78, h, cell * 0.78);
      const bar = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: n ? 0xf2f2f2 : 0x8c8c8c, roughness: 0.85, flatShading: true }));
      bar.position.set(ox + w * cell, h / 2, oz + dd * cell);
      bar.userData.h = h;
      bar.scale.y = 0.001;
      this.group.add(bar);
      if (n) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000 }));
        bar.add(edges);
        tops.push(new THREE.Vector3(bar.position.x, h + 0.25, bar.position.z));
      }
      this.bars.push(bar);
    });

    // A thread through every published day, in order.
    if (tops.length > 1) {
      const curve = new THREE.CatmullRomCurve3(tops);
      const thread = new THREE.Mesh(new THREE.TubeGeometry(curve, tops.length * 12, 0.03, 5, false), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      this.group.add(thread);
    }
    this.grow = 0;
    this.stage.draw();
    return { inWindow, counts };
  }

  frame(dt) {
    if (this.grow < 1) {
      this.grow = Math.min(1, this.grow + dt * 1.4);
      const e = 1 - Math.pow(1 - this.grow, 3);
      this.bars.forEach((b, i) => {
        const local = Math.min(1, Math.max(0, e * 1.6 - (i / this.bars.length) * 0.6));
        b.scale.y = Math.max(0.001, local);
        b.position.y = (b.userData.h * b.scale.y) / 2;
      });
    }
    this.rig.tick(dt * 0.6);
    this.stage.draw();
  }
}

// ============================================================ Sigil
// Deterministic 1-bit sigil drawn on a small 2D canvas (splash, omens, icons).
export function drawSigil(canvas, seed = 1, { invert = false } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 10000) / 10000; };
  const fg = invert ? '#fff' : '#000', bg = invert ? '#000' : '#fff';
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = fg; ctx.fillStyle = fg; ctx.lineWidth = 2; ctx.lineCap = 'square';
  const cx = W / 2, cy = H / 2, R = W * 0.42;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R - 5, 0, Math.PI * 2); ctx.stroke();
  const n = 5 + Math.floor(rnd() * 4);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pts.push([cx + Math.cos(a) * (R - 5), cy + Math.sin(a) * (R - 5)]);
  }
  const step = 2 + Math.floor(rnd() * (n / 2 - 1));
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const p = pts[(i * step) % n];
    i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
  }
  ctx.stroke();
  for (const p of pts) { ctx.fillRect(Math.round(p[0]) - 2, Math.round(p[1]) - 2, 5, 5); }
  ctx.beginPath(); ctx.arc(cx, cy, R * (0.14 + rnd() * 0.12), 0, Math.PI * 2); ctx.fill();
  // Snap to hard 1-bit.
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i] > 127 ? 255 : 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
