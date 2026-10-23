// Three.js rendering: scene, isometric camera, placeholder meshes, effects.
import * as THREE from 'three';
import { TYPES, TEAM_COLORS, MAP_SIZE } from './config.js';
import { START_POS } from './sim.js';
import { instantiate } from './assets.js';

const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.75, metalness: 0.05, ...o });
const MAT = {
  white: M(0xe9e3d6), grey: M(0xb8b2a6), metal: M(0x4b5059),
  glow: M(0x7ff6ff, { emissive: 0x22d3ee, emissiveIntensity: 1.4 }),
  crystal: M(0x2dd4bf, { emissive: 0x0f9488, emissiveIntensity: 0.7, roughness: 0.2 }),
  rock: M(0x8b8478), moss: M(0x6f8f4f),
};
const TEAM = TEAM_COLORS.map((c) => M(c, { emissive: c, emissiveIntensity: 0.25 }));
const NEUTRAL = M(0x9ca3af);

// Rifle grip placement relative to the right shoulder, in the character's frame (faces +z, its right side is -x).
// LOW: carried at the hip pointing forward-down. AIM: raised with the stock at the shoulder, level.
const RIFLE_POSE = {
  low: { offset: new THREE.Vector3(0.12, -0.55, 0.28), pitch: 0.5 },
  aim: { offset: new THREE.Vector3(0.14, -0.15, 0.3), pitch: 0 },
};
// Elbow hints: right elbow down/out/back, left elbow down/out.
const POLE = { right: new THREE.Vector3(-0.7, -1, -0.4), left: new THREE.Vector3(0.7, -1, -0.1) };
const BONE_UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Vector3();

// Points a bone (which extends along its local +Y) in a world direction.
function aimBone(bone, worldDir) {
  bone.parent.getWorldQuaternion(_q).invert();
  bone.quaternion.setFromUnitVectors(BONE_UP, _v.copy(worldDir).normalize().applyQuaternion(_q));
  bone.updateMatrixWorld(true);
}

// Two-bone IK: bends upper/fore so the hand reaches `target` (world), elbow toward `pole` (world direction).
function reach(upper, fore, hand, target, pole) {
  upper.getWorldPosition(_a); fore.getWorldPosition(_b); hand.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b), l2 = _b.distanceTo(_c);
  _t.subVectors(target, _a);
  const dist = Math.min(Math.max(_t.length(), 1e-4), (l1 + l2) * 0.999);
  _t.normalize();
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
  _p.copy(pole).addScaledVector(_t, -pole.dot(_t)).normalize(); // bend direction, perpendicular to the reach
  _e.copy(_a).addScaledVector(_t, l1 * cosA).addScaledVector(_p, l1 * Math.sqrt(1 - cosA * cosA));
  aimBone(upper, _v2.subVectors(_e, _a));
  fore.getWorldPosition(_b);
  aimBone(fore, _v2.subVectors(target, _b));
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}

