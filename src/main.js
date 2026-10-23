// Entry point: menus, lobby, game setup and the loops.
import { DT, TEAM_NAMES, TEAM_COLORS } from './config.js';
import { Sim } from './sim.js';
import { View } from './view.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { Bot } from './ai.js';
import { HostNet, ClientNet } from './net.js';
import { loadAssets } from './assets.js';
import { audio } from './audio.js';
import { TYPES } from './config.js';

// Browsers only allow sound after a user gesture; the first click anywhere starts it.
document.addEventListener('pointerdown', () => {
  audio.unlock();
  if (!audio.track) audio.playMusic('music_menu');
}, { once: true });

const SHOT_SFX = { soldier: 'rifle', ranger: 'ranger', tank: 'tank', turret: 'turret' };

const $ = (id) => document.getElementById(id);

// Models start downloading right away, while the player is still in the menu.
const assetsReady = loadAssets((f) => {
  $('loading').textContent = f < 1 ? `Loading models… ${Math.round(f * 100)}%` : '';
});
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const SNAP_EVERY = 2; // host sends every 2nd tick (10 Hz) to clients

// A timer in a Worker keeps ticking when the tab is in the background, unlike requestAnimationFrame.
function workerTicker(ms, fn) {
  const src = `setInterval(() => postMessage(0), ${ms});`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  w.onmessage = fn;
  return w;
}

