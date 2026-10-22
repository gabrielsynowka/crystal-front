# Crystal Front

A tiny sci-fi RTS for up to 4 players in the browser. One player hosts, others join with a 5-letter code (WebRTC via PeerJS). Empty seats can be filled with bots.

**Goal:** destroy every enemy HQ.

## Run locally

```bash
node serve.js
```

Then open http://localhost:8080. No build step; Three.js and PeerJS load from a CDN.

## Controls

Press **F1** in game. Left-click/drag to select, right-click to move/attack/mine/build, A attack-move, S stop, B/T build (workers), Q/W/E train, Ctrl+1-9 groups, Space center, Tab idle worker.

## Code

- `src/sim.js` — authoritative simulation (host only)
- `src/net.js` — PeerJS host/client
- `src/view.js` — client snapshot interpolation
- `src/render.js`, `src/input.js`, `src/ui.js` — Three.js scene, controls, HUD
- `src/ai.js` — bot
