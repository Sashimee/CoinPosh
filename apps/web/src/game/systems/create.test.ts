import type { CoinId, IdempotencyKey, MintedCoin, NudgeDirection } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import type { TableEvent } from '../../net/index.ts';
import { createAnnouncementHold } from '../../ui/components/announcementHold.ts';
import { linearAimMap } from '../input/aimMap.ts';
import { DEFAULT_GESTURES } from '../input/gestures.ts';
import type { FocusTarget } from '../input/keyboard/index.ts';
import type { SimEventBatch } from '../simWorker/protocol.ts';
import { pauseDuringCinematics } from './cinematicPause.ts';
import { createSystemsCore, type TablePort } from './core.ts';
import { inputHandlersFor, mountDesktopControls, type DockDoor } from './create.ts';
import type { GameEventType, GameEvents } from './events.ts';
import { MIN_TICKS_BETWEEN_DROPS } from './tuning.ts';

const HOLD_MS = DEFAULT_GESTURES.holdMs;

const coin = (n: number): MintedCoin => ({
  id: `coin_${'A'.repeat(15)}${String(n)}` as CoinId,
  tier: 'copper',
  value: 10,
});
const key = (n: number): IdempotencyKey =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as IdempotencyKey;

class FakeSim {
  readonly stats = { tick: 0, renderTick: 0 };
  readonly failure = null;
  readonly drops: { xMm: number; tier: string }[] = [];
  readonly nudges: NudgeDirection[] = [];
  drop(xMm: number, tier: string): void {
    this.drops.push({ xMm, tier });
  }
  nudge(direction: NudgeDirection): void {
    this.nudges.push(direction);
  }
  onEvents(_listener: (batch: SimEventBatch) => void): () => void {
    return () => undefined;
  }
  readonly sync = (): void => undefined;
}

/** The server's side of a drop: every ticket it hands out is a coin it minted. */
class FakeTable implements TablePort {
  readonly tickets: IdempotencyKey[] = [];
  readonly nudges: NudgeDirection[] = [];
  drop(): { key: IdempotencyKey; coin: MintedCoin | null } {
    const n = this.tickets.length + 1;
    this.tickets.push(key(n));
    return { key: key(n), coin: coin(n) };
  }
  readonly claimFall = (): void => undefined;
  readonly claimFusion = (): void => undefined;
  nudge(_tick: number, direction: NudgeDirection): boolean {
    this.nudges.push(direction);
    return true;
  }
  subscribe(_listener: (event: TableEvent) => void): () => void {
    return () => undefined;
  }
}

class FakeDocument extends EventTarget {
  activeElement: FocusTarget | null = null;
  readonly visibilityState = 'visible';
  modal = false;
  querySelectorAll(selectors: string): ArrayLike<FocusTarget> {
    if (!this.modal || !selectors.includes('aria-modal')) return [];
    return [{ tagName: 'DIV', closest: () => null }];
  }
}

class FakeDoor implements DockDoor {
  clicks = 0;
  constructor(public hidden = false) {}
  click(): void {
    this.clicks += 1;
  }
}

function fire(target: EventTarget, type: string, props: Record<string, unknown>): Event {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(props)) {
    Object.defineProperty(event, name, { value });
  }
  target.dispatchEvent(event);
  return event;
}

function setup() {
  const sim = new FakeSim();
  const table = new FakeTable();
  const time = { now: 0 };
  const core = createSystemsCore({
    sim,
    table,
    clock: { msUntil: () => 0 },
    ui: { setCascade: () => undefined, setDecorum: () => undefined, feedback: () => undefined },
    bounds: { fieldHalfWidth: 0.28, fieldFrontZ: 0.36 },
    now: () => time.now,
  });
  const win = new EventTarget();
  const doc = new FakeDocument();
  const surface = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, width: 400 }),
    setPointerCapture: () => undefined,
    focus: () => undefined,
  });
  const doors = [new FakeDoor(), new FakeDoor(), new FakeDoor()];
  const desktop = mountDesktopControls(inputHandlersFor(core), {
    surface: () => surface,
    aimMap: linearAimMap(1),
    currentAim: () => core.aim,
    window: win,
    document: doc,
    storage: null,
    now: () => time.now,
    doors: () => doors,
  });
  const press = (code: string): void => {
    fire(win, 'keydown', { code, repeat: false });
  };
  const release = (code: string): void => {
    fire(win, 'keyup', { code });
  };
  /** One frame: the clock moves on, the sim steps and the controls and core run their timers. */
  const frame = (at: number): void => {
    time.now = at;
    sim.stats.tick += MIN_TICKS_BETWEEN_DROPS;
    desktop.tick();
    core.update();
  };
  return { sim, table, core, win, doc, surface, doors, desktop, time, press, release, frame };
}