// Client side of any game: view, renderer, input, HUD and the render loop.
function startClient(localId, send) {
  $('menu').classList.add('hidden');
  $('lobby').classList.add('hidden');
  const view = new View(localId);
  const renderer = new Renderer($('game'), localId);
  const ui = new UI({ view, renderer, send });
  const input = new Input({ renderer, view, send, ui });
  ui.input = input;
  view.onEvent = (ev) => {
    ui.onEvent(ev);
    if (ev.e === 'shot') {
      renderer.shot(ev);
      if (SHOT_SFX[ev.k]) audio.at(SHOT_SFX[ev.k], ev.x, ev.z, { gap: ev.k === 'soldier' ? 0.07 : 0.12 });
    } else if (ev.e === 'death') {
      renderer.death(ev);
      const kind = TYPES[ev.k] && TYPES[ev.k].kind;
      if (kind === 'building') audio.at('explode_big', ev.x, ev.z, { vol: 0.8, max: 2 });
      else if (kind === 'unit') audio.at('explode_small', ev.x, ev.z, { gap: 0.1 });
    }
  };
  audio.playMusic('music_battle');
  Object.assign(audio.listener, { x: renderer.target.x, z: renderer.target.y, range: renderer.dist * 1.3 });
  let last = performance.now(), started = false;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (view.players.length) {
      if (!started) { started = true; ui.refresh(); }
      view.update(now);
      input.update(dt);
      ui.update(dt);
      renderer.sync(view, input.selected, dt);
      audio.listener.x = renderer.target.x;
      audio.listener.z = renderer.target.y;
      audio.listener.range = renderer.dist * 1.3;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { view, renderer, input, ui };
}

// Host side: owns the Sim and the bots, steps at a fixed rate, feeds the local view and the network.
function startHost(defs, localId, net) {
  const sim = new Sim(defs, (Math.random() * 1e9) | 0);
  const bots = defs.map((d, i) => (d.isBot ? new Bot(sim, i) : null)).filter(Boolean);
  const client = startClient(localId, (cmd) => sim.queueCommand(localId, cmd));
  client.view.push(sim.snapshot(), performance.now());

  if (net) {
    net.onCmd = (pid, cmd) => sim.queueCommand(pid, cmd);
    net.onLeave = (pid) => {
      const p = sim.players[pid];
      if (!p || !p.alive) return;
      p.name += ' (bot)';
      bots.push(new Bot(sim, pid));
      sim.announce({ e: 'left', o: pid, name: p.name });
    };
  }

  let simTime = performance.now();
  let pending = []; // events since the last network send
  const step = () => {
    const now = performance.now();
    if (now - simTime > 1000) simTime = now - 1000; // don't spiral after a long stall
    while (now - simTime >= DT * 1000) {
      simTime += DT * 1000;
      for (const b of bots) b.update();
      sim.step();
      const snap = sim.snapshot();
      client.view.push(snap, now);
      if (net) {
        pending.push(...snap.events);
        if (sim.tick % SNAP_EVERY === 0) {
          net.broadcast({ t: 'snap', s: { ...snap, events: pending } });
          pending = [];
        }
      }
    }
  };
  workerTicker(DT * 1000 / 2, step);

  // Debug handle; ff(seconds) fast-forwards the simulation.
  window.game = {
    sim, ...client,
    ff(seconds) {
      for (let i = 0; i < seconds / DT; i++) { for (const b of bots) b.update(); sim.step(); }
      client.view.push(sim.snapshot(), performance.now());
      simTime = performance.now();
    },
  };
}

// ---------- menu ----------

let botCount = 1;
let playerName = '';
try { playerName = localStorage.getItem('cf-name') || ''; } catch { /* storage unavailable */ }
$('name').value = playerName;
const getName = () => {
  const n = $('name').value.trim().slice(0, 16) || 'Commander';
  try { localStorage.setItem('cf-name', n); } catch { /* ignore */ }
  return n;
};
const menuError = (msg) => { $('menuerr').textContent = msg; };

document.querySelectorAll('[data-bots]').forEach((b) => b.addEventListener('click', () => {
  botCount = +b.dataset.bots;
  document.querySelectorAll('[data-bots]').forEach((x) => x.classList.toggle('on', x === b));
}));

$('play').addEventListener('click', async () => {
  await assetsReady;
  const defs = [{ name: getName() }];
  for (let i = 0; i < botCount; i++) defs.push({ name: `${TEAM_NAMES[i + 1]} Bot`, isBot: true });
  startHost(defs, 0, null);
});

$('host').addEventListener('click', async () => {
  menuError('');
  $('host').disabled = true;
  const net = new HostNet(getName());
  try {
    await net.open();
  } catch (err) {
    $('host').disabled = false;
    menuError('Could not reach the matchmaking server (' + (err.type || err.message) + ')');
    return;
  }
  showLobby(true, net.code);
  net.onLobby = (slots) => renderLobby(slots, 0, true, net);
  net.broadcastLobby();
  $('start').onclick = async () => {
    if (!net.canStart()) return;
    await assetsReady;
    startHost(net.start(), 0, net);
  };
});

$('join').addEventListener('click', async () => {
  menuError('');
  const code = $('code').value.trim().toUpperCase();
  if (code.length < 5) { menuError('Enter the 5-letter game code'); return; }
  $('join').disabled = true;
  const net = new ClientNet();
  let client = null;
  net.onLobby = (slots, you, c) => { showLobby(false, c); renderLobby(slots, you, false); };
  net.onStart = (you) => assetsReady.then(() => { client = startClient(you, (cmd) => net.send(cmd)); window.game = client; });
  net.onSnap = (snap) => { if (client) client.view.push(snap, performance.now()); };
  net.onError = (msg) => { if (!client) { backToMenu(); menuError(msg); } };
  net.onClose = () => {
    if (client) client.ui.showEnd('HOST LEFT', false);
    else { backToMenu(); menuError('Disconnected from host'); }
  };
  try {
    await net.join(code, getName());
  } catch (err) {
    $('join').disabled = false;
    menuError(err.message);
  }
});

$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
$('leave').addEventListener('click', () => location.reload());
$('copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('lobbycode').textContent).then(() => { $('copy').textContent = 'Copied!'; }, () => {});
});
$('again').addEventListener('click', () => location.reload());
$('spectate').addEventListener('click', () => $('end').classList.add('hidden'));

function backToMenu() {
  $('lobby').classList.add('hidden');
  $('menu').classList.remove('hidden');
  $('join').disabled = false;
  $('host').disabled = false;
}

function showLobby(isHost, code) {
  $('menu').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  $('lobbycode').textContent = code || '';
  $('start').classList.toggle('hidden', !isHost);
  $('waiting').classList.toggle('hidden', isHost);
}

function renderLobby(slots, you, isHost, net) {
  const list = $('slots');
  list.innerHTML = '';
  slots.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'slot ' + s.kind;
    const label = s.kind === 'open' ? 'Open — waiting for player' : s.kind === 'bot' ? 'Bot' : s.name + (i === you ? ' (you)' : '');
    row.innerHTML = `<span class="swatch" style="background:${s.kind === 'open' ? '#4b4766' : hex(TEAM_COLORS[i])}"></span><span class="sname">${label.replace(/</g, '&lt;')}</span>`;
    if (isHost && i > 0 && s.kind !== 'human') {
      const b = document.createElement('button');
      b.className = 'pill';
      b.textContent = s.kind === 'open' ? 'Add bot' : 'Remove bot';
      b.onclick = () => net.toggleSlot(i);
      row.appendChild(b);
    }
    list.appendChild(row);
  });
  if (isHost) $('start').disabled = !net.canStart();
}
