// Loads the Meshy models once, normalizes their size/orientation and hands out per-entity clones.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { TEAM_COLORS } from './config.js';

// h: target height / w: largest footprint side, in world units; yaw fixes the model's facing to +z.
// muzzle: barrel tip in the barrel mesh's own coordinates (for recoil models).
const MODELS = {
  worker: { h: 1.5, yaw: 0 },
  soldier: { h: 2.0, yaw: 0, rigged: true, weapon: 'rifle' },
  ranger: { h: 2.0, yaw: 0, rigged: true, weapon: 'sniper' },
  tank: { w: 3.3, yaw: Math.PI / 2, muzzle: [-0.49, 0.145, 0] },
  hq: { w: 7.4, yaw: 0 },
  barracks: { w: 5.6, yaw: 0 },
  turret: { w: 2.9, yaw: Math.PI / 2, muzzle: [-0.49, 0.255, 0] },
  crystal: { w: 2.8, yaw: 0, neutral: true },
  rock: { w: 4.6, yaw: 0, neutral: true },
  rifle: { w: 1.0, yaw: 0, prop: true },
  sniper: { w: 1.45, yaw: 0, prop: true },
};

// Points on each weapon as [height above its bottom, distance along it from its centre (+ = muzzle side)].
const WEAPONS = {
  rifle: { grip: [0.12, -0.15], fore: [0.2, 0.15], muzzle: [0.3, 0.5] },
  sniper: { grip: [0.08, -0.29], fore: [0.18, 0.07], muzzle: [0.24, 0.72] },
};

const loaded = {}; // type -> { template, clips }
const teamMats = new Map(); // `${uuid}:${team}` -> material

export async function loadAssets(onProgress) {
  const loader = new GLTFLoader();
  const base = new URL('../assets/models/', import.meta.url);
  const types = Object.keys(MODELS);
  let done = 0;
  await Promise.all(types.map(async (type) => {
    try {
      const gltf = await loader.loadAsync(new URL(type + '.glb', base).href);
      const clips = { walk: gltf.animations[0] };
      if (MODELS[type].rigged) {
        const run = await loader.loadAsync(new URL(type + '_run.glb', base).href);
        clips.run = inPlace(run.animations[0]);
      }
      loaded[type] = { template: normalize(gltf.scene, MODELS[type]), clips };
    } catch (err) {
      console.warn('Model failed, using placeholder:', type, err);
    }
    onProgress?.(++done / types.length);
  }));
}

// The unit's position comes from the simulation, so strip any forward drift from the hips (keep the bounce).
function inPlace(clip) {
  for (const t of clip.tracks) {
    if (!/Hips\.position$/.test(t.name)) continue;
    for (let i = 0; i < t.values.length; i += 3) { t.values[i] = t.values[0]; t.values[i + 2] = t.values[2]; }
  }
  return clip;
}

// Wraps the model in a group whose origin is at the bottom centre, scaled to the configured size.
function normalize(scene, cfg) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const s = cfg.h ? cfg.h / size.y : cfg.w / Math.max(size.x, size.z);
  const center = box.getCenter(new THREE.Vector3());
  scene.position.set(-center.x, -box.min.y, -center.z);
  const inner = new THREE.Group();
  inner.add(scene);
  inner.scale.setScalar(s);
  inner.rotation.y = cfg.yaw;
  scene.traverse((m) => {
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    if (m.material) { m.material.metalness = 0; m.material.roughness = Math.max(0.55, m.material.roughness ?? 1); }
  });
  if (cfg.muzzle) {
    const barrel = scene.getObjectByName('barrel');
    if (barrel) {
      const muzzle = new THREE.Object3D();
      muzzle.name = 'muzzle';
      muzzle.position.fromArray(cfg.muzzle);
      barrel.add(muzzle);
    }
  }
  const outer = new THREE.Group();
  outer.add(inner);
  return outer;
}

// The concept art paints team accents blue; recolor steel-blue texels to the team colour.
function teamMaterial(mat, team) {
  const key = mat.uuid + ':' + team;
  let m = teamMats.get(key);
  if (m) return m;
  m = mat.clone();
  const color = new THREE.Color(TEAM_COLORS[team]);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.teamColor = { value: color };
    shader.fragmentShader = 'uniform vec3 teamColor;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      vec3 srgb = sqrt(diffuseColor.rgb); // close enough to sRGB for a hue test
      // Steel-blue accents: blue clearly above green and red. Cyan glows (green ~ blue) are left alone.
      float tm = smoothstep(0.05, 0.11, srgb.b - srgb.g) * smoothstep(0.12, 0.22, srgb.b - srgb.r);
      float lum = dot(srgb, vec3(0.3, 0.59, 0.11));
      diffuseColor.rgb = mix(diffuseColor.rgb, teamColor * (0.35 + lum * 1.5), tm);`);
  };
  m.customProgramCacheKey = () => 'team' + team;
  teamMats.set(key, m);
  return m;
}

function tint(object, team) {
  object.traverse((m) => { if (m.isMesh) m.material = teamMaterial(m.material, team); });
}

// Returns { object, mixer?, actions?, bones?, weapon?, barrel?, muzzle?, cargo? } for one entity.
export function instantiate(type, team) {
  const L = loaded[type];
  if (!L) return null;
  const cfg = MODELS[type];
  const object = cfg.rigged ? SkeletonUtils.clone(L.template) : L.template.clone(true);
  if (!cfg.neutral && !cfg.prop && team >= 0) tint(object, team);
  const inst = { object };
  if (cfg.muzzle) {
    inst.barrel = object.getObjectByName('barrel');
    inst.muzzle = object.getObjectByName('muzzle');
    if (inst.barrel) inst.barrelRest = inst.barrel.position.clone();
  }
  if (type === 'worker' && loaded.crystal) {
    // A small crystal held in the claws while carrying cargo back to base.
    const c = loaded.crystal.template.clone(true);
    c.scale.setScalar(0.32);
    c.position.set(0, 0.2, 0.78);
    c.visible = false;
    object.add(c);
    inst.cargo = c;
  }
  if (cfg.rigged) {
    const mixer = new THREE.AnimationMixer(object);
    inst.mixer = mixer;
    inst.actions = { run: mixer.clipAction(L.clips.run || L.clips.walk) };
    inst.actions.run.play();
    inst.rest = []; // bind pose, restored when the unit stands still
    object.traverse((b) => { if (b.isBone) inst.rest.push([b, b.position.clone(), b.quaternion.clone()]); });
    inst.bones = {};
    for (const n of ['RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand']) inst.bones[n] = object.getObjectByName(n);
    inst.handRest = new Map(inst.rest.filter(([b]) => /Hand$/.test(b.name)).map(([b, , q]) => [b, q]));
    if (cfg.weapon && loaded[cfg.weapon]) {
      // The weapon is placed on the root every frame (see Renderer.poseRifleman); its pivot is the grip.
      const W = WEAPONS[cfg.weapon];
      const w = loaded[cfg.weapon].template.clone(true);
      tint(w, team);
      w.rotation.y = Math.PI / 2; // muzzle along the pivot's forward (+z)
      w.position.set(0, -W.grip[0], -W.grip[1]);
      const pivot = new THREE.Group();
      pivot.add(w);
      object.add(pivot);
      const at = (p) => new THREE.Vector3(0, p[0] - W.grip[0], p[1] - W.grip[1]);
      inst.weapon = pivot;
      inst.fore = at(W.fore);
      inst.muzzlePt = at(W.muzzle);
    }
  }
  return inst;
}
