// HUD: resources, selection panel, command card, minimap, messages, end screen.
import { TYPES, TYPE_LIST, TEAM_COLORS, MAP_SIZE, POP_CAP, BUILDABLE } from './config.js';

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const $ = (id) => document.getElementById(id);

export class UI {
  constructor({ view, renderer, send }) {
    this.view = view;
    this.r = renderer;
    this.send = send;
    this.input = null; // set after Input is created
    this.buttons = [];
    this.msgTimer = 0;
    this.panelTimer = 0;
    this.ended = false;

    this.mini = $('minimap');
    this.mctx = this.mini.getContext('2d');
    this.mini.addEventListener('mousedown', (e) => this.onMinimap(e));
    this.mini.addEventListener('mousemove', (e) => { if (e.buttons & 1) this.onMinimap(e); });
    this.mini.addEventListener('contextmenu', (e) => e.preventDefault());
    $('panel').addEventListener('click', (e) => {
      const q = e.target.closest('[data-cancel]');
      if (q) this.send({ t: 'cancel', id: +q.dataset.cancel });
      const s = e.target.closest('[data-sel]');
      if (s) this.input.select([+s.dataset.sel]);
    });
    $('hud').classList.remove('hidden');
  }

  // ---------- command card ----------

  refresh() {
    const inp = this.input;
    const sel = inp.mySelected();
    const units = sel.filter((e) => TYPES[e.type].kind === 'unit');
    const btns = [];
    if (units.length) {
      if (units.some((u) => u.type === 'worker')) {
        for (const kind of BUILDABLE) {
          const T = TYPES[kind];
          btns.push({ key: T.hotkey, label: 'Build ' + T.name, cost: T.cost, run: () => inp.setMode({ place: kind }) });
        }
      }
      btns.push({ key: 'A', label: 'Attack-move', run: () => inp.setMode('amove') });
      btns.push({ key: 'S', label: 'Stop', run: () => this.send({ t: 'stop', ids: units.map((u) => u.id) }) });
    } else if (sel.length) {
      const type = sel[0].type;
      const same = sel.filter((e) => e.type === type);
      if (same[0].a < 1) {
        btns.push({ key: 'X', label: 'Cancel construction', run: () => same.forEach((b) => this.send({ t: 'cancel', id: b.id })) });
      } else {
        for (const kind of TYPES[type].trains || []) {
          const T = TYPES[kind];
          btns.push({
            key: T.hotkey, label: T.name, cost: T.cost, kind,
            run: () => {
              const ready = same.filter((b) => b.a >= 1);
              if (!ready.length) return;
              ready.sort((a, b) => (a.q ? a.q.length : 0) - (b.q ? b.q.length : 0));
              this.send({ t: 'train', id: ready[0].id, kind });
            },
          });
        }
      }
    }
    this.buttons = btns;
    const card = $('commands');
    card.innerHTML = '';
    for (const b of btns) {
      const el = document.createElement('button');
      el.className = 'cmd';
      el.innerHTML = `<span class="hk">${b.key}</span><span class="lbl">${b.label}</span>${b.cost ? `<span class="cost">◆ ${b.cost}</span>` : ''}`;
      el.addEventListener('click', b.run);
      b.el = el;
      card.appendChild(el);
    }
    this.panelTimer = 0;
  }

  hotkey(key) {
    const b = this.buttons.find((x) => x.key === key);
    if (b) b.run();
  }

  // ---------- messages ----------

  message(text, color = '#fde68a') {
    const el = $('message');
    el.textContent = text;
    el.style.color = color;
    el.style.opacity = 1;
    this.msgTimer = 2.5;
  }

  toggleHelp() { $('help').classList.toggle('hidden'); }

  onEvent(ev) {
    const me = this.view.localId;
    if (ev.e === 'left') { this.message(`${ev.name.replace(' (bot)', '')} left — a bot takes over`, '#c4b5fd'); return; }
    if (ev.e === 'elim' && ev.o !== me && this.view.players[ev.o]) { this.message(`${this.view.players[ev.o].name} has been eliminated`, '#c4b5fd'); return; }
    if (ev.o !== me) return;
    if (ev.e === 'err') this.message(ev.msg, '#fca5a5');
    else if (ev.e === 'alert') this.message('We are under attack!', '#f87171');
    else if (ev.e === 'built') this.message(`${TYPES[ev.k].name} complete`, '#86efac');
    else if (ev.e === 'elim') this.message('Our HQ has been destroyed', '#f87171');
  }

  // ---------- per frame ----------

