// Simple bot. Runs on the host, reads the Sim directly, and issues the same commands a player would.
import { TYPES, POP_CAP } from './config.js';
import { canPlace } from './sim.js';

const ARMY = ['soldier', 'ranger', 'tank'];

export class Bot {
  constructor(sim, pid) {
    this.sim = sim;
    this.pid = pid;
    this.attackSize = 7;
    this.target = null;      // enemy HQ id being attacked
    this.wave = new Set();   // unit ids committed to the current attack
    this.rand = Math.random;
    this.thinkEvery = 10 + pid; // ticks, staggered between bots
  }

  cmd(c) { this.sim.queueCommand(this.pid, c); }

  update() {
    const sim = this.sim;
    if (sim.tick % this.thinkEvery !== 0 || sim.over) return;
    const me = sim.players[this.pid];
    if (!me.alive) return;

    const mine = [...sim.ents.values()].filter((e) => e.owner === this.pid);
    const hq = mine.find((e) => e.type === 'hq');
    if (!hq) return;
    const workers = mine.filter((e) => e.type === 'worker');
    const army = mine.filter((e) => ARMY.includes(e.type));
    const barracks = mine.filter((e) => e.type === 'barracks');
    const turrets = mine.filter((e) => e.type === 'turret');
    const minutes = sim.tick / 20 / 60;
    let crystals = me.crystals;
    const pop = sim.pop[this.pid];

    // Idle workers go back to mining.
    for (const w of workers) {
      if (!w.order) {
        const n = sim.nearestCrystal(hq.x, hq.z, 30) || sim.nearestCrystal(w.x, w.z, 200);
        if (n) this.cmd({ t: 'gather', ids: [w.id], target: n.id });
      }
    }

    // Economy.
    const wantWorkers = minutes < 6 ? 14 : 18;
    if (workers.length + hq.queue.length < wantWorkers && hq.queue.length < 2 && crystals >= 50 && pop < POP_CAP - 4) {
      this.cmd({ t: 'train', id: hq.id, kind: 'worker' });
      crystals -= 50;
    }

    // Buildings: unfinished sites get a worker, new ones get placed.
    const builder = workers.find((w) => w.order && w.order.type === 'gather' && w.carry === 0) || workers[0];
    for (const b of mine) {
      if (TYPES[b.type].kind === 'building' && !b.built && !workers.some((w) => w.order && w.order.type === 'build' && w.order.target === b.id) && builder) {
        this.cmd({ t: 'build', ids: [builder.id], target: b.id });
      }
    }
    let wantBarracks = minutes < 3 ? 1 : minutes < 7 ? 2 : 3;
    if (crystals > 450) wantBarracks = Math.min(5, Math.max(wantBarracks, barracks.length + 1)); // spend a growing bank
    if (builder && barracks.length < wantBarracks && crystals >= 150 && workers.length >= 7) {
      const spot = this.findSpot(hq, 'barracks', 10, 16);
      if (spot) { this.cmd({ t: 'build', ids: [builder.id], kind: 'barracks', ...spot }); crystals -= 150; }
    } else if (builder && barracks.some((b) => b.built) && turrets.length < Math.min(3, 1 + Math.floor(minutes / 4)) && crystals >= 200) {
      const spot = this.findSpot(hq, 'turret', 7, 12);
      if (spot) { this.cmd({ t: 'build', ids: [builder.id], kind: 'turret', ...spot }); crystals -= 100; }
    }

    // Army production.
    for (const b of barracks) {
      if (!b.built || b.queue.length >= 2) continue;
      const roll = this.rand();
      const kind = minutes > 3 && roll < 0.25 ? 'tank' : roll < 0.6 ? 'soldier' : 'ranger';
      const cost = TYPES[kind].cost;
      if (crystals >= cost + (workers.length < wantWorkers ? 50 : 0)) {
        this.cmd({ t: 'train', id: b.id, kind });
        crystals -= cost;
      }
    }

    // Defend: any enemy near the base pulls the home army.
    const threat = [...sim.ents.values()].find((e) => e.owner >= 0 && e.owner !== this.pid && TYPES[e.type].kind === 'unit' && Math.hypot(e.x - hq.x, e.z - hq.z) < 22);
    const home = army.filter((u) => !this.wave.has(u.id));
    if (threat) {
      const ids = home.filter((u) => !u.order || u.order.type !== 'attack').map((u) => u.id);
      if (ids.length) this.cmd({ t: 'amove', ids, x: threat.x, z: threat.z });
    } else {
      // Keep the home army gathered in front of the base.
      const rx = hq.x * 0.75, rz = hq.z * 0.75;
      const idle = home.filter((u) => !u.order && Math.hypot(u.x - rx, u.z - rz) > 8).map((u) => u.id);
      if (idle.length) this.cmd({ t: 'move', ids: idle, x: rx, z: rz });
    }

    // Attack waves.
    for (const id of this.wave) if (!sim.ents.has(id)) this.wave.delete(id);
    let tgt = this.target && sim.ents.get(this.target);
    if (!tgt) { this.target = null; tgt = null; this.wave.clear(); } // target destroyed: survivors rejoin the home army
    const maxed = pop >= POP_CAP - 3;
    if (!threat && home.length && (home.length >= this.attackSize || maxed)) {
      tgt = tgt || this.pickTarget(hq);
      if (tgt) {
        this.target = tgt.id;
        for (const u of home) this.wave.add(u.id);
        this.attackSize = Math.min(20, this.attackSize + 3);
      }
    }
    if (tgt && this.wave.size) {
      const idle = [...this.wave].map((id) => sim.ents.get(id)).filter((u) => u && (!u.order || u.order.type === 'move'));
      if (idle.length) this.cmd({ t: 'amove', ids: idle.map((u) => u.id), x: tgt.x, z: tgt.z });
    }
  }

  pickTarget(hq) {
    let best = null, bd = Infinity;
    for (const e of this.sim.ents.values()) {
      if (e.type !== 'hq' || e.owner === this.pid) continue;
      // Neighbours are often equidistant; the random term stops every bot picking the same victim.
      const d = Math.hypot(e.x - hq.x, e.z - hq.z) + this.rand() * 40;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // A free spot between the HQ and the map centre, away from the mineral line.
  findSpot(hq, kind, rMin, rMax) {
    const sim = this.sim;
    const toCenter = Math.atan2(-hq.z, -hq.x);
    const ents = [...sim.ents.values()];
    for (let i = 0; i < 40; i++) {
      const a = toCenter + (this.rand() - 0.5) * Math.PI * 1.1;
      const r = rMin + this.rand() * (rMax - rMin);
      const x = Math.round((hq.x + Math.cos(a) * r) * 2) / 2, z = Math.round((hq.z + Math.sin(a) * r) * 2) / 2;
      if (ents.some((e) => e.type === 'crystal' && Math.hypot(e.x - x, e.z - z) < 6)) continue;
      if (canPlace(kind, x, z, ents)) return { x, z };
    }
    return null;
  }
}
