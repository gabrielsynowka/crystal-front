// Authoritative game simulation. Runs only on the host (or locally in single player).
// No rendering code here: clients only ever see snapshot() output.
import { TYPES, DT, MAP_SIZE, POP_CAP, START_CRYSTALS, TYPE_INDEX, BUILDABLE } from './config.js';

const HALF = MAP_SIZE / 2;
export const START_POS = [[-56, -56], [56, 56], [56, -56], [-56, 56]];
const MINERS_PER_NODE = 2;

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (v) => Math.round(v * 100) / 100;
const isUnit = (e) => TYPES[e.type].kind === 'unit';
const isBuilding = (e) => TYPES[e.type].kind === 'building';
const isObstacle = (e) => TYPES[e.type].kind !== 'unit';

// Shared with clients for the placement ghost. `ents` items need {type, x, z}.
export function canPlace(kind, x, z, ents) {
  const r = TYPES[kind].radius;
  if (Math.abs(x) > HALF - r - 2 || Math.abs(z) > HALF - r - 2) return false;
  for (const e of ents) {
    const T = TYPES[e.type];
    if (T.kind === 'unit') continue;
    const gap = T.kind === 'resource' ? 2.5 : 0.6;
    if (Math.hypot(e.x - x, e.z - z) < T.radius + r + gap) return false;
  }
  return true;
}

export class Sim {
  // playerDefs: [{ name, isBot }], index = player id = start slot
  constructor(playerDefs, seed = 1) {
    this.rand = mulberry32(seed);
    this.tick = 0;
    this.nextId = 1;
    this.ents = new Map();
    this.events = [];
    this.commands = [];
    this.over = false;
    this.winner = -1;
    this.players = playerDefs.map((p, i) => ({
      id: i, name: p.name, isBot: !!p.isBot, crystals: START_CRYSTALS, alive: true, alertTick: -999,
    }));
    this.pop = this.players.map(() => 0);
    this.genMap();
  }

  // ---------- setup ----------

  genMap() {
    const add = (type, x, z) => this.spawn(type, -1, x, z);
    for (const [cx, cz] of START_POS) {
      const out = Math.atan2(Math.sign(cz), Math.sign(cx)); // pointing into the corner
      for (let k = 0; k < 6; k++) {
        const a = out + (k - 2.5) * 0.36;
        add('crystal', cx + Math.cos(a) * 10, cz + Math.sin(a) * 10);
      }
    }
    for (const [mx, mz] of [[60, 0], [-60, 0], [0, 60], [0, -60]]) {
      for (let k = 0; k < 4; k++) {
        const a = Math.atan2(mz, mx) + (k - 1.5) * 0.5;
        add('crystal', mx + Math.cos(a) * 6, mz + Math.sin(a) * 6);
      }
    }
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      add('crystal', Math.cos(a) * 6, Math.sin(a) * 6);
    }
    // Rocks: random in one quadrant, mirrored to all four so every start is equal.
    const rocks = [];
    for (let tries = 0; rocks.length < 7 && tries < 500; tries++) {
      const x = 8 + this.rand() * 64, z = 8 + this.rand() * 64;
      if (Math.hypot(x - 56, z - 56) < 20 || Math.hypot(x, z) < 14) continue;
      if (Math.hypot(x - 60, z) < 12 || Math.hypot(x, z - 60) < 12) continue;
      if (Math.abs(x - z) < 6 && rocks.length < 2) continue; // keep the diagonal lane fairly open
      if (rocks.some(([rx, rz]) => Math.hypot(rx - x, rz - z) < 9)) continue;
      rocks.push([x, z]);
    }
    for (const [x, z] of rocks) for (const [sx, sz] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) add('rock', x * sx, z * sz);

