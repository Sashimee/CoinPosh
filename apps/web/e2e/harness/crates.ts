import { PerspectiveCamera, Scene } from 'three/webgpu';
import { mountUi } from '../../src/app/index.ts';
import { createBus } from '../../src/app/bus.ts';
import type { CrateEvents } from '../../src/game/crates/index.ts';
import { mountCrates } from '../../src/game/crates/index.ts';
import type { GameEvents } from '../../src/game/systems/events.ts';
import { createNet } from '../../src/net/index.ts';
import { rivieraCameraPreset } from '../../src/scene/venues/riviera/layout.ts';

/**
 * The crate unbox end to end against the Demo Mode server: real net layer, real crate
 * controller, director, cinematic and reveal card, with the WebGPU stage swapped for a bare
 * scene ticked by requestAnimationFrame. main.ts does not mount crates yet (P-180), so this page
 * is how the unbox flow is exercised. `?motion=reduced` runs the reduced-motion variant.
 */
export interface CrateHarness {
  readonly ready: boolean;
  readonly drops: number;
  readonly log: readonly string[];
  drop(): boolean;
  nudgeForward(): void;
}

declare global {
  interface Window {
    __crates?: CrateHarness;
  }
}

const TICKS_PER_SECOND = 60;
const STROKE_PERIOD_S = 2;

const reduced = new URLSearchParams(location.search).get('motion') === 'reduced';
const uiRoot = document.querySelector<HTMLElement>('#ui');
if (!uiRoot) throw new Error('Crate harness: <div id="ui"> is missing from crates.html');
const ui = mountUi(uiRoot);

const net = await createNet({
  mode: { kind: 'demo' },
  locale: () => ui.i18n.language,
  turnstileToken: () => Promise.reject(new Error('Crate harness runs Demo Mode only')),
  onError: (error) => {
    console.error('Crate harness net error.', error);
  },
});
const state = await net.client.call('state');
net.table.hydrate(state);

const startedAt = performance.now();
const elapsedSeconds = (): number => (performance.now() - startedAt) / 1000;
const sim = {
  stats: {
    get tick() {
      return Math.floor(elapsedSeconds() * TICKS_PER_SECOND);
    },
    get pusherStroke() {
      const phase = (elapsedSeconds() / STROKE_PERIOD_S) % 1;
      return 1 - Math.abs(phase * 2 - 1);
    },
  },
};

const frameListeners = new Set<(deltaSeconds: number) => void>();
let last = performance.now();
const frame = (now: number): void => {
  const delta = Math.max(0, (now - last) / 1000);
  last = now;
  for (const listener of frameListeners) listener(delta);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

const game = createBus<GameEvents>();
const events = createBus<CrateEvents>();
const log: string[] = [];
const logged: (keyof CrateEvents)[] = [
  'crate:spawned',
  'crate:teeter',
  'crate:fell',
  'crate:claimed',
  'crate:rejected',
  'crate:failed',
  'crate:opened',
  'crate:revealed',
  'crate:collected',
];
for (const name of logged) events.on(name, () => log.push(name));

const crates = mountCrates({
  events,
  game,
  net: { table: net.table, client: net.client },
  sim,
  stage: {
    scene: new Scene(),
    camera: new PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 50),
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
  },
  framing: rivieraCameraPreset,
  ui,
  host: uiRoot,
  inventoryTarget: () => document.querySelector<HTMLElement>('#inventory'),
  reducedMotion: () => reduced,
});
crates.controller.adopt(state.table.crates);

let drops = 0;
window.__crates = {
  ready: true,
  get drops() {
    return drops;
  },
  log,
  drop() {
    const ticket = net.table.drop(0, sim.stats.tick);
    if (ticket) drops += 1;
    return ticket !== null;
  },
  nudgeForward() {
    game.emit('nudge', { direction: 'forward', strength: 1, source: 'key', tick: sim.stats.tick });
  },
};
