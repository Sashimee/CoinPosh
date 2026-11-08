import type { NudgeDirection } from '@coinposh/shared';

/** Ergonomics only: how a thumb feels, not what anything is worth. */
export interface GestureConfig {
  /** Holding the primary finger this still for this long starts a pour. */
  readonly holdMs: number;
  /** Movement under this many px still counts as holding still. */
  readonly slopPx: number;
  /** A two-finger swipe must travel this far... */
  readonly swipeMinPx: number;
  /** ...within this long to count as a nudge. */
  readonly swipeMaxMs: number;
  /** Travel at which a swipe is a full-strength nudge. */
  readonly swipeFullPx: number;
}

export const DEFAULT_GESTURES: GestureConfig = {
  holdMs: 280,
  slopPx: 10,
  swipeMinPx: 40,
  swipeMaxMs: 450,
  swipeFullPx: 180,
};

/** `x` is the primary finger's screen x in px; the surface maps it to an aim. */
export type GestureAction =
  | { readonly kind: 'aim'; readonly x: number }
  | { readonly kind: 'drop'; readonly x: number }
  | { readonly kind: 'pourStart'; readonly x: number }
  | { readonly kind: 'pourEnd'; readonly x: number }
  | { readonly kind: 'pourCancel' }
  | { readonly kind: 'nudge'; readonly direction: NudgeDirection; readonly strength: number };

interface Point {
  readonly x: number;
  readonly y: number;
}

type State =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'press';
      readonly id: number;
      pouring: boolean;
      anchor: Point;
      stillSince: number;
      last: Point;
    }
  | {
      readonly kind: 'pair';
      readonly startedAt: number;
      readonly start: Map<number, Point>;
      readonly last: Map<number, Point>;
    }
  /** The gesture is spent; wait for every finger to lift. */
  | { readonly kind: 'spent' };

/**
 * One-thumb table controls. One finger aims while it moves and drops where it lifts; holding
 * it still starts a Sommelier Pour that ends on lift. A second finger turns the touch into a
 * two-finger swipe, which nudges the table when it is quick and long enough. Pure: feed it
 * pointer samples and a clock, read back actions.
 */
export class GestureRecognizer {
  readonly #config: GestureConfig;
  #state: State = { kind: 'idle' };
  readonly #down = new Set<number>();

  constructor(config: GestureConfig = DEFAULT_GESTURES) {
    if (!(config.holdMs > 0) || !(config.slopPx >= 0) || !(config.swipeMinPx > 0)) {
      throw new RangeError('GestureRecognizer: holdMs and swipeMinPx must be > 0 and slopPx ≥ 0');
    }
    if (!(config.swipeMaxMs > 0) || !(config.swipeFullPx >= config.swipeMinPx)) {
      throw new RangeError(
        'GestureRecognizer: swipeMaxMs must be > 0 and swipeFullPx at least swipeMinPx',
      );
    }
    this.#config = config;
  }

  get pouring(): boolean {
    return this.#state.kind === 'press' && this.#state.pouring;
  }

  get active(): boolean {
    return this.#down.size > 0;
  }

  down(id: number, x: number, y: number, at: number): GestureAction[] {
    this.#down.add(id);
    const state = this.#state;
    const here = { x, y };
    switch (state.kind) {
      case 'idle':
        this.#state = {
          kind: 'press',
          id,
          pouring: false,
          anchor: here,
          stillSince: at,
          last: here,
        };
        return [{ kind: 'aim', x }];
      case 'press': {
        const start = new Map<number, Point>([
          [state.id, state.last],
          [id, here],
        ]);
        this.#state = { kind: 'pair', startedAt: at, start, last: new Map(start) };
        return state.pouring ? [{ kind: 'pourCancel' }] : [];
      }
      case 'pair':
        this.#state = { kind: 'spent' };
        return [];
      case 'spent':
        return [];
    }
  }

  move(id: number, x: number, y: number, at: number): GestureAction[] {
    const state = this.#state;
    if (state.kind === 'pair') {
      if (state.last.has(id)) state.last.set(id, { x, y });
      return [];
    }
    if (state.kind !== 'press' || state.id !== id) return [];
    state.last = { x, y };
    if (
      !state.pouring &&
      Math.hypot(x - state.anchor.x, y - state.anchor.y) > this.#config.slopPx
    ) {
      state.anchor = { x, y };
      state.stillSince = at;
    }
    return [{ kind: 'aim', x }];
  }

  up(id: number, x: number, y: number, at: number): GestureAction[] {
    if (!this.#down.delete(id)) return [];
    const state = this.#state;
    let actions: GestureAction[] = [];
    if (state.kind === 'press' && state.id === id) {
      actions = [state.pouring ? { kind: 'pourEnd', x } : { kind: 'drop', x }];
      this.#state = { kind: 'idle' };
    } else if (state.kind === 'pair' && state.last.has(id)) {
      state.last.set(id, { x, y });
      const nudge = this.#swipe(state, at);
      actions = nudge ? [nudge] : [];
      this.#state = { kind: 'spent' };
    }
    if (this.#down.size === 0) this.#state = { kind: 'idle' };
    return actions;
  }

  /** The browser took the pointer away (scroll, system gesture): nothing drops. */
  cancel(id: number): GestureAction[] {
    if (!this.#down.delete(id)) return [];
    const state = this.#state;
    let actions: GestureAction[] = [];
    if (state.kind === 'press' && state.id === id && state.pouring)
      actions = [{ kind: 'pourCancel' }];
    this.#state = this.#down.size === 0 ? { kind: 'idle' } : { kind: 'spent' };
    return actions;
  }

  /** Call every frame: a finger held still long enough starts the pour. */
  tick(at: number): GestureAction[] {
    const state = this.#state;
    if (state.kind !== 'press' || state.pouring) return [];
    if (at - state.stillSince < this.#config.holdMs) return [];
    state.pouring = true;
    return [{ kind: 'pourStart', x: state.last.x }];
  }

  #swipe(
    state: Extract<State, { kind: 'pair' }>,
    at: number,
  ): Extract<GestureAction, { kind: 'nudge' }> | null {
    if (at - state.startedAt > this.#config.swipeMaxMs) return null;
    let dx = 0;
    let dy = 0;
    for (const [id, from] of state.start) {
      const to = state.last.get(id) ?? from;
      dx += to.x - from.x;
      dy += to.y - from.y;
    }
    dx /= state.start.size;
    dy /= state.start.size;
    const travel = Math.hypot(dx, dy);
    if (travel < this.#config.swipeMinPx) return null;
    let direction: NudgeDirection;
    if (Math.abs(dx) >= Math.abs(dy)) direction = dx < 0 ? 'left' : 'right';
    // Screen-down is towards the player, where coins fall; an upward swipe pushes nothing out.
    else if (dy > 0) direction = 'forward';
    else return null;
    return { kind: 'nudge', direction, strength: Math.min(1, travel / this.#config.swipeFullPx) };
  }
}
