// Client-side view of the game: holds the last two snapshots and interpolates between them.
// Works the same whether snapshots come from a local Sim or over the network.
import { TYPE_LIST } from './config.js';

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class View {
  constructor(localId) {
    this.localId = localId;
    this.prev = null;
    this.cur = new Map();
    this.prevT = 0;
    this.curT = 0;
    this.ents = new Map(); // id -> { id, type, owner, x, z, rot, hp, a, b, q }
    this.players = [];
    this.over = false;
    this.winner = -1;
    this.tick = 0;
    this.onEvent = null;
  }

  get me() { return this.players[this.localId]; }

  push(snap, now) {
    this.prev = this.cur;
    this.prevT = this.curT;
    this.cur = new Map(snap.ents.map((a) => [a[0], a]));
    this.curT = now;
    this.players = snap.players;
    this.over = snap.over;
    this.winner = snap.winner;
    this.tick = snap.tick;
    if (this.onEvent) for (const ev of snap.events) this.onEvent(ev);
  }

  update(now) {
    const span = Math.max(1, this.curT - this.prevT);
    const t = Math.min(1, (now - this.curT) / span);
    for (const [id, a] of this.cur) {
      let e = this.ents.get(id);
      if (!e) { e = { id, type: TYPE_LIST[a[1]], owner: a[2] }; this.ents.set(id, e); }
      const p = this.prev && this.prev.get(id);
      if (p) {
        e.x = p[3] + (a[3] - p[3]) * t;
        e.z = p[4] + (a[4] - p[4]) * t;
        e.rot = lerpAngle(p[5], a[5], t);
      } else {
        e.x = a[3]; e.z = a[4]; e.rot = a[5];
      }
      e.hp = a[6]; e.a = a[7]; e.b = a[8]; e.q = a[9];
    }
    for (const id of this.ents.keys()) if (!this.cur.has(id)) this.ents.delete(id);
  }
}
