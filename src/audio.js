// Sound: Web Audio for effects and voice, streamed <audio> for music. Starts on the first user click.
const BASE = new URL('../assets/audio/', import.meta.url);

const SFX = ['rifle', 'ranger', 'tank', 'turret', 'explode_small', 'explode_big', 'click', 'place', 'mine'];
const VOICE = ['unit_ready', 'built', 'attack', 'nocrystals', 'popcap', 'victory'];
const ACKS = { move: ['ack_moving', 'ack_onmyway'], attack: ['ack_onmyway', 'ack_moving'], select: ['ack_ready'] };
const ALL = [...SFX, ...VOICE, ...new Set(Object.values(ACKS).flat())];

// Files are loudness-normalized (sfx -21, voice -19, music -22 dB mean), so these are just the mix.
const VOL = { sfx: 0.45, voice: 0.8, ack: 0.6, music: 0.3 };

class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.last = {};      // name -> last play time, for throttling
    this.playing = {};   // name -> active voice count
    try { this.muted = localStorage.getItem('cf-muted') === '1'; } catch { this.muted = false; }
    this.music = null;
    this.track = null;
    this.listener = { x: 0, z: 0, range: 60 };
  }

  // Must run inside a user gesture (browser autoplay rules).
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    // Radio chain for unit acknowledgements: band-limited and slightly driven.
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const drive = this.ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 2.2); }
    drive.curve = curve;
    hp.connect(lp); lp.connect(drive); drive.connect(this.master);
    this.radio = hp;
    for (const name of ALL) this.load(name);
  }

  async load(name) {
    try {
      const res = await fetch(new URL(name + '.mp3', BASE));
      this.buffers[name] = await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch (err) { console.warn('sound missing', name, err); }
  }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem('cf-muted', m ? '1' : '0'); } catch { /* ignore */ }
    if (this.master) this.master.gain.value = m ? 0 : 1;
    if (this.music) this.music.muted = m;
  }

  // gap: minimum seconds between plays of this sound; max: concurrent copies.
  play(name, { vol = VOL.sfx, gap = 0.05, max = 4, radio = false, rate = 1 } = {}) {
    const buf = this.ctx && this.buffers[name];
    if (!buf) return false;
    const now = this.ctx.currentTime;
    if (now - (this.last[name] ?? -9) < gap || (this.playing[name] || 0) >= max) return false;
    this.last[name] = now;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    g.connect(radio ? this.radio : this.master);
    this.playing[name] = (this.playing[name] || 0) + 1;
    src.onended = () => { this.playing[name]--; };
    src.start();
    return true;
  }

  // World sound, quieter the further it is from the centre of the view; silent off-screen.
  at(name, x, z, opts = {}) {
    const d = Math.hypot(x - this.listener.x, z - this.listener.z);
    const f = 1 - d / this.listener.range;
    if (f <= 0) return;
    this.play(name, { ...opts, vol: (opts.vol ?? VOL.sfx) * (0.25 + 0.75 * f), rate: 0.94 + Math.random() * 0.12 });
  }

  voice(name) { this.play(name, { vol: VOL.voice, gap: 2.5, max: 1 }); }

  ack(kind) {
    const list = ACKS[kind];
    if (!list) return;
    // One acknowledgement at a time, across all lines.
    if (this.ctx && this.ctx.currentTime - (this.lastAck ?? -9) < 1.4) return;
    if (this.play(list[(Math.random() * list.length) | 0], { vol: VOL.ack, radio: true, max: 1 })) this.lastAck = this.ctx.currentTime;
  }

  playMusic(track) {
    if (this.track === track) return;
    this.track = track;
    const old = this.music;
    const el = new window.Audio(new URL(track + '.mp3', BASE).href);
    el.loop = true;
    el.muted = this.muted;
    el.volume = 0;
    el.play().catch(() => {});
    this.music = el;
    // Crossfade over ~1.5 s.
    let t = 0;
    const fade = setInterval(() => {
      t = Math.min(1, t + 0.05);
      el.volume = VOL.music * t;
      if (old) old.volume = VOL.music * (1 - t);
      if (t >= 1) { clearInterval(fade); if (old) old.pause(); }
    }, 75);
  }
}

export const audio = new Audio();
