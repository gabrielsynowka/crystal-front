// Host/client networking over WebRTC (PeerJS). The host runs the simulation;
// clients send commands and receive snapshots. PeerJS is loaded as a global from index.html.

const PREFIX = 'crystalfront-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_SLOTS = 4;
const TIMEOUT_MS = 6000;

function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[(Math.random() * ALPHABET.length) | 0];
  return s;
}

export class HostNet {
  constructor(name) {
    this.slots = [{ kind: 'human', name, conn: null }];
    for (let i = 1; i < MAX_SLOTS; i++) this.slots.push({ kind: 'open' });
    this.started = false;
    this.code = null;
    this.onLobby = () => {};
    this.onCmd = () => {};    // (pid, cmd)
    this.onLeave = () => {};  // (pid)
  }

  open() {
    return new Promise((resolve, reject) => {
      const tryOpen = (attempt) => {
        const code = makeCode();
        const peer = new Peer(PREFIX + code);
        peer.on('open', () => {
          this.peer = peer;
          this.code = code;
          this.heartbeat = setInterval(() => { this.broadcast({ t: 'ping' }); this.checkTimeouts(); }, 1000);
          resolve(code);
        });
        peer.on('connection', (conn) => this.accept(conn));
        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && attempt < 5) { peer.destroy(); tryOpen(attempt + 1); }
          else if (!this.peer) reject(err);
          else console.warn('peer error', err);
        });
      };
      tryOpen(0);
    });
  }

  accept(conn) {
    conn.lastSeen = performance.now();
    conn.on('data', (msg) => {
      conn.lastSeen = performance.now();
      if (msg.t === 'hello') {
        const i = this.slots.findIndex((s) => s.kind === 'open');
        if (this.started || i < 0) {
          conn.send({ t: 'reject', reason: this.started ? 'Game already started' : 'Lobby is full' });
          setTimeout(() => conn.close(), 500);
          return;
        }
        this.slots[i] = { kind: 'human', name: String(msg.name || 'Player').slice(0, 16), conn };
        conn.slot = i;
        this.broadcastLobby();
      } else if (msg.t === 'cmd' && this.started && conn.pid !== undefined) {
        this.onCmd(conn.pid, msg.c);
      }
    });
    conn.on('close', () => this.drop(conn));
    conn.on('error', () => this.drop(conn));
  }

  // PeerJS doesn't always report a closed tab, so clients ping and silent ones get dropped.
  checkTimeouts() {
    const now = performance.now();
    for (const s of this.slots) {
      if (s.conn && !s.conn.dropped && now - s.conn.lastSeen > TIMEOUT_MS) { this.drop(s.conn); s.conn.close(); }
    }
  }

  drop(conn) {
    if (conn.dropped) return;
    conn.dropped = true;
    if (this.started) {
      if (conn.pid !== undefined) this.onLeave(conn.pid);
      return;
    }
    if (conn.slot !== undefined && this.slots[conn.slot].conn === conn) {
      this.slots[conn.slot] = { kind: 'open' };
      this.broadcastLobby();
    }
  }

  // Host toggles an empty seat between open and bot.
  toggleSlot(i) {
    const s = this.slots[i];
    if (i === 0 || this.started || s.kind === 'human') return;
    this.slots[i] = s.kind === 'open' ? { kind: 'bot', name: 'Bot' } : { kind: 'open' };
    this.broadcastLobby();
  }

  lobbyState() { return this.slots.map((s) => ({ kind: s.kind, name: s.name })); }

  broadcastLobby() {
    const slots = this.lobbyState();
    this.slots.forEach((s, i) => { if (s.conn && s.conn.open) s.conn.send({ t: 'lobby', slots, you: i, code: this.code }); });
    this.onLobby(slots);
  }

  canStart() { return this.slots.filter((s) => s.kind !== 'open').length >= 2; }

  // Compacts filled seats into player ids 0..n-1 and tells every client which one is theirs.
  start() {
    this.started = true;
    const defs = [];
    for (const s of this.slots) {
      if (s.kind === 'open') continue;
      const pid = defs.length;
      defs.push({ name: s.kind === 'bot' ? 'Bot' : s.name, isBot: s.kind === 'bot' });
      if (s.conn) s.conn.pid = pid;
    }
    let botNo = 0;
    defs.forEach((d) => { if (d.isBot) d.name = `Bot ${++botNo}`; });
    for (const s of this.slots) if (s.conn && s.conn.open) s.conn.send({ t: 'start', you: s.conn.pid });
    return defs;
  }

  broadcast(msg) {
    for (const s of this.slots) if (s.conn && s.conn.open && !s.conn.dropped) s.conn.send(msg);
  }
}

export class ClientNet {
  constructor() {
    this.onLobby = () => {};  // (slots, you, code)
    this.onStart = () => {};  // (you)
    this.onSnap = () => {};   // (snapshot)
    this.onError = () => {};  // (message)
    this.onClose = () => {};
  }

  join(code, name) {
    return new Promise((resolve, reject) => {
      const peer = new Peer();
      this.peer = peer;
      let settled = false;
      const fail = (m) => { if (!settled) { settled = true; reject(new Error(m)); } else this.onError(m); };
      peer.on('error', (err) => fail(err.type === 'peer-unavailable' ? 'No game with that code' : 'Connection failed: ' + err.type));
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code.toUpperCase().trim(), { reliable: true });
        this.conn = conn;
        conn.on('open', () => {
          conn.send({ t: 'hello', name });
          settled = true;
          this.lastSeen = performance.now();
          this.heartbeat = setInterval(() => {
            if (conn.open) conn.send({ t: 'ping' });
            if (performance.now() - this.lastSeen > TIMEOUT_MS) this.close();
          }, 1000);
          resolve();
        });
        conn.on('data', (msg) => {
          this.lastSeen = performance.now();
          if (msg.t === 'ping') return;
          if (msg.t === 'lobby') this.onLobby(msg.slots, msg.you, msg.code);
          else if (msg.t === 'start') this.onStart(msg.you);
          else if (msg.t === 'snap') this.onSnap(msg.s);
          else if (msg.t === 'reject') this.onError(msg.reason);
        });
        conn.on('close', () => this.close());
      });
      setTimeout(() => { if (!settled) fail('Timed out connecting to host'); }, 15000);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.onClose();
  }

  send(cmd) { if (this.conn && this.conn.open) this.conn.send({ t: 'cmd', c: cmd }); }
}
