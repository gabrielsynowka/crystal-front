// Classic fog of war, computed on each client from its own units' sight.
// Grid cells are 1 world unit: 0 = never seen, 1 = explored, 2 = in sight right now.
import * as THREE from 'three';
import { MAP_SIZE, TYPES } from './config.js';

const N = MAP_SIZE;
const HALF = MAP_SIZE / 2;
const SHADE = { 0: 0, 1: 110, 2: 255 }; // texture brightness per state

export class Fog {
  constructor(localId) {
    this.localId = localId;
    this.state = new Uint8Array(N * N);
    this.pixels = new Uint8Array(N * N);
    this.tex = new THREE.DataTexture(this.pixels, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.revealAll = false; // spectating after the game is decided
    this.canvas = document.createElement('canvas'); // minimap overlay
    this.canvas.width = this.canvas.height = N;
    this.ctx2d = this.canvas.getContext('2d');
    this.img = this.ctx2d.createImageData(N, N);
  }

  cell(x, z) {
    const i = Math.floor(x + HALF), j = Math.floor(z + HALF);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i;
  }
  visible(x, z) { if (this.revealAll) return true; const c = this.cell(x, z); return c >= 0 && this.state[c] === 2; }
  explored(x, z) { if (this.revealAll) return true; const c = this.cell(x, z); return c >= 0 && this.state[c] > 0; }

  // Whether an entity should be drawn: own always; enemy units only in sight; buildings/resources once explored.
  shows(e) {
    if (e.owner === this.localId || this.revealAll) return true;
    return TYPES[e.type].kind === 'unit' ? this.visible(e.x, e.z) : this.explored(e.x, e.z);
  }

  update(view) {
    const st = this.state;
    for (let i = 0; i < st.length; i++) if (st[i] === 2) st[i] = 1;
    for (const e of view.ents.values()) {
      if (e.owner !== this.localId) continue;
      const T = TYPES[e.type];
      if (T.kind === 'building' && e.a < 1) continue; // construction sites don't see yet
      const r = T.sight || 8;
      const ci = Math.floor(e.x + HALF), cj = Math.floor(e.z + HALF);
      for (let dj = -r; dj <= r; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= N) continue;
        const w = Math.floor(Math.sqrt(r * r - dj * dj));
        for (let i = Math.max(0, ci - w); i <= Math.min(N - 1, ci + w); i++) st[j * N + i] = 2;
      }
    }
    const px = this.pixels, data = this.img.data, tmp = (this.tmp ||= new Uint8Array(N * N));
    for (let i = 0; i < st.length; i++) tmp[i] = this.revealAll ? 255 : SHADE[st[i]];
    // Two-pass 5-tap blur so the fog edge is soft instead of stepped.
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += tmp[j * N + Math.min(N - 1, Math.max(0, i + k))];
      px[j * N + i] = s / 5;
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += px[Math.min(N - 1, Math.max(0, j + k)) * N + i];
      tmp[j * N + i] = s / 5;
    }
    for (let i = 0; i < st.length; i++) {
      px[i] = tmp[i];
      data[i * 4 + 3] = 255 - tmp[i]; // minimap: dark where unseen
    }
    this.tex.needsUpdate = true;
    this.ctx2d.putImageData(this.img, 0, 0);
  }
}

// Darkens any lit material by the fog texture at the fragment's world position.
export const fogUniforms = { fogTex: { value: null } };

export function applyFog(mat) {
  if (!mat || mat.userData.fog || !mat.isMeshStandardMaterial) return;
  mat.userData.fog = true;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.fogTex = fogUniforms.fogTex;
    shader.vertexShader = 'varying vec2 vFogXZ;\n' + shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vFogXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = `uniform sampler2D fogTex;\nvarying vec2 vFogXZ;\n` + shader.fragmentShader.replace('#include <dithering_fragment>',
      `#include <dithering_fragment>
  float fogV = texture2D(fogTex, (vFogXZ + ${HALF.toFixed(1)}) / ${MAP_SIZE.toFixed(1)}).r;
  gl_FragColor.rgb = mix(vec3(0.03, 0.025, 0.07), gl_FragColor.rgb, fogV);`);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|fog';
  mat.needsUpdate = true;
}
