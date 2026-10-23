// HUD: resources, selection panel, command card, minimap, messages, end screen.
import { TYPES, TYPE_LIST, TEAM_COLORS, MAP_SIZE, POP_CAP, BUILDABLE } from './config.js';
import { audio } from './audio.js';
import { icon } from './icons.js';

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const $ = (id) => document.getElementById(id);
const short = (type) => TYPES[type].name.split(' ').pop();

// Line icons for commands that have no model.
const GLYPH = {
  amove: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  cancel: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

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
    $('mute').textContent = audio.muted ? '🔇' : '🔊';
    $('mute').addEventListener('click', () => this.toggleMute());
    $('gemicon').src = icon('crystal', -1);
    $('popicon').src = icon('soldier', view.localId);
  }

  img(type, team = this.view.localId) {
    const src = icon(type, TYPES[type].kind === 'resource' || TYPES[type].kind === 'prop' ? -1 : team);
    return src ? `<img src="${src}" alt="">` : `<span class="noimg">${short(type).slice(0, 2)}</span>`;
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
          btns.push({ key: T.hotkey, label: short(kind), icon: kind, cost: T.cost, run: () => inp.setMode({ place: kind }) });
        }
      }
      btns.push({ key: 'A', label: 'Attack', glyph: 'amove', run: () => inp.setMode('amove') });
      btns.push({ key: 'S', label: 'Stop', glyph: 'stop', run: () => this.send({ t: 'stop', ids: units.map((u) => u.id) }) });
    } else if (sel.length) {
      const type = sel[0].type;
      const same = sel.filter((e) => e.type === type);
      if (same[0].a < 1) {
        btns.push({ key: 'X', label: 'Cancel', glyph: 'cancel', run: () => same.forEach((b) => this.send({ t: 'cancel', id: b.id })) });
      } else {
        for (const kind of TYPES[type].trains || []) {
          const T = TYPES[kind];
          btns.push({
            key: T.hotkey, label: short(kind), icon: kind, cost: T.cost, kind,
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
      el.title = b.label;
      el.innerHTML = `<span class="ic">${b.icon ? this.img(b.icon) : GLYPH[b.glyph]}</span><span class="hk">${b.key}</span>` +
        `<span class="lbl">${b.label}</span>${b.cost ? `<span class="cost"><i></i>${b.cost}</span>` : ''}`;
      el.addEventListener('click', () => { audio.play('click', { vol: 0.4 }); b.run(); });
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

  toggleMute() {
    audio.setMuted(!audio.muted);
    $('mute').textContent = audio.muted ? '🔇' : '🔊';
  }

  onEvent(ev) {
    const me = this.view.localId;
    if (ev.e === 'left') { this.message(`${ev.name.replace(' (bot)', '')} left — a bot takes over`, '#c4b5fd'); return; }
    if (ev.e === 'elim' && ev.o !== me && this.view.players[ev.o]) { this.message(`${this.view.players[ev.o].name} has been eliminated`, '#c4b5fd'); return; }
    if (ev.o !== me) return;
    if (ev.e === 'err') {
      this.message(ev.msg, '#fca5a5');
      audio.voice(ev.msg.startsWith('Not enough') ? 'nocrystals' : ev.msg.startsWith('Population') ? 'popcap' : '');
    } else if (ev.e === 'alert') { this.message('We are under attack!', '#f87171'); audio.voice('attack'); }
    else if (ev.e === 'built') { this.message(`${TYPES[ev.k].name} complete`, '#86efac'); audio.voice('built'); }
    else if (ev.e === 'trained') audio.voice('unit_ready');
    else if (ev.e === 'place') audio.at('place', ev.x, ev.z, { vol: 0.7 });
    else if (ev.e === 'ack') {
      if (ev.k === 'gather') audio.play('mine', { vol: 0.5 });
      else audio.ack(ev.k === 'move' ? 'move' : 'attack');
    }
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
    if (!sel.length) { panel.innerHTML = '<div class="hint">Select units or buildings<br><small>Right-click to order · Shift to queue · F1 controls</small></div>'; return; }
    const bar = (f, cls = '') => {
      f = Math.max(0, Math.min(1, f));
      return `<div class="bar ${cls}"><div style="width:${f * 100}%" class="${cls ? '' : f > 0.6 ? 'ok' : f > 0.3 ? 'mid' : 'low'}"></div></div>`;
    };
    if (sel.length === 1) {
      const e = sel[0], T = TYPES[e.type];
      const owner = e.owner >= 0 ? this.view.players[e.owner] : null;
      const team = owner ? hex(TEAM_COLORS[e.owner]) : '#9ca3af';
      let info = `<div class="title">${T.name}</div><div class="owner"><span class="swatch" style="background:${team}"></span>${owner ? owner.name : 'Neutral'}</div>`;
      const chips = [];
      if (T.kind === 'resource') {
        if (e.type === 'crystal') {
          info += bar(e.hp / T.amount, 'gem');
          chips.push(`${e.hp} crystals`, `Miners ${e.a}/2`);
          if (e.b) chips.push(`<span class="warn">${e.b} queued</span>`);
        }
      } else {
        info += bar(e.hp / T.hp);
        chips.push(`${e.hp}/${T.hp} HP`);
        if (T.dmg) chips.push(`${T.dmg} dmg`, `range ${T.range}`);
        if (T.kind === 'unit' && e.a > 0) chips.push(`<span class="gemtxt">carrying ${e.a}</span>`);
        if (e.type === 'worker' && e.b === 4) chips.push('<span class="warn">waiting for a free slot</span>');
        if (T.kind === 'building' && e.a < 1) chips.push(`building ${Math.floor(e.a * 100)}%`);
      }
      info += `<div class="chips">${chips.map((c) => `<span>${c}</span>`).join('')}</div>`;
      if (T.kind === 'building' && e.q && e.q.length) {
        const mine = e.owner === this.view.localId;
        info += '<div class="queue">' + e.q.map((ti, i) =>
          `<div class="qi" data-cancel="${mine ? e.id : ''}" title="Click to cancel">${this.img(TYPE_LIST[ti], e.owner)}${i === 0 ? `<div class="qp" style="width:${e.b * 100}%"></div>` : ''}</div>`).join('') + '</div>';
      }
      panel.innerHTML = `<div class="portrait" style="--team:${team}">${this.img(e.type, e.owner)}</div><div class="info">${info}</div>`;
      return;
    }
    panel.innerHTML = `<div class="info wide"><div class="title">${sel.length} selected</div><div class="multi">` +
      sel.slice(0, 24).map((e) => `<div class="mi" data-sel="${e.id}">${this.img(e.type, e.owner)}${bar(e.hp / TYPES[e.type].hp)}</div>`).join('') + '</div></div>';
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
    g.fillStyle = '#c4874c';
    g.beginPath();
    [[-H, -H], [H, -H], [H, H], [-H, H]].forEach(([x, z], i) => { const [px, py] = xf.to(x, z); i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.closePath(); g.fill();
    const fog = this.r.fog;
    for (const e of this.view.ents.values()) {
      if (!fog.shows(e)) continue;
      const T = TYPES[e.type];
      const [px, py] = xf.to(e.x, e.z);
      let size = T.kind === 'building' ? 5 : T.kind === 'unit' ? 2.5 : 3;
      g.fillStyle = e.type === 'crystal' ? '#5eead4' : e.type === 'rock' ? '#6b6560' : hex(TEAM_COLORS[e.owner]);
      if (e.type === 'rock') size = 5;
      g.fillRect(px - size / 2, py - size / 2, size, size);
    }
    // Fog overlay: the fog grid image mapped through the same rotated world->minimap transform.
    if (!fog.revealAll) {
      const W2 = W / 2, sc = (W / Math.SQRT2) / MAP_SIZE * 0.98, f = this.r.forward, rt = this.r.right;
      g.save();
      g.setTransform(rt.x * sc, -f.x * sc, rt.y * sc, -f.y * sc, W2 - H * (rt.x + rt.y) * sc, W2 + H * (f.x + f.y) * sc);
      g.drawImage(fog.canvas, 0, 0);
      g.restore();
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
    if (e.button === 2) this.input.order(p, false, e.shiftKey);
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
    if (text === 'VICTORY' || text === 'DEFEAT') audio.voice(win ? 'victory' : 'defeat');
    $('endtitle').textContent = text;
    $('endtitle').className = win ? 'win' : 'lose';
    $('end').classList.remove('hidden');
  }
}
