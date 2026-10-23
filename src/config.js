// Game balance and static data. Shared by host simulation and every client.

export const TICK_RATE = 20;              // simulation ticks per second
export const DT = 1 / TICK_RATE;
export const MAP_SIZE = 160;              // world is [-MAP_SIZE/2, MAP_SIZE/2] on x and z
export const POP_CAP = 50;
export const START_CRYSTALS = 200;

export const TEAM_COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308];
export const TEAM_NAMES = ['Blue', 'Red', 'Green', 'Yellow'];

// kind: 'unit' | 'building' | 'resource' | 'prop'
export const TYPES = {
  worker: {
    kind: 'unit', name: 'Worker Drone', hp: 40, speed: 5.5, radius: 0.5, cost: 50, time: 10, pop: 1,
    dmg: 4, range: 1.2, cooldown: 1.2, sight: 8, armor: 'light',
    carry: 5, gatherTime: 2.0, hotkey: 'Q',
  },
  soldier: {
    kind: 'unit', name: 'Infantry', hp: 90, speed: 4.6, radius: 0.55, cost: 60, time: 12, pop: 1,
    dmg: 9, range: 4.5, cooldown: 0.8, sight: 10, armor: 'light',
    bonus: { ranger: 1.6 }, hotkey: 'Q',
  },
  ranger: {
    kind: 'unit', name: 'Ranger', hp: 55, speed: 4.4, radius: 0.5, cost: 75, time: 14, pop: 1,
    dmg: 11, range: 11, cooldown: 1.3, sight: 12, armor: 'light',
    bonus: { tank: 2.2, turret: 1.5 }, hotkey: 'W',
  },
  tank: {
    kind: 'unit', name: 'Hover Tank', hp: 240, speed: 3.6, radius: 1.1, cost: 150, time: 22, pop: 3,
    dmg: 26, range: 7.5, cooldown: 2.2, sight: 10, armor: 'heavy', splash: 2.2, charge: 0.35,
    bonus: { soldier: 1.4, worker: 1.4 }, hotkey: 'E',
  },
  hq: {
    kind: 'building', name: 'Command HQ', hp: 1200, radius: 3.4, cost: 400, time: 60,
    trains: ['worker'], sight: 12, dropoff: true,
  },
  barracks: {
    kind: 'building', name: 'Barracks', hp: 600, radius: 2.6, cost: 150, time: 30,
    trains: ['soldier', 'ranger', 'tank'], sight: 9, hotkey: 'B',
  },
  turret: {
    kind: 'building', name: 'Defense Turret', hp: 380, radius: 1.3, cost: 100, time: 20,
    dmg: 13, range: 10, cooldown: 1.0, sight: 11, hotkey: 'T', charge: 0.25,
  },
  crystal: { kind: 'resource', name: 'Crystals', radius: 1.4, amount: 1200 },
  rock: { kind: 'prop', name: 'Boulder', radius: 2.2 },
};

export const BUILDABLE = ['barracks', 'turret'];

// Stable numeric ids for compact network snapshots.
export const TYPE_LIST = Object.keys(TYPES);
export const TYPE_INDEX = Object.fromEntries(TYPE_LIST.map((t, i) => [t, i]));