    this.players.forEach((p, i) => {
      const [cx, cz] = START_POS[i];
      this.spawn('hq', i, cx, cz);
      for (let k = 0; k < 4; k++) {
        const w = this.spawn('worker', i, cx + Math.sign(cx) * 4.5 + (k - 1.5) * 1.2, cz + Math.sign(cz) * 4.5 - (k - 1.5) * 1.2);
        const n = this.bestCrystal(i, w.x, w.z, 30);
        if (n) w.order = { type: 'gather', node: n.id, nx: n.x, nz: n.z, phase: 'toNode', t: 0 };
      }
    });
  }

  spawn(type, owner, x, z, built = true) {
    const T = TYPES[type];
    const e = { id: this.nextId++, type, owner, x, z, rot: 0, r: T.radius, hp: T.hp || 1, maxHp: T.hp || 1 };
    if (T.kind === 'unit') { e.order = null; e.orders = []; e.cd = 0; e.carry = 0; e.moving = false; }
    if (T.kind === 'resource') { e.miners = new Set(); e.waitQ = []; }
    if (T.kind === 'building') {
      e.built = built; e.progress = built ? 1 : 0; e.queue = []; e.trainT = 0; e.rally = null; e.cd = 0; e.tgt = 0;
      if (!built) e.hp = Math.max(1, e.maxHp * 0.1);
    }
    if (T.kind === 'resource') e.amount = T.amount;
    if (T.kind === 'prop') e.rot = this.rand() * Math.PI * 2;
    this.ents.set(e.id, e);
    return e;
  }

  // ---------- commands ----------

  queueCommand(pid, cmd) { this.commands.push({ pid, cmd }); }

  apply(pid, c) {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return;
    const mine = (ids) => (ids || []).map((id) => this.ents.get(id)).filter((e) => e && e.owner === pid && isUnit(e));
    const err = (msg) => this.events.push({ e: 'err', o: pid, msg });
    const q = !!c.queue; // shift-click: append to the unit's order queue instead of replacing it
    switch (c.t) {
      case 'move':
      case 'amove':
        this.groupMove(mine(c.ids), c.x, c.z, c.t, q);
        break;
      case 'stop':
        for (const u of mine(c.ids)) { u.order = null; u.orders.length = 0; }
        break;
      case 'attack': {
        const t = this.ents.get(c.target);
        if (!t || t.owner < 0) break;
        for (const u of mine(c.ids)) this.setOrder(u, { type: 'attack', target: t.id }, q);
        this.events.push({ e: 'ack', o: pid, k: 'attack' });
        break;
      }
      case 'gather': {
        const t = this.ents.get(c.target);
        if (!t) break;
        const units = mine(c.ids);
        for (const u of units) {
          if (u.type !== 'worker') continue;
          if (t.type === 'crystal') this.setOrder(u, { type: 'gather', node: t.id, nx: t.x, nz: t.z, phase: 'toNode', t: 0 }, q);
          else if (TYPES[t.type].dropoff && t.owner === pid && u.carry > 0) {
            const n = this.ents.get(u.lastNode) || this.nearestCrystal(u.x, u.z, 30);
            this.setOrder(u, { type: 'gather', node: n ? n.id : 0, nx: n ? n.x : u.x, nz: n ? n.z : u.z, phase: 'return', t: 0 }, q);
          }
        }
        // Non-workers right-clicked onto crystals just walk there.
        const others = units.filter((u) => u.type !== 'worker');
        if (others.length) this.groupMove(others, t.x, t.z, 'move', q);
        this.events.push({ e: 'ack', o: pid, k: 'gather' });
        break;
      }
      case 'build': {
        const workers = mine(c.ids).filter((u) => u.type === 'worker');
        if (!workers.length) break;
        if (c.target) { // help finish an existing construction site
          const b = this.ents.get(c.target);
          if (b && b.owner === pid && isBuilding(b) && !b.built) for (const w of workers) this.setOrder(w, { type: 'build', target: b.id }, q);
          break;
        }
        if (!BUILDABLE.includes(c.kind)) break;
        const T = TYPES[c.kind];
        if (p.crystals < T.cost) { err('Not enough crystals'); break; }
        if (!canPlace(c.kind, c.x, c.z, this.ents.values())) { err("Can't build there"); break; }
        p.crystals -= T.cost;
        const b = this.spawn(c.kind, pid, c.x, c.z, false);
        for (const w of workers) this.setOrder(w, { type: 'build', target: b.id }, q);
        this.events.push({ e: 'place', o: pid, x: b.x, z: b.z });
        break;
      }
      case 'train': {
        const b = this.ents.get(c.id);
        if (!b || b.owner !== pid || !isBuilding(b) || !b.built) break;
        if (!(TYPES[b.type].trains || []).includes(c.kind)) break;
        const UT = TYPES[c.kind];
        if (b.queue.length >= 5) { err('Queue is full'); break; }
        if (p.crystals < UT.cost) { err('Not enough crystals'); break; }
        p.crystals -= UT.cost;
        b.queue.push(c.kind);
        break;
      }
      case 'cancel': {
        const b = this.ents.get(c.id);
        if (!b || b.owner !== pid || !isBuilding(b)) break;
        if (!b.built) { // cancelling a construction site refunds 75%
          p.crystals += TYPES[b.type].cost * 0.75;
          b.hp = 0; b.silent = true;
          break;
        }
        if (!b.queue.length) break;
        p.crystals += TYPES[b.queue.pop()].cost;
        if (!b.queue.length) b.trainT = 0;
        break;
      }
      case 'rally': {
        const b = this.ents.get(c.id);
        if (!b || b.owner !== pid || !isBuilding(b)) break;
        b.rally = { x: c.x, z: c.z, target: c.target || 0 };
        break;
      }
    }
  }

  setOrder(u, order, queue) {
    if (queue && (u.order || u.orders.length)) { u.orders.push(order); return; }
    u.order = order;
    u.orders.length = 0;
  }

  groupMove(units, x, z, type, queue = false) {
    if (!units.length) return;
    // Square formation around the target, larger spacing when tanks are present.
    const cols = Math.ceil(Math.sqrt(units.length));
    const spacing = units.some((u) => u.type === 'tank') ? 2.6 : 1.5;
    // Assign slots by distance so units don't cross paths much.
    const cx = units.reduce((s, u) => s + u.x, 0) / units.length;
    const cz = units.reduce((s, u) => s + u.z, 0) / units.length;
    const sorted = [...units].sort((a, b) => (a.x - cx) + (a.z - cz) - ((b.x - cx) + (b.z - cz)));
    sorted.forEach((u, i) => {
      const ox = ((i % cols) - (cols - 1) / 2) * spacing;
      const oz = (Math.floor(i / cols) - (Math.ceil(units.length / cols) - 1) / 2) * spacing;
      const tx = Math.max(-HALF + 1, Math.min(HALF - 1, x + ox));
      const tz = Math.max(-HALF + 1, Math.min(HALF - 1, z + oz));
      this.setOrder(u, { type, x: tx, z: tz }, queue);
    });
    this.events.push({ e: 'ack', o: units[0].owner, k: type, x, z });
  }

  // ---------- queries ----------

  nearestCrystal(x, z, maxDist) {
    let best = null, bd = maxDist;
    for (const e of this.ents.values()) {
      if (e.type !== 'crystal' || e.amount <= 0) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // Least-crowded crystal near (x, z) for this owner's workers; distance breaks ties.
  bestCrystal(owner, x, z, maxDist = 25) {
    const load = new Map();
    for (const w of this.ents.values()) {
      if (w.owner === owner && w.type === 'worker' && w.order && w.order.type === 'gather') load.set(w.order.node, (load.get(w.order.node) || 0) + 1);
    }
    let best = null, bs = Infinity;
    for (const n of this.ents.values()) {
      if (n.type !== 'crystal' || n.amount <= 0) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d > maxDist) continue;
      const s = (load.get(n.id) || 0) * 10 + d;
      if (s < bs) { bs = s; best = n; }
    }
    return best;
  }

  nearestDropoff(u) {
    let best = null, bd = Infinity;
    for (const e of this.ents.values()) {
      if (e.owner !== u.owner || !TYPES[e.type].dropoff || !e.built) continue;
      const d = Math.hypot(e.x - u.x, e.z - u.z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // Nearest hostile within `range` (edge distance). Prefers units over buildings.
  findEnemy(e, range) {
    let best = null, bs = Infinity;
    for (const o of this.ents.values()) {
      if (o.owner < 0 || o.owner === e.owner || o.hp <= 0) continue;
      const d = Math.hypot(o.x - e.x, o.z - e.z) - o.r - e.r;
      if (d > range) continue;
      const score = d + (isBuilding(o) ? 8 : 0) + (o.type === 'worker' ? 3 : 0);
      if (score < bs) { bs = score; best = o; }
    }
    return best;
  }

  // ---------- simulation ----------

  // Queue an event from outside the tick (e.g. a player disconnecting); it goes out with the next step.
  announce(ev) { (this.carryEvents ||= []).push(ev); }

  step() {
    this.events = this.carryEvents || [];
    this.carryEvents = [];
    this.tick++;
    for (const { pid, cmd } of this.commands) this.apply(pid, cmd);
    this.commands = [];

    this.pop.fill(0);
    for (const e of this.ents.values()) if (isUnit(e) && e.owner >= 0) this.pop[e.owner] += TYPES[e.type].pop;
    this.obstacles = [...this.ents.values()].filter(isObstacle);

    for (const e of this.ents.values()) {
      if (e.hp <= 0) continue;
      if (isUnit(e)) this.updateUnit(e);
      else if (isBuilding(e)) this.updateBuilding(e);
    }
    this.separate();
    this.cleanup();
  }

  updateUnit(e) {
    const T = TYPES[e.type];
    e.cd = Math.max(0, e.cd - DT);
    e.moving = false;
    if (!e.order && e.orders.length) e.order = e.orders.shift();
    let o = e.order;
    if (!o) {
      if (e.type !== 'worker' && (this.tick + e.id) % 5 === 0) {
        const t = this.findEnemy(e, T.sight);
        if (t) e.order = o = { type: 'attack', target: t.id, auto: true, hx: e.x, hz: e.z };
      }
      if (!o) return;
    }
    switch (o.type) {
      case 'move': {
        if (this.moveTo(e, o.x, o.z, 0.2) || this.stalled(e, o)) e.order = null;
        break;
      }
      case 'amove': {
        let t = o.target && this.ents.get(o.target);
        if (!t || t.hp <= 0 || Math.hypot(t.x - e.x, t.z - e.z) > T.sight + 6) {
          t = null; o.target = 0;
          if ((this.tick + e.id) % 4 === 0) { t = this.findEnemy(e, T.sight); if (t) o.target = t.id; }
        }
        if (t) this.engage(e, t);
        else if (this.moveTo(e, o.x, o.z, 0.2) || this.stalled(e, o)) e.order = null;
        break;
      }
      case 'attack': {
        const t = this.ents.get(o.target);
        if (!t || t.hp <= 0) { e.order = null; break; }
        if (o.auto && Math.hypot(e.x - o.hx, e.z - o.hz) > 14) { e.order = null; break; } // leash
        this.engage(e, t);
        break;
      }
      case 'gather': this.updateGather(e, o, T); break;
      case 'build': {
        const b = this.ents.get(o.target);
        if (!b || b.built || b.hp <= 0) { e.order = null; break; }
        const reach = b.r + e.r + 0.5;
        if (Math.hypot(b.x - e.x, b.z - e.z) > reach + 0.1) { this.moveTo(e, b.x, b.z, reach); break; }
        e.rot = Math.atan2(b.x - e.x, b.z - e.z);
        e.working = true;
        const inc = DT / TYPES[b.type].time;
        b.progress = Math.min(1, b.progress + inc);
        b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.9 * inc);
        if (b.progress >= 1) {
          b.built = true;
          this.events.push({ e: 'built', o: b.owner, k: b.type, x: b.x, z: b.z });
        }
        break;
      }
    }
  }

  updateGather(e, o, T) {
    if (o.phase === 'toNode') {
      let n = this.ents.get(o.node);
      if (!n || n.type !== 'crystal' || n.amount <= 0) {
        n = this.nearestCrystal(o.nx, o.nz, 25);
        if (!n) { e.order = null; return; }
        o.node = n.id; o.nx = n.x; o.nz = n.z;
      }
      if (this.moveTo(e, n.x, n.z, n.r + e.r + 0.3)) o.phase = this.claimSlot(n, e) ? 'mine' : 'wait';
      o.t = 0;
    } else if (o.phase === 'wait') {
      // Node is busy: wait at it, in arrival order, until one of its two mining slots frees up.
      const n = this.ents.get(o.node);
      if (!n || n.amount <= 0) { o.phase = 'toNode'; return; }
      e.rot = Math.atan2(n.x - e.x, n.z - e.z);
      e.waiting = true;
      if (this.claimSlot(n, e)) { o.phase = 'mine'; o.t = 0; }
    } else if (o.phase === 'mine') {
      const n = this.ents.get(o.node);
      if (!n || n.amount <= 0) { o.phase = 'toNode'; return; }
      e.rot = Math.atan2(n.x - e.x, n.z - e.z);
      e.working = true;
      o.t += DT;
      if (o.t >= T.gatherTime) {
        const amt = Math.min(T.carry, n.amount);
        n.amount -= amt;
        e.carry = amt;
        e.lastNode = n.id;
        n.miners.delete(e.id);
        o.phase = 'return';
      }
    } else {
      if (e.carry <= 0) { o.phase = 'toNode'; return; }
      const h = this.nearestDropoff(e);
      if (!h) { e.order = null; return; }
      if (this.moveTo(e, h.x, h.z, h.r + e.r + 0.3)) {
        this.players[e.owner].crystals += e.carry;
        e.carry = 0;
        o.phase = 'toNode';
      }
    }
  }

  // A crystal node lets MINERS_PER_NODE workers mine at once; others queue first-come, first-served.
  claimSlot(n, e) {
    const active = (id, phase) => {
      const w = this.ents.get(id);
      return w && w.order && w.order.type === 'gather' && w.order.node === n.id && w.order.phase === phase;
    };
    for (const id of n.miners) if (!active(id, 'mine')) n.miners.delete(id);
    n.waitQ = n.waitQ.filter((id) => active(id, 'wait') || id === e.id);
    if (n.miners.has(e.id)) return true;
    if (n.miners.size < MINERS_PER_NODE && (!n.waitQ.length || n.waitQ[0] === e.id)) {
      n.miners.add(e.id);
      n.waitQ = n.waitQ.filter((id) => id !== e.id);
      return true;
    }
    if (!n.waitQ.includes(e.id)) n.waitQ.push(e.id);
    return false;
  }

  // Gives up on a move order when the unit stops making progress near its goal (crowding).
  stalled(e, o) {
    const d = Math.hypot(o.x - e.x, o.z - e.z);
    if (d < (o.best ?? Infinity) - 0.1) { o.best = d; o.stall = 0; return false; }
    o.stall = (o.stall || 0) + DT;
    return (o.stall > 0.8 && d < 4) || o.stall > 4;
  }

  engage(e, t) {
    const T = TYPES[e.type];
    const d = Math.hypot(t.x - e.x, t.z - e.z) - t.r - e.r;
    if (d <= T.range) {
      e.rot = Math.atan2(t.x - e.x, t.z - e.z);
      e.aiming = true;
      this.chargeUp(e, T);
      if (e.cd <= 0) { this.fire(e, t); e.cd = T.cooldown; }
    } else {
      this.moveTo(e, t.x, t.z, 0);
    }
  }

  // Heavy guns announce the shot a moment early so clients can show a charge-up glow.
  chargeUp(e, T) {
    if (!T.charge || e.charged || e.cd > T.charge) return;
    e.charged = true;
    this.events.push({ e: 'charge', a: e.id, t: r2(Math.max(e.cd, DT)) });
  }

  fire(e, t) {
    const T = TYPES[e.type];
    e.charged = false;
    const mult = (k) => (T.bonus && T.bonus[k]) || 1;
    this.damage(t, T.dmg * mult(t.type), e);
    if (T.splash) {
      for (const o of this.ents.values()) {
        if (o === t || o.owner < 0 || o.owner === e.owner || o.hp <= 0) continue;
        if (Math.hypot(o.x - t.x, o.z - t.z) < T.splash + o.r) this.damage(o, T.dmg * 0.5 * mult(o.type), e);
      }
    }
    this.events.push({ e: 'shot', k: e.type, a: e.id, x: r2(e.x), z: r2(e.z), tx: r2(t.x), tz: r2(t.z), tr: t.r });
  }

  damage(t, amount, by) {
    if (TYPES[t.type].kind === 'resource') return;
    t.hp -= amount;
    // Idle combat units fight back.
    if (isUnit(t) && !t.order && t.type !== 'worker' && by) t.order = { type: 'attack', target: by.id, auto: true, hx: t.x, hz: t.z };
    const p = this.players[t.owner];
    if (p && this.tick - p.alertTick > 20 * 15) {
      p.alertTick = this.tick;
      this.events.push({ e: 'alert', o: t.owner, x: r2(t.x), z: r2(t.z) });
    }
  }

  moveTo(e, x, z, stop) {
    const dx = x - e.x, dz = z - e.z, d = Math.hypot(dx, dz);
    if (d <= stop + 0.05) return true;
    let vx = dx / d, vz = dz / d;
    // Steer around static obstacles that lie ahead.
    for (const o of this.obstacles) {
      const ox = o.x - e.x, oz = o.z - e.z, od = Math.hypot(ox, oz);
      const clear = o.r + e.r + 0.3;
      if (od - clear > 3 || od < 0.001) continue;
      if (Math.hypot(x - o.x, z - o.z) < clear + 1) continue; // destination is at this obstacle
      const ahead = (ox * vx + oz * vz) / od;
      if (ahead < 0.15) continue;
      const cross = vx * oz - vz * ox;
      const s = cross > 0.01 ? -1 : cross < -0.01 ? 1 : (e.id % 2 ? 1 : -1);
      const w = (1 - Math.max(0, od - clear) / 3) * ahead * 1.6;
      vx += s * (-oz / od) * w;
      vz += s * (ox / od) * w;
    }
    const vl = Math.hypot(vx, vz) || 1;
    vx /= vl; vz /= vl;
    const sp = Math.min(TYPES[e.type].speed * DT, d - stop);
    e.x += vx * sp;
    e.z += vz * sp;
    e.rot = Math.atan2(vx, vz);
    e.moving = true;
    return false;
  }

  separate() {
    const units = [];
    for (const e of this.ents.values()) if (isUnit(e) && e.hp > 0) units.push(e);
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      const aGhost = a.type === 'worker' && a.order && (a.order.type === 'gather' || a.order.type === 'build');
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j];
        if (aGhost || (b.type === 'worker' && b.order && (b.order.type === 'gather' || b.order.type === 'build'))) continue;
        const dx = b.x - a.x, dz = b.z - a.z, min = a.r + b.r;
        if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
        const d = Math.hypot(dx, dz);
        if (d >= min) continue;
        const nx = d > 0.001 ? dx / d : 1, nz = d > 0.001 ? dz / d : 0;
        const push = (min - d) * 0.5;
        const wa = b.r / min, wb = a.r / min; // heavier units get pushed less
        a.x -= nx * push * wa * 2; a.z -= nz * push * wa * 2;
        b.x += nx * push * wb * 2; b.z += nz * push * wb * 2;
      }
    }
    for (const u of units) {
      for (const o of this.obstacles) {
        const dx = u.x - o.x, dz = u.z - o.z, min = u.r + o.r;
        if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
        const d = Math.hypot(dx, dz);
        if (d >= min) continue;
        const nx = d > 0.001 ? dx / d : 1, nz = d > 0.001 ? dz / d : 0;
        u.x = o.x + nx * min; u.z = o.z + nz * min;
      }
      u.x = Math.max(-HALF + 0.5, Math.min(HALF - 0.5, u.x));
      u.z = Math.max(-HALF + 0.5, Math.min(HALF - 0.5, u.z));
    }
  }

  updateBuilding(b) {
    if (!b.built) return;
    const T = TYPES[b.type];
    if (T.dmg) {
      b.cd = Math.max(0, b.cd - DT);
      let t = b.tgt && this.ents.get(b.tgt);
      if (!t || t.hp <= 0 || Math.hypot(t.x - b.x, t.z - b.z) - t.r - b.r > T.range) {
        t = (this.tick + b.id) % 4 === 0 ? this.findEnemy(b, T.range) : null;
        b.tgt = t ? t.id : 0;
      }
      if (t) {
        b.rot = Math.atan2(t.x - b.x, t.z - b.z);
        this.chargeUp(b, T);
        if (b.cd <= 0) { this.fire(b, t); b.cd = T.cooldown; }
      }
    }
    if (b.queue.length) {
      const kind = b.queue[0], UT = TYPES[kind];
      if (this.pop[b.owner] + UT.pop > POP_CAP) {
        if (this.tick % (20 * 10) === 0) this.events.push({ e: 'err', o: b.owner, msg: 'Population cap reached' });
        return;
      }
      b.trainT += DT;
      if (b.trainT >= UT.time) {
        b.queue.shift();
        b.trainT = 0;
        this.spawnTrained(b, kind);
      }
    }
  }

  spawnTrained(b, kind) {
    const rally = b.rally;
    const tx = rally ? rally.x : -Math.sign(b.x) * 1, tz = rally ? rally.z : -Math.sign(b.z) * 1;
    const a = Math.atan2(tz - b.z, tx - b.x);
    const u = this.spawn(kind, b.owner, b.x + Math.cos(a) * (b.r + 1.2), b.z + Math.sin(a) * (b.r + 1.2));
    this.pop[b.owner] += TYPES[kind].pop;
    this.events.push({ e: 'trained', o: b.owner, k: kind });
    const rt = rally && rally.target && this.ents.get(rally.target);
    if (kind === 'worker' && (!rally || (rt && rt.type === 'crystal'))) {
      const n = rt || this.nearestCrystal(b.x, b.z, 25);
      if (n) u.order = { type: 'gather', node: n.id, nx: n.x, nz: n.z, phase: 'toNode', t: 0 };
    } else if (rally) {
      u.order = { type: 'move', x: rally.x, z: rally.z };
    }
  }

  cleanup() {
    const dead = [];
    for (const e of this.ents.values()) {
      if ((e.type === 'crystal' && e.amount <= 0) || ((isUnit(e) || isBuilding(e)) && e.hp <= 0)) dead.push(e);
    }
    for (const e of dead) {
      this.ents.delete(e.id);
      if (!e.silent) this.events.push({ e: 'death', k: e.type, o: e.owner, x: r2(e.x), z: r2(e.z) });
      if (e.type === 'hq') this.eliminate(e.owner);
    }
    const alive = this.players.filter((p) => p.alive);
    if (!this.over && this.players.length > 1 && alive.length <= 1) {
      this.over = true;
      this.winner = alive.length ? alive[0].id : -1;
      this.events.push({ e: 'over', w: this.winner });
    }
  }

  eliminate(pid) {
    const p = this.players[pid];
    if (!p || !p.alive) return;
    p.alive = false;
    for (const e of [...this.ents.values()]) {
      if (e.owner !== pid) continue;
      this.ents.delete(e.id);
      this.events.push({ e: 'death', k: e.type, o: e.owner, x: r2(e.x), z: r2(e.z) });
    }
    this.events.push({ e: 'elim', o: pid });
  }

  // ---------- network view ----------

  // Compact state for clients: ents are [id, typeIdx, owner, x, z, rot, hp, a, b, queue]
  //   building: a = build progress, b = training progress, queue = [typeIdx...]
  //   unit:     a = carried crystals, b = 1 moving / 2 working (gathering, building) / 3 aiming / 4 waiting for a mining slot
  //   resource: hp = remaining amount, a = active miners, b = workers queued
  snapshot() {
    const ents = [];
    for (const e of this.ents.values()) {
      const T = TYPES[e.type];
      let a = 0, b = 0, q = 0;
      if (T.kind === 'building') {
        a = e.built ? 1 : r2(e.progress);
        if (e.queue.length) { b = r2(e.trainT / TYPES[e.queue[0]].time); q = e.queue.map((k) => TYPE_INDEX[k]); }
      } else if (T.kind === 'unit') {
        a = e.carry;
        b = e.moving ? 1 : e.working ? 2 : e.aiming ? 3 : e.waiting ? 4 : 0;
        e.working = false;
        e.aiming = false;
        e.waiting = false;
      } else if (T.kind === 'resource') {
        a = e.miners.size;
        b = e.waitQ.length;
      }
      ents.push([e.id, TYPE_INDEX[e.type], e.owner, r2(e.x), r2(e.z), r2(e.rot), Math.ceil(T.kind === 'resource' ? e.amount : e.hp), a, b, q]);
    }
    return {
      tick: this.tick, over: this.over, winner: this.winner,
      players: this.players.map((p) => ({ name: p.name, c: Math.floor(p.crystals), pop: this.pop[p.id], alive: p.alive })),
      ents, events: this.events,
    };
  }
}
