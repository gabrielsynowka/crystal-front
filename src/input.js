// Mouse/keyboard controls: camera, selection, orders, build placement, control groups.
import { TYPES } from './config.js';
import { canPlace } from './sim.js';
import { audio } from './audio.js';

export class Input {
  constructor({ renderer, view, send, ui }) {
    this.r = renderer;
    this.view = view;
    this.send = send;
    this.ui = ui;
    this.selected = new Set();
    this.mode = null;        // null | 'amove' | { place: kind }
    this.keys = new Set();
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, inside: true };
    this.drag = null;
    this.groups = {};
    this.lastClick = { t: 0, id: 0 };
    this.lastGroup = { t: 0, n: -1 };
    this.selbox = document.getElementById('selbox');

    const c = renderer.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    document.addEventListener('mouseleave', () => { this.mouse.inside = false; });
    document.addEventListener('mouseenter', () => { this.mouse.inside = true; });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.r.zoom(Math.sign(e.deltaY) * 0.1); }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ---------- helpers ----------

  mySelected() {
    return [...this.selected].map((id) => this.view.ents.get(id)).filter((e) => e && e.owner === this.view.localId);
  }
  myUnits() { return this.mySelected().filter((e) => TYPES[e.type].kind === 'unit'); }

  pick(p) {
    let best = null, bs = Infinity;
    for (const e of this.view.ents.values()) {
      const T = TYPES[e.type];
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      const reach = T.radius + (T.kind === 'unit' ? 0.6 : 0.2);
      if (d > reach) continue;
      const score = d / reach + (T.kind === 'unit' ? 0 : 0.5);
      if (score < bs) { bs = score; best = e; }
    }
    return best;
  }

  select(ids, add = false) {
    if (!add) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.ui.refresh();
    if (ids.length) {
      audio.play('click', { vol: 0.35 });
      if (this.myUnits().some((u) => u.type !== 'worker')) audio.ack('select');
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.r.setGhost(mode && mode.place ? mode.place : null);
    document.body.classList.toggle('targeting', mode === 'amove');
  }

  // ---------- mouse ----------

  onDown(e) {
    if (this.view.over && !this.view.me?.alive) return;
    const p = this.r.screenToGround(e.clientX, e.clientY);
    if (!p) return;
    if (e.button === 0) {
      if (this.mode && this.mode.place) { this.placeBuilding(p, e.shiftKey); return; }
      if (this.mode === 'amove') { this.order(p, true); if (!e.shiftKey) this.setMode(null); return; }
      this.drag = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    } else if (e.button === 2) {
      if (this.mode) { this.setMode(null); return; }
      this.order(p, false);
    }
  }

  onMove(e) {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.inside = true;
    if (this.drag) {
      const x = Math.min(this.drag.x, e.clientX), y = Math.min(this.drag.y, e.clientY);
      const w = Math.abs(e.clientX - this.drag.x), h = Math.abs(e.clientY - this.drag.y);
      if (w + h > 6) Object.assign(this.selbox.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    }
  }

  onUp(e) {
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.selbox.style.display = 'none';
    const me = this.view.localId;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6) {
      const x0 = Math.min(d.x, e.clientX), x1 = Math.max(d.x, e.clientX);
      const y0 = Math.min(d.y, e.clientY), y1 = Math.max(d.y, e.clientY);
      const ids = [];
      for (const ent of this.view.ents.values()) {
        if (ent.owner !== me || TYPES[ent.type].kind !== 'unit') continue;
        const s = this.r.worldToScreen(ent.x, ent.z, 0.8);
        if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) ids.push(ent.id);
      }
      if (ids.length || !d.shift) this.select(ids, d.shift);
      return;
    }
    const p = this.r.screenToGround(e.clientX, e.clientY);
    const ent = p && this.pick(p);
    if (!ent) { if (!d.shift) this.select([]); return; }
    const now = performance.now();
    if (ent.owner === me && now - this.lastClick.t < 350 && this.lastClick.id === ent.id) {
      // Double click: select all of that type on screen.
      const ids = [...this.view.ents.values()].filter((o) => o.owner === me && o.type === ent.type && this.onScreen(o)).map((o) => o.id);
      this.select(ids, d.shift);
    } else if (d.shift && ent.owner === me && this.selected.has(ent.id)) {
      this.selected.delete(ent.id); this.ui.refresh();
    } else {
      this.select([ent.id], d.shift && ent.owner === me);
    }
    this.lastClick = { t: now, id: ent.id };
  }

  onScreen(e) {
    const s = this.r.worldToScreen(e.x, e.z);
    return s.x >= 0 && s.x <= innerWidth && s.y >= 0 && s.y <= innerHeight;
  }

  // Right click (or attack-move click) on the ground at p.
  order(p, amove) {
    const me = this.view.localId;
    const units = this.myUnits();
    const ids = units.map((u) => u.id);
    const target = this.pick(p);
    if (!units.length) {
      const b = this.mySelected().find((e) => TYPES[e.type].kind === 'building');
      if (b) {
        for (const s of this.mySelected()) if (TYPES[s.type].kind === 'building') this.send({ t: 'rally', id: s.id, x: p.x, z: p.z, target: target && target.type === 'crystal' ? target.id : 0 });
        this.r.marker(p.x, p.z, 0xfacc15);
      }
      return;
    }
    if (amove) {
      this.send({ t: 'amove', ids, x: p.x, z: p.z });
      this.r.marker(p.x, p.z, 0xf87171);
      return;
    }
    if (target && target.owner >= 0 && target.owner !== me) {
      this.send({ t: 'attack', ids, target: target.id });
      this.r.marker(target.x, target.z, 0xf87171);
    } else if (target && target.type === 'crystal') {
      this.send({ t: 'gather', ids, target: target.id });
      this.r.marker(target.x, target.z, 0x2dd4bf);
    } else if (target && target.owner === me && TYPES[target.type].kind === 'building' && target.a < 1 && units.some((u) => u.type === 'worker')) {
      this.send({ t: 'build', ids, target: target.id });
      this.r.marker(target.x, target.z, 0x4ade80);
    } else if (target && target.owner === me && TYPES[target.type].dropoff && units.some((u) => u.type === 'worker' && u.a > 0)) {
      this.send({ t: 'gather', ids, target: target.id });
    } else {
      this.send({ t: 'move', ids, x: p.x, z: p.z });
      this.r.marker(p.x, p.z);
    }
  }

  placeBuilding(p, keep) {
    const kind = this.mode.place;
    const x = Math.round(p.x * 2) / 2, z = Math.round(p.z * 2) / 2;
    const workers = this.myUnits().filter((u) => u.type === 'worker');
    if (!workers.length) { this.setMode(null); return; }
    if (!canPlace(kind, x, z, this.view.ents.values())) { this.ui.message("Can't build there"); return; }
    // Send the closest worker only.
    workers.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    this.send({ t: 'build', ids: [workers[0].id], kind, x, z });
    if (!keep) this.setMode(null);
  }

  // ---------- keyboard ----------

  onKey(e) {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (/^[0-9]$/.test(k)) {
      const n = +k;
      if (e.ctrlKey) { e.preventDefault(); this.groups[n] = [...this.selected]; return; }
      const ids = (this.groups[n] || []).filter((id) => this.view.ents.has(id));
      if (!ids.length) return;
      this.select(ids);
      const now = performance.now();
      if (this.lastGroup.n === n && now - this.lastGroup.t < 400) this.centerSelection();
      this.lastGroup = { t: now, n };
      return;
    }
    if (k === 'escape') { this.setMode(null); return; }
    if (k === ' ') { e.preventDefault(); this.centerSelection(); return; }
    if (k === 'f1') { e.preventDefault(); this.ui.toggleHelp(); return; }
    if (k === 'm') { this.ui.toggleMute(); return; }
    if (k === 'tab') {
      e.preventDefault();
      const idle = [...this.view.ents.values()].filter((u) => u.owner === this.view.localId && u.type === 'worker' && u.b === 0 && !u.a);
      if (idle.length) { const w = idle[(this.idleIdx = ((this.idleIdx || 0) + 1) % idle.length)]; this.select([w.id]); this.r.centerOn(w.x, w.z); }
      return;
    }
    if (e.ctrlKey || e.altKey) return;
    this.ui.hotkey(k.toUpperCase());
  }

  centerSelection() {
    const s = this.mySelected();
    if (s.length) {
      this.r.centerOn(s.reduce((a, e) => a + e.x, 0) / s.length, s.reduce((a, e) => a + e.z, 0) / s.length);
    } else {
      const hq = [...this.view.ents.values()].find((e) => e.owner === this.view.localId && e.type === 'hq');
      if (hq) this.r.centerOn(hq.x, hq.z);
    }
  }

  // Called every frame.
  update(dt) {
    for (const id of this.selected) if (!this.view.ents.has(id)) { this.selected.delete(id); this.ui.refresh(); }
    const sp = 45 * dt;
    let dx = 0, dz = 0;
    if (this.keys.has('arrowleft')) dx -= sp;
    if (this.keys.has('arrowright')) dx += sp;
    if (this.keys.has('arrowup')) dz += sp;
    if (this.keys.has('arrowdown')) dz -= sp;
    const m = this.mouse, edge = 8;
    if (m.inside && !this.drag && document.hasFocus()) {
      if (m.x <= edge) dx -= sp;
      if (m.x >= innerWidth - edge) dx += sp;
      if (m.y <= edge) dz += sp;
      if (m.y >= innerHeight - edge) dz -= sp;
    }
    if (dx || dz) this.r.pan(dx, dz);
    if (this.mode && this.mode.place) {
      const p = this.r.screenToGround(m.x, m.y);
      if (p) {
        const x = Math.round(p.x * 2) / 2, z = Math.round(p.z * 2) / 2;
        this.r.moveGhost(x, z, canPlace(this.mode.place, x, z, this.view.ents.values()));
      }
    }
  }
}