  update(dt) {
    const v = this.view, me = v.me;
    if (!me) return;
    $('crystals').textContent = me.c;
    $('pop').textContent = `${me.pop} / ${POP_CAP}`;
    const secs = Math.floor(v.tick / 20);
    $('clock').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    for (const b of this.buttons) if (b.el) b.el.classList.toggle('disabled', !!b.cost && me.c < b.cost);

    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0.5) $('message').style.opacity = Math.max(0, this.msgTimer / 0.5);
    }
    this.panelTimer -= dt;
    if (this.panelTimer <= 0) { this.panelTimer = 0.1; this.drawPanel(); }
    this.drawMinimap();
    this.checkEnd();
  }

  drawPanel() {
    const sel = [...this.input.selected].map((id) => this.view.ents.get(id)).filter(Boolean);
    const panel = $('panel');
    if (!sel.length) { panel.innerHTML = '<div class="hint">Left-click or drag to select · Right-click to order · F1 for controls</div>'; return; }
    const bar = (f) => `<div class="hpbar"><div style="width:${Math.max(0, Math.min(1, f)) * 100}%;background:${f > 0.6 ? '#4ade80' : f > 0.3 ? '#facc15' : '#ef4444'}"></div></div>`;
    if (sel.length === 1) {
      const e = sel[0], T = TYPES[e.type];
      const owner = e.owner >= 0 ? this.view.players[e.owner] : null;
      let html = `<div class="title"><span class="swatch" style="background:${owner ? hex(TEAM_COLORS[e.owner]) : '#9ca3af'}"></span>${T.name}${owner ? ` <small>· ${owner.name}</small>` : ''}</div>`;
      if (T.kind === 'resource') html += `<div class="stat">◆ ${e.hp} crystals left</div>`;
      else html += `${bar(e.hp / T.hp)}<div class="stat">${e.hp} / ${T.hp} HP${T.dmg ? ` · ${T.dmg} dmg · range ${T.range}` : ''}</div>`;
      if (T.kind === 'unit' && e.a > 0) html += `<div class="stat">Carrying ◆ ${e.a}</div>`;
      if (T.kind === 'building' && e.a < 1) html += `<div class="stat">Under construction ${Math.floor(e.a * 100)}%</div>${bar(e.a)}`;
      if (T.kind === 'building' && e.q && e.q.length) {
        html += '<div class="queue">' + e.q.map((ti, i) =>
          `<div class="qi" data-cancel="${e.owner === this.view.localId ? e.id : ''}" title="Click to cancel">${TYPES[TYPE_LIST[ti]].name.split(' ').pop()}${i === 0 ? `<div class="qp" style="width:${e.b * 100}%"></div>` : ''}</div>`).join('') + '</div>';
      }
      panel.innerHTML = html;
      return;
    }
    const counts = {};
    for (const e of sel) counts[e.type] = (counts[e.type] || 0) + 1;
    panel.innerHTML = `<div class="title">${sel.length} selected</div><div class="multi">` +
      sel.slice(0, 24).map((e) => `<div class="mi" data-sel="${e.id}">${TYPES[e.type].name.split(' ').pop().slice(0, 4)}${bar(e.hp / TYPES[e.type].hp)}</div>`).join('') + '</div>';
  }

  // Minimap is rotated to match the camera, so "up" on it is "up" on screen.
  miniXform() {
    const W = this.mini.width, s = (W / Math.SQRT2) / MAP_SIZE * 0.98;
    const f = this.r.forward, rt = this.r.right;
    return {
      to: (x, z) => [W / 2 + (x * rt.x + z * rt.y) * s, W / 2 - (x * f.x + z * f.y) * s],
      from: (px, py) => {
        const a = (px - W / 2) / s, b = -(py - W / 2) / s;
        return { x: rt.x * a + f.x * b, z: rt.y * a + f.y * b };
      },
    };
  }

  drawMinimap() {
    const g = this.mctx, W = this.mini.width, xf = this.miniXform(), H = MAP_SIZE / 2;
    g.clearRect(0, 0, W, W);
    g.fillStyle = '#b97c45';
    g.beginPath();
    [[-H, -H], [H, -H], [H, H], [-H, H]].forEach(([x, z], i) => { const [px, py] = xf.to(x, z); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.closePath(); g.fill();
    for (const e of this.view.ents.values()) {
      const T = TYPES[e.type];
      const [px, py] = xf.to(e.x, e.z);
      let size = T.kind === 'building' ? 5 : T.kind === 'unit' ? 2.5 : 3;
      g.fillStyle = e.type === 'crystal' ? '#5eead4' : e.type === 'rock' ? '#6b6560' : hex(TEAM_COLORS[e.owner]);
      if (e.type === 'rock') size = 5;
      g.fillRect(px - size / 2, py - size / 2, size, size);
    }
    const c = this.r.viewCorners();
    if (c.length === 4) {
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1.2;
      g.beginPath();
      c.forEach((p, i) => { const [px, py] = xf.to(p.x, p.z); i ? g.lineTo(px, py) : g.moveTo(px, py); });
      g.closePath(); g.stroke();
    }
  }

  onMinimap(e) {
    const rect = this.mini.getBoundingClientRect();
    const p = this.miniXform().from((e.clientX - rect.left) * (this.mini.width / rect.width), (e.clientY - rect.top) * (this.mini.height / rect.height));
    if (e.button === 2) this.input.order(p, false);
    else this.r.centerOn(p.x, p.z);
  }

  checkEnd() {
    if (this.ended) return;
    const v = this.view, me = v.me;
    let text = null;
    if (!me.alive) text = 'DEFEAT';
    else if (v.over && v.winner === v.localId) text = 'VICTORY';
    if (text) this.showEnd(text, text === 'VICTORY');
  }

  showEnd(text, win) {
    this.ended = true;
    $('endtitle').textContent = text;
    $('endtitle').className = win ? 'win' : 'lose';
    $('end').classList.remove('hidden');
  }
}