// Placeholder models, built from primitives in the style-guide palette. Front faces +z.
const BUILDERS = {
  worker(t) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), MAT.white);
    body.scale.set(1, 0.8, 1.1); body.position.y = 1.0; g.add(body);
    g.add(box(0.5, 0.12, 0.08, MAT.glow, 0, 1.05, 0.46));
    g.add(box(0.7, 0.1, 0.3, t, 0, 1.33, 0));
    g.add(box(0.1, 0.4, 0.1, MAT.metal, -0.15, 0.62, 0.35), box(0.1, 0.4, 0.1, MAT.metal, 0.15, 0.62, 0.35));
    g.add(cyl(0.18, 0.25, 0.12, MAT.glow, 0, 0.6, 0));
    return g;
  },
  soldier(t) {
    const g = new THREE.Group();
    g.add(box(0.55, 0.6, 0.35, MAT.metal, 0, 0.3, 0));
    g.add(box(0.8, 0.6, 0.5, MAT.white, 0, 0.9, 0));
    g.add(box(0.9, 0.18, 0.55, t, 0, 1.12, 0));
    g.add(box(0.4, 0.38, 0.4, MAT.grey, 0, 1.4, 0));
    g.add(box(0.3, 0.08, 0.05, MAT.glow, 0, 1.42, 0.21));
    g.add(box(0.14, 0.14, 0.75, MAT.metal, 0.38, 0.9, 0.35));
    return g;
  },
  ranger(t) {
    const g = new THREE.Group();
    g.add(box(0.45, 0.75, 0.3, MAT.metal, 0, 0.37, 0));
    g.add(box(0.6, 0.6, 0.4, MAT.white, 0, 1.05, 0));
    g.add(box(0.65, 0.12, 0.45, t, 0, 1.2, 0));
    g.add(box(0.45, 0.5, 0.25, MAT.grey, 0, 1.05, -0.3));
    g.add(box(0.34, 0.34, 0.34, MAT.grey, 0, 1.55, 0));
    g.add(box(0.26, 0.07, 0.05, MAT.glow, 0, 1.57, 0.18));
    g.add(box(0.1, 0.1, 1.4, MAT.metal, 0.32, 1.05, 0.45));
    g.add(box(0.06, 0.06, 0.3, MAT.glow, 0.32, 1.05, 1.15));
    return g;
  },
  tank(t) {
    const g = new THREE.Group();
    g.add(box(2.0, 0.3, 2.6, MAT.metal, 0, 0.45, 0));
    g.add(box(1.8, 0.55, 2.3, MAT.white, 0, 0.85, 0));
    g.add(box(1.84, 0.14, 0.5, t, 0, 0.95, -0.6));
    g.add(box(1.1, 0.45, 1.1, MAT.grey, 0, 1.35, -0.1));
    const barrel = cyl(0.12, 0.12, 1.6, MAT.metal, 0, 1.4, 1.1, 8);
    barrel.rotation.x = Math.PI / 2; g.add(barrel);
    g.add(box(1.6, 0.06, 2.0, MAT.glow, 0, 0.28, 0));
    return g;
  },
  hq(t) {
    const g = new THREE.Group();
    g.add(cyl(3.4, 3.5, 0.5, MAT.metal, 0, 0.25, 0, 8));
    g.add(cyl(2.6, 2.7, 1.8, MAT.white, 0, 1.4, 0, 8));
    g.add(cyl(2.65, 2.65, 0.3, t, 0, 2.1, 0, 8));
    g.add(cyl(2.72, 2.72, 0.15, MAT.glow, 0, 1.2, 0, 8));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), MAT.grey);
    dome.position.y = 2.3; g.add(dome);
    g.add(cyl(0.08, 0.08, 2, MAT.metal, 0.6, 4.6, 0, 6));
    g.add(box(0.25, 0.25, 0.25, MAT.glow, 0.6, 5.6, 0));
    return g;
  },
  barracks(t) {
    const g = new THREE.Group();
    g.add(box(4.2, 0.3, 3.8, MAT.metal, 0, 0.15, 0));
    g.add(box(3.8, 2.2, 3.4, MAT.white, 0, 1.4, 0));
    g.add(box(4.0, 0.5, 3.6, MAT.grey, 0, 2.7, 0));
    g.add(box(3.86, 0.25, 3.46, t, 0, 2.2, 0));
    g.add(box(2.0, 1.5, 0.1, MAT.metal, 0, 1.05, 1.72));
    g.add(box(2.0, 0.1, 0.12, MAT.glow, 0, 1.85, 1.74));
    return g;
  },
  turret(t) {
    const g = new THREE.Group();
    g.add(cyl(1.25, 1.35, 0.9, MAT.grey, 0, 0.45, 0, 10));
    g.add(cyl(1.28, 1.28, 0.15, t, 0, 0.8, 0, 10));
    g.add(box(1.0, 0.7, 1.1, MAT.white, 0, 1.25, 0));
    for (const x of [-0.25, 0.25]) {
      const b = cyl(0.09, 0.09, 1.2, MAT.metal, x, 1.3, 1.0, 6);
      b.rotation.x = Math.PI / 2; g.add(b);
    }
    g.add(box(0.6, 0.08, 0.05, MAT.glow, 0, 1.45, 0.56));
    return g;
  },
  crystal() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.DodecahedronGeometry(1.0, 0), MAT.rock);
    base.scale.set(1.2, 0.35, 1.2); base.position.y = 0.2; g.add(base);
    const shapes = [[0, 0, 1.6, 0], [0.55, 0.2, 1.1, 0.4], [-0.5, 0.3, 1.2, -0.35], [0.1, -0.55, 0.9, 0.3], [-0.3, -0.4, 0.8, -0.2]];
    for (const [x, z, h, tilt] of shapes) {
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.35, 0), MAT.crystal);
      c.scale.set(1, h / 0.7, 1); c.position.set(x, h / 2 + 0.2, z); c.rotation.z = tilt; c.rotation.x = tilt * 0.6;
      g.add(c);
    }
    return g;
  },
  rock() {
    const g = new THREE.Group();
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(2.0, 0), MAT.rock);
    r.scale.set(1, 0.75, 0.9); r.position.y = 1.0; g.add(r);
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(1.3, 0), MAT.moss);
    m.scale.set(1, 0.35, 0.9); m.position.y = 2.15; g.add(m);
    return g;
  },
};

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#c98a4e';
  g.fillRect(0, 0, 512, 512);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * 512, y = rnd() * 512, r = 1 + rnd() * 5;
    g.fillStyle = rnd() < 0.5 ? `rgba(120,70,35,${0.05 + rnd() * 0.12})` : `rgba(240,190,130,${0.05 + rnd() * 0.12})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  for (let i = 0; i < 60; i++) {
    const x = rnd() * 512, y = rnd() * 512;
    g.fillStyle = 'rgba(110,100,90,0.6)';
    g.beginPath(); g.ellipse(x, y, 2 + rnd() * 3, 1.5 + rnd() * 2, rnd() * 3, 0, Math.PI * 2); g.fill();
  }
  return setupGroundTex(new THREE.CanvasTexture(c));
}

function setupGroundTex(tex) {
  // Mirrored wrapping hides the seams of a texture that doesn't tile perfectly.
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.repeat.set(MAP_SIZE / 18, MAP_SIZE / 18);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class Renderer {
  constructor(canvas, localSlot) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2b2747);
    this.scene.fog = new THREE.Fog(0x2b2747, 90, 170);

    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 400);
    const [sx, sz] = START_POS[localSlot];
    this.camDir = new THREE.Vector2(Math.sign(sx), Math.sign(sz)).normalize(); // camera sits on the player's corner side
    this.target = new THREE.Vector2(sx, sz).addScaledVector(this.camDir, 4); // HQ sits above the HUD, mineral line in view
    this.dist = 48;

    this.scene.add(new THREE.HemisphereLight(0xfff3e0, 0x4c3d6b, 1.4));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 200 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    const groundMat = new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 1 });
    new THREE.TextureLoader().load(new URL('../assets/ground.webp', import.meta.url).href, (t) => {
      groundMat.map = setupGroundTex(t);
      groundMat.needsUpdate = true;
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: 0x241f3d }));
    edge.rotation.x = -Math.PI / 2; edge.position.y = -0.3;
    this.scene.add(edge);

    this.meshes = new Map();
    this.effects = [];
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.ghost = null;
    this.time = 0;

    this.ringGeo = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
    this.barGeo = new THREE.PlaneGeometry(1, 1);
    this.fxGeo = { sphere: new THREE.SphereGeometry(1, 12, 8), box: new THREE.BoxGeometry(1, 1, 1) };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Screen-space pan directions on the ground.
  get forward() { return new THREE.Vector2(-this.camDir.x, -this.camDir.y); }
  get right() { const f = this.forward; return new THREE.Vector2(-f.y, f.x); }

  pan(dx, dz) {
    const f = this.forward, r = this.right, k = this.dist / 55;
    this.target.x += (r.x * dx + f.x * dz) * k;
    this.target.y += (r.y * dx + f.y * dz) * k;
    const lim = MAP_SIZE / 2;
    this.target.x = Math.max(-lim, Math.min(lim, this.target.x));
    this.target.y = Math.max(-lim, Math.min(lim, this.target.y));
  }
  zoom(delta) { this.dist = Math.max(22, Math.min(95, this.dist * (1 + delta))); }
  centerOn(x, z) { this.target.set(x, z); }

  updateCamera() {
    const pitch = THREE.MathUtils.degToRad(55);
    const h = Math.sin(pitch) * this.dist, d = Math.cos(pitch) * this.dist;
    this.camera.position.set(this.target.x + this.camDir.x * d, h, this.target.y + this.camDir.y * d);
    this.camera.lookAt(this.target.x, 0, this.target.y);
    this.sun.position.set(this.target.x - 30, 60, this.target.y + 20);
    this.sun.target.position.set(this.target.x, 0, this.target.y);
  }

  screenToGround(mx, my) {
    const ndc = new THREE.Vector2((mx / window.innerWidth) * 2 - 1, -(my / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, p) ? { x: p.x, z: p.z } : null;
  }
  worldToScreen(x, z, y = 0.5) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight, visible: v.z < 1 };
  }
  // Ground footprint of the view, for the minimap.
  viewCorners() {
    return [[0, 0], [window.innerWidth, 0], [window.innerWidth, window.innerHeight], [0, window.innerHeight]]
      .map(([x, y]) => this.screenToGround(x, y)).filter(Boolean);
  }

  makeMesh(e) {
    const T = TYPES[e.type];
    const inst = instantiate(e.type, e.owner);
    let g;
    if (inst) {
      g = inst.object;
    } else { // placeholder primitives if the model is missing
      g = BUILDERS[e.type](e.owner >= 0 ? TEAM[e.owner] : NEUTRAL);
      g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      if (T.kind === 'unit') g.scale.setScalar(1.25); // a touch larger than their footprint, for readability
    }
    const root = new THREE.Group();
    root.add(g);
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.scale.setScalar(T.radius + 0.25);
    ring.position.y = 0.06;
    ring.visible = false;
    root.add(ring);
    const bar = new THREE.Group();
    const bg = new THREE.Mesh(this.barGeo, new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false, transparent: true, opacity: 0.7 }));
    const fg = new THREE.Mesh(this.barGeo, new THREE.MeshBasicMaterial({ color: 0x4ade80, depthTest: false }));
    bg.renderOrder = 10; fg.renderOrder = 11; fg.position.z = 0.01;
    bar.add(bg, fg);
    const w = Math.max(1.0, T.radius * 1.6);
    bar.scale.set(w, 0.16, 1);
    bar.position.y = T.kind === 'building' ? (e.type === 'hq' ? 6.2 : 3.4) : e.type === 'tank' ? 2.1 : 2.0;
    bar.visible = false;
    root.add(bar);
    root.position.set(e.x, 0, e.z);
    this.scene.add(root);
    return { root, model: g, ring, bar, fg, kind: T.kind, phase: Math.random() * 10, ...inst, aimW: 0, kick: 0, recoil: 0 };
  }

  sync(view, selected, dt) {
    this.time += dt;
    for (const [id, e] of view.ents) {
      let m = this.meshes.get(id);
      if (!m) { m = this.makeMesh(e); this.meshes.set(id, m); }
      const T = TYPES[e.type];
      m.root.position.set(e.x, 0, e.z);
      if (m.kind !== 'resource') m.model.rotation.y = e.rot;
      let y = 0;
      if (e.type === 'worker' || e.type === 'tank') y = 0.15 + Math.sin(this.time * 3 + m.phase) * 0.08;
      else if (m.kind === 'unit' && e.b === 1 && !m.mixer) y = Math.abs(Math.sin(this.time * 11 + m.phase)) * 0.12;
      m.model.position.y = y;
      if (m.mixer) this.animate(m, e, dt);
      if (m.barrel) {
        // Barrel slides back on firing and eases forward again (barrel points -x in its own frame).
        m.recoil = Math.max(0, m.recoil - dt * 2.2);
        m.barrel.position.x = m.barrelRest.x + 0.08 * Math.sin(Math.min(1, m.recoil) * Math.PI / 2);
      }
      if (m.cargo) m.cargo.visible = e.a > 0;
      if (m.kind === 'building') m.model.scale.y = e.a >= 1 ? 1 : 0.15 + 0.85 * e.a;
      if (e.type === 'crystal') m.model.scale.setScalar(0.55 + 0.45 * Math.min(1, e.hp / TYPES.crystal.amount));

      const sel = selected.has(id);
      m.ring.visible = sel;
      if (sel) m.ring.material.color.setHex(e.owner === view.localId ? 0x4ade80 : e.owner < 0 ? 0xfacc15 : 0xf87171);
      const maxHp = T.hp;
      const showBar = maxHp && (sel || e.hp < maxHp);
      m.bar.visible = !!showBar;
      if (showBar) {
        const f = Math.max(0, Math.min(1, e.hp / maxHp));
        m.fg.scale.x = f; m.fg.position.x = -(1 - f) / 2;
        m.fg.material.color.setHex(f > 0.6 ? 0x4ade80 : f > 0.3 ? 0xfacc15 : 0xef4444);
        m.bar.quaternion.copy(this.camera.quaternion);
      }
    }
    for (const [id, m] of this.meshes) {
      if (view.ents.has(id)) continue;
      this.scene.remove(m.root);
      this.meshes.delete(id);
    }
    this.updateEffects(dt);
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  // Rigged infantry: legs from the walk clip; arms and rifle posed in code (carry, aim, recoil).
  animate(m, e, dt) {
    // Jog while moving; otherwise stand in the rig's bind pose (feet together, upright).
    const run = m.actions.run;
    if (e.b === 1) {
      if (!run.isRunning()) run.reset().play();
      run.timeScale = 1.1;
      m.mixer.update(dt);
    } else {
      if (run.isRunning()) run.stop();
      for (const [bone, p, q] of m.rest) { bone.position.copy(p); bone.quaternion.copy(q); }
    }
    const engaged = e.b === 3 || m.kick > 0;
    m.aimW += ((engaged ? 1 : 0) - m.aimW) * Math.min(1, dt * 8);
    m.kick = Math.max(0, m.kick - dt * 5);
    if (m.bones.RightArm) this.poseRifleman(m);
  }

  // The rifle is placed relative to the right shoulder; both hands are then solved onto it.
  poseRifleman(m) {
    if (!m.weapon) return;
    const B = m.bones;
    m.root.updateMatrixWorld(true);
    const k = Math.sin(Math.min(1, m.kick) * Math.PI / 2);
    const w = m.weapon;
    B.RightArm.getWorldPosition(_v2);
    m.model.worldToLocal(_v2);
    w.position.copy(_v2).add(_v.copy(RIFLE_POSE.low.offset).lerp(RIFLE_POSE.aim.offset, m.aimW));
    w.position.z -= 0.08 * k; // recoil pushes it back into the shoulder...
    w.rotation.set(RIFLE_POSE.low.pitch * (1 - m.aimW) - 0.15 * k, 0, 0); // ...and the muzzle climbs
    w.updateMatrixWorld(true);
    const objQ = m.model.getWorldQuaternion(_q2);
    const grip = w.getWorldPosition(new THREE.Vector3());
    const fore = w.localToWorld(m.fore.clone());
    reach(B.RightArm, B.RightForeArm, B.RightHand, grip, POLE.right.clone().applyQuaternion(objQ));
    reach(B.LeftArm, B.LeftForeArm, B.LeftHand, fore, POLE.left.clone().applyQuaternion(objQ));
  }

  // World position of a unit's gun muzzle, if it has one.
  muzzleOf(m, out) {
    if (m.muzzle) return m.muzzle.getWorldPosition(out);
    if (m.weapon) return m.weapon.localToWorld(out.copy(m.muzzlePt));
    return null;
  }

  // Tank/turret: a glow builds at the muzzle just before the shot.
  charge(ev) {
    const m = this.meshes.get(ev.a);
    if (!m || !m.muzzle) return;
    const glow = new THREE.Mesh(this.fxGeo.sphere, new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, depthWrite: false }));
    const dur = Math.max(0.12, ev.t);
    this.addFx(glow, dur, (g, t) => {
      m.muzzle.getWorldPosition(g.position);
      g.scale.setScalar(0.08 + 0.32 * t * t);
      g.material.opacity = 0.35 + 0.6 * t;
    });
  }

  // ---------- effects ----------

  addFx(mesh, life, update) {
    this.scene.add(mesh);
    this.effects.push({ mesh, life, age: 0, update });
  }
  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const f = this.effects[i];
      f.age += dt;
      const t = Math.min(1, f.age / f.life);
      f.update(f.mesh, t);
      if (t >= 1) { this.scene.remove(f.mesh); f.mesh.material.dispose(); this.effects.splice(i, 1); }
    }
  }

  shot(ev) {
    const shooter = this.meshes.get(ev.a);
    let from = new THREE.Vector3(ev.x, ev.k === 'turret' ? 1.3 : ev.k === 'tank' ? 1.4 : 1.0, ev.z);
    if (shooter) {
      shooter.kick = 1;
      shooter.aimW = 1;
      shooter.recoil = 1;
      shooter.root.updateMatrixWorld(true);
      if (this.muzzleOf(shooter, _v)) from = _v.clone();
    }
    const muzzled = !!(shooter && (shooter.muzzle || shooter.weapon));
    const to = new THREE.Vector3(ev.tx, 0.9, ev.tz);
    const dir = to.clone().sub(from);
    const len = dir.length();
    dir.normalize();
    if (!muzzled) from.addScaledVector(dir, Math.min(ev.k === 'tank' ? 2.0 : 0.6, len * 0.3));
    if (muzzled && ev.k !== 'worker') this.explosion(from.x, from.z, ev.k === 'tank' ? 0.7 : 0.3, 0xfff1a8, 0.08, from.y);
    to.addScaledVector(dir, -Math.min(ev.tr || 0.5, len * 0.3) * 0.6);
    if (ev.k === 'tank') {
      const shell = new THREE.Mesh(this.fxGeo.sphere, new THREE.MeshBasicMaterial({ color: 0xffb347 }));
      shell.scale.setScalar(0.25);
      this.addFx(shell, 0.28, (m, t) => {
        m.position.lerpVectors(from, to, t);
        m.position.y += Math.sin(t * Math.PI) * 1.2;
        if (t >= 1) this.explosion(to.x, to.z, 1.6, 0xffa94d);
      });
      return;
    }
    if (ev.k === 'soldier' || ev.k === 'worker') {
      this.explosion(to.x, to.z, 0.35, 0xfff1a8, 0.12);
      if (ev.k === 'worker') return;
    }
    const color = ev.k === 'ranger' ? 0x67e8f9 : ev.k === 'turret' ? 0xfde047 : 0xfff7c2;
    const beam = new THREE.Mesh(this.fxGeo.box, new THREE.MeshBasicMaterial({ color, transparent: true }));
    const l = from.distanceTo(to);
    beam.scale.set(0.08, 0.08, l);
    beam.position.copy(from).lerp(to, 0.5);
    beam.lookAt(to);
    this.addFx(beam, ev.k === 'ranger' ? 0.15 : 0.08, (m, t) => { m.material.opacity = 1 - t; });
  }

  explosion(x, z, size, color = 0xff8c42, life = 0.45, y = size * 0.4) {
    const m = new THREE.Mesh(this.fxGeo.sphere, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
    m.position.set(x, y, z);
    this.addFx(m, life, (mm, t) => {
      mm.scale.setScalar(size * (0.3 + t));
      mm.material.opacity = 1 - t;
    });
  }

  death(ev) {
    const T = TYPES[ev.k];
    if (!T || T.kind === 'resource') return;
    const big = T.kind === 'building' ? T.radius * 1.4 : ev.k === 'tank' ? 2.4 : 1.2;
    this.explosion(ev.x, ev.z, big, 0xff7a2f, T.kind === 'building' ? 0.9 : 0.5);
    this.explosion(ev.x, ev.z, big * 0.6, 0xffe08a, 0.3);
  }

  marker(x, z, color = 0x4ade80) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
    m.position.set(x, 0.08, z);
    this.addFx(m, 0.45, (mm, t) => { mm.scale.setScalar(1.2 * (1 - t) + 0.2); mm.material.opacity = 1 - t; });
  }

  // ---------- build placement ghost ----------

  setGhost(kind) {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
    if (!kind) return;
    const inst = instantiate(kind, -1);
    const g = inst ? inst.object : BUILDERS[kind](TEAM[0]);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.45, depthWrite: false });
    g.traverse((m) => { if (m.isMesh) m.material = mat; });
    g.userData.mat = mat;
    this.ghost = g;
    this.scene.add(g);
  }
  moveGhost(x, z, ok) {
    if (!this.ghost) return;
    this.ghost.position.set(x, 0, z);
    this.ghost.userData.mat.color.setHex(ok ? 0x4ade80 : 0xef4444);
  }
}
