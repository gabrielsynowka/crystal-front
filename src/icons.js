// Portrait icons rendered from the 3D models, for the HUD and menus.
import * as THREE from 'three';
import { instantiate } from './assets.js';

const cache = new Map(); // `${type}:${team}` -> data URL

export function renderIcons(types, team, size = 160) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff3e0, 0x4c3d6b, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-3, 6, 5);
  scene.add(sun);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  for (const type of types) {
    const inst = instantiate(type, team);
    if (!inst) continue;
    const obj = inst.object;
    obj.rotation.y = -0.6; // three-quarter view
    if (inst.weapon) {
      // Rest the rifle across the body; the in-game pose is solved per frame and isn't available here.
      obj.updateMatrixWorld(true);
      const hand = inst.bones.RightHand.getWorldPosition(new THREE.Vector3());
      inst.weapon.position.copy(obj.worldToLocal(hand)).add(new THREE.Vector3(0.1, 0, 0.1));
      inst.weapon.rotation.set(0.6, 0.5, 0);
    }
    if (inst.cargo) inst.cargo.visible = false;
    scene.add(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = sphere.radius * 0.92;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r });
    cam.updateProjectionMatrix();
    cam.position.copy(sphere.center).add(new THREE.Vector3(0, 0.45, 1).normalize().multiplyScalar(sphere.radius * 4));
    cam.lookAt(sphere.center);
    renderer.render(scene, cam);
    cache.set(type + ':' + team, renderer.domElement.toDataURL('image/png'));
    scene.remove(obj);
  }
  renderer.dispose();
  renderer.forceContextLoss();
}

export function icon(type, team) { return cache.get(type + ':' + team) || ''; }