function record<K extends GameEventType>(
  core: ReturnType<typeof setup>['core'],
  type: K,
): GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  core.events.on(type, (payload) => {
    seen.push(payload);
  });
  return seen;
}

describe('desktop controls in the running game', () => {
  it('a Space tap drops one server-minted coin where the reticle sits', () => {
    const { sim, table, core, desktop, press, release, frame } = setup();
    press('ArrowRight');
    press('ArrowRight');
    expect(core.aim).toBeCloseTo(0.2);
    press('Space');
    expect(desktop.pressed).toBe(true);
    frame(50);
    release('Space');
    expect(desktop.pressed).toBe(false);
    expect(table.tickets).toHaveLength(1);
    expect(sim.drops).toEqual([{ xMm: expect.any(Number) as number, tier: 'copper' }]);
    expect(sim.drops[0]?.xMm).toBeGreaterThan(0);
  });

  it('a held Space pours through the same core and stops on release', () => {
    const { sim, table, core, press, release, frame } = setup();
    const starts = record(core, 'pour:start');
    const ends = record(core, 'pour:end');
    press('Space');
    for (let at = 16; at <= HOLD_MS + 400; at += 16) frame(at);
    expect(starts).toHaveLength(1);
    expect(sim.drops.length).toBeGreaterThan(1);
    expect(sim.drops).toHaveLength(table.tickets.length);
    release('Space');
    expect(ends).toHaveLength(1);
    expect(core.pourView().pouring).toBe(false);
  });

  it('a mouse click on the table drops, and a held button reads as pressed', () => {
    const { sim, win, surface, desktop, frame } = setup();
    const mouse = {
      pointerType: 'mouse',
      target: surface,
      pointerId: 7,
      clientX: 300,
      clientY: 10,
    };
    fire(win, 'pointerdown', { ...mouse, button: 0 });
    expect(desktop.pressed).toBe(true);
    frame(40);
    fire(win, 'pointerup', mouse);
    expect(desktop.pressed).toBe(false);
    expect(sim.drops).toHaveLength(1);
    expect(sim.drops[0]?.xMm).toBeGreaterThan(0);
  });

  it('N nudges through the table, never the sim alone', () => {
    const { sim, table, press } = setup();
    press('KeyN');
    expect(table.nudges).toEqual(['forward']);
    expect(sim.nudges).toEqual(['forward']);
  });

  it('number keys press the dock doors in order, passing over hidden ones', () => {
    const { doors, press } = setup();
    press('Digit1');
    expect(doors.map((door) => door.clicks)).toEqual([1, 0, 0]);
    const [, second] = doors;
    if (second) second.hidden = true;
    press('Digit2');
    expect(doors.map((door) => door.clicks)).toEqual([1, 0, 1]);
    press('Numpad1');
    expect(doors.map((door) => door.clicks)).toEqual([2, 0, 1]);
  });

  it('a number key past the last door does nothing', () => {
    const { doors, press } = setup();
    press('Digit9');
    expect(doors.map((door) => door.clicks)).toEqual([0, 0, 0]);
  });

  it('opening a door spends a held Space, so its release drops nothing', () => {
    const { sim, doors, press, release, frame } = setup();
    press('Space');
    frame(40);
    press('Digit1');
    release('Space');
    expect(doors[0]?.clicks).toBe(1);
    expect(sim.drops).toEqual([]);
  });

  it('a cinematic interrupts a held Space pour and its release drops nothing', () => {
    const { sim, core, desktop, press, release, frame } = setup();
    const hold = createAnnouncementHold();
    const cancels = record(core, 'pour:cancel');
    const stop = pauseDuringCinematics(hold, {
      core,
      interrupt: () => {
        desktop.interrupt();
      },
      overlay: { setSuspended: () => undefined },
    });
    press('Space');
    for (let at = 16; at <= HOLD_MS + 100; at += 16) frame(at);
    expect(core.pourView().pouring).toBe(true);
    const poured = sim.drops.length;

    const letGo = hold.hold();
    expect(cancels).toHaveLength(1);
    expect(desktop.pressed).toBe(false);
    for (let at = HOLD_MS + 116; at < 2_000; at += 16) frame(at);
    letGo();
    release('Space');
    expect(sim.drops).toHaveLength(poured);

    press('Space');
    frame(2_040);
    release('Space');
    expect(sim.drops).toHaveLength(poured + 1);
    stop();
  });

  it('keys under an open sheet never reach the table', () => {
    const { sim, doc, doors, press, release } = setup();
    doc.modal = true;
    press('Space');
    release('Space');
    press('Digit1');
    expect(sim.drops).toEqual([]);
    expect(doors[0]?.clicks).toBe(0);
  });

  it('stops listening once disposed', () => {
    const { sim, desktop, press, release } = setup();
    desktop.dispose();
    press('Space');
    release('Space');
    expect(sim.drops).toEqual([]);
  });
});
