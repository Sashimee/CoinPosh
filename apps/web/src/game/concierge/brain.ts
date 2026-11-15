import { createBus, type Bus } from '../../app/bus.ts';
import type { SettingsStorage } from '../../app/settings.ts';
import {
  CONCIERGE_DURATION_MS,
  CONCIERGE_LINE_VARIANTS,
  CONCIERGE_LINES,
  CUT_IN_PRIORITY,
  type ConciergeExpression,
  type ConciergeLineId,
  type ConciergeLineKind,
} from './lines.ts';
import {
  CONCIERGE_RULES,
  freshMemory,
  type AnyConciergeRule,
  type ConciergeFeed,
  type ConciergeFeedEvents,
  type ConciergeParams,
  type ConciergeRuleContext,
  type ConciergeState,
  type ConciergeSuggestion,
} from './rules.ts';

/** The breather after a line ends before the next one, so the house never chatters. */
export const CONCIERGE_GAP_MS = 7000;
/** Nothing but a cut-in line while the first drops and the coach mark have the screen. */
export const CONCIERGE_OPENING_HUSH_MS = 4000;
/** With coins to spend and no drop for this long, the Concierge wonders aloud. */
export const CONCIERGE_IDLE_MS = 30_000;
/**
 * A cinematic that never reports its end (a dropped event) stops holding the floor after this,
 * so one lost message cannot silence the character for the rest of the session.
 */
export const CINEMATIC_QUIET_MAX_MS = 60_000;
export const CONCIERGE_STORAGE_KEY = 'coinposh.concierge.v1';

export interface ConciergeLine {
  readonly lineId: ConciergeLineId;
  /** Which of the line's interchangeable variants, 0 to CONCIERGE_LINE_VARIANTS - 1. */
  readonly variant: number;
  readonly expression: ConciergeExpression;
  readonly kind: ConciergeLineKind;
  readonly priority: number;
  /** How long the speech card stays up unless the player dismisses it first. */
  readonly durationMs: number;
  readonly params: ConciergeParams;
}

export type ConciergeHushReason =
  'done' | 'dismissed' | 'preempted' | 'quiet' | 'muted' | 'disposed';

/** What the brain tells the portrait, the speech card and the voice. */
export interface ConciergeEvents {
  'concierge:say': ConciergeLine;
  'concierge:hush': { readonly lineId: ConciergeLineId; readonly reason: ConciergeHushReason };
  'concierge:muted': { readonly muted: boolean };
}

export interface ConciergeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserConciergeClock: ConciergeClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

type Listen<E extends object> = Pick<Bus<E>, 'on'>;

export type ConciergeFeeds = {
  readonly [F in Exclude<ConciergeFeed, 'game'>]?: Listen<ConciergeFeedEvents[F]>;
};

export interface ConciergeOptions {
  /** The game systems' event bus (`GameFeatureContext.events`). */
  readonly bus: Listen<ConciergeFeedEvents['game']>;
  /** The other modules' buses; a missing one keeps its rules quiet. */
  readonly feeds?: ConciergeFeeds;
  readonly state: ConciergeState;
  readonly clock: ConciergeClock;
  /** Picks variants; defaults to Math.random, which is fine for words nobody is paid by. */
  readonly rng?: () => number;
  /** Where the mute choice lives across sessions; null keeps it for this session only. */
  readonly store?: SettingsStorage | null;
  readonly rules?: readonly AnyConciergeRule[];
}

export interface Concierge {
  readonly events: Bus<ConciergeEvents>;
  readonly muted: boolean;
  /** The line on the card right now, or null. */
  readonly current: ConciergeLine | null;
  setMuted(muted: boolean): void;
  /**
   * Holds the floor while `source` is up (a sheet, the announcement hold). The line on the card
   * steps aside; lines arriving meanwhile wait out their own patience.
   */
  setQuiet(source: string, quiet: boolean): void;
  /** The player tapped the card away. */
  dismiss(): void;
  dispose(): void;
}

interface Pending {
  readonly suggestion: ConciergeSuggestion;
  readonly priority: number;
  readonly expiresAt: number;
}

interface Speaking {
  readonly line: ConciergeLine;
  readonly endsAt: number;
}

export function readConciergeMuted(store: SettingsStorage | null): boolean {
  if (!store) return false;
  let text: string | null;
  try {
    text = store.getItem(CONCIERGE_STORAGE_KEY);
  } catch (error) {
    console.warn('[CoinPosh] the Concierge mute could not be read; the Concierge speaks', error);
    return false;
  }
  if (text === null) return false;
  try {
    const raw: unknown = JSON.parse(text);
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'muted' in raw &&
      typeof raw.muted === 'boolean'
    ) {
      return raw.muted;
    }
  } catch {
    // Falls through to the warning below, like a well-formed but wrong value.
  }
  console.warn(
    `[CoinPosh] ignored an invalid saved "${CONCIERGE_STORAGE_KEY}"; the Concierge speaks`,
  );
  return false;
}

function writeConciergeMuted(store: SettingsStorage | null, muted: boolean): void {
  if (!store) return;
  try {
    store.setItem(CONCIERGE_STORAGE_KEY, JSON.stringify({ muted }));
  } catch (error) {
    console.warn('[CoinPosh] the Concierge mute could not be saved; it resets on reload', error);
  }
}

/**
 * The Concierge's brain: listens to the game's buses, runs each event through the rule table
 * and puts at most one line on the floor at a time, by priority, per-line cooldown and a breather
 * between lines. It only listens and suggests, so it can never hold up input or touch the sim,
 * and it keeps no timer running while muted or after dispose.
 */
export function createConcierge(options: ConciergeOptions): Concierge {
  const { clock, state } = options;
  const rng = options.rng ?? Math.random;
  const store = options.store ?? null;
  const rules = options.rules ?? CONCIERGE_RULES;
  const events = createBus<ConciergeEvents>();
  const memory = freshMemory();
  const lastSaid = new Map<ConciergeLineId, number>();
  const lastVariant = new Map<ConciergeLineId, number>();
  const quiet = new Map<string, number>();
  const unsubscribers: (() => void)[] = [];

  let muted = readConciergeMuted(store);
  let disposed = false;
  let speaking: Speaking | null = null;
  let pending: Pending | null = null;
  const openingEndsAt = clock.now() + CONCIERGE_OPENING_HUSH_MS;
  let floorFreeAt = openingEndsAt;
  let lastDropAt: number | null = null;
  let timer: unknown = null;
  let timerAt = Number.POSITIVE_INFINITY;

  const live = (): boolean => !disposed && !muted;

  const quietUntil = (now: number): number => {
    let until = 0;
    for (const [source, at] of quiet) {
      if (at <= now) quiet.delete(source);
      else until = Math.max(until, at);
    }
    return until;
  };

  const clearTimer = (): void => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    timerAt = Number.POSITIVE_INFINITY;
  };

  const idleAt = (): number =>
    lastDropAt === null ? Number.POSITIVE_INFINITY : lastDropAt + CONCIERGE_IDLE_MS;

  const schedule = (): void => {
    if (!live()) {
      clearTimer();
      return;
    }
    const now = clock.now();
    let at = quietUntil(now) > now ? Number.POSITIVE_INFINITY : idleAt();
    if (speaking) at = Math.min(at, speaking.endsAt);
    if (pending) {
      const blockedUntil = Math.max(
        quietUntil(now),
        speaking ? speaking.endsAt : 0,
        pending.priority >= CUT_IN_PRIORITY ? 0 : floorFreeAt,
      );
      at = Math.min(at, Math.min(pending.expiresAt, blockedUntil));
    }
    if (at === timerAt) return;
    clearTimer();
    if (!Number.isFinite(at)) return;
    timerAt = at;
    timer = clock.setTimeout(wake, Math.max(0, at - now));
  };

  const hush = (reason: ConciergeHushReason): void => {
    if (!speaking) return;
    const { lineId } = speaking.line;
    speaking = null;
    floorFreeAt = Math.max(floorFreeAt, clock.now() + CONCIERGE_GAP_MS);
    events.emit('concierge:hush', { lineId, reason });
  };

  const pickVariant = (lineId: ConciergeLineId): number => {
    const previous = lastVariant.get(lineId);
    const span = previous === undefined ? CONCIERGE_LINE_VARIANTS : CONCIERGE_LINE_VARIANTS - 1;
    let variant = Math.min(span - 1, Math.floor(rng() * span));
    if (previous !== undefined && variant >= previous) variant += 1;
    lastVariant.set(lineId, variant);
    return variant;
  };

  const coolingDown = (lineId: ConciergeLineId, now: number): boolean => {
    const said = lastSaid.get(lineId);
    return said !== undefined && now - said < CONCIERGE_LINES[lineId].cooldownMs;
  };

  const speak = (suggestion: ConciergeSuggestion, now: number): void => {
    const spec = CONCIERGE_LINES[suggestion.lineId];
    const durationMs = CONCIERGE_DURATION_MS[spec.kind];
    const line: ConciergeLine = {
      lineId: suggestion.lineId,
      variant: pickVariant(suggestion.lineId),
      expression: spec.expression,
      kind: spec.kind,
      priority: spec.priority,
      durationMs,
      params: suggestion.params ?? {},
    };
    lastSaid.set(line.lineId, now);
    speaking = { line, endsAt: now + durationMs };
    suggestion.onSaid?.();
    events.emit('concierge:say', line);
  };

  const flush = (): void => {
    if (!live()) return;
    const now = clock.now();
    if (speaking && now >= speaking.endsAt) hush('done');
    if (pending && (now >= pending.expiresAt || coolingDown(pending.suggestion.lineId, now))) {
      pending = null;
    }
    if (pending && !speaking && quietUntil(now) <= now) {
      if (pending.priority >= CUT_IN_PRIORITY || now >= floorFreeAt) {
        const { suggestion } = pending;
        pending = null;
        speak(suggestion, now);
      }
    }
    schedule();
  };

  const offerIdle = (now: number): void => {
    if (quietUntil(now) > now) return;
    lastDropAt = null;
    const vault = state.vault?.();
    if (!vault || vault.coins + vault.inHand < 1) return;
    offer({ lineId: 'tip.idle' });
  };

  function wake(): void {
    timer = null;
    timerAt = Number.POSITIVE_INFINITY;
    if (!live()) return;
    const now = clock.now();
    if (now >= idleAt()) offerIdle(now);
    flush();
  }

  function offer(suggestion: ConciergeSuggestion): void {
    if (!live()) return;
    const now = clock.now();
    const spec = CONCIERGE_LINES[suggestion.lineId];
    if (coolingDown(suggestion.lineId, now)) return;
    const quietNow = quietUntil(now) > now;
    if (
      speaking &&
      !quietNow &&
      spec.priority >= CUT_IN_PRIORITY &&
      spec.priority > speaking.line.priority
    ) {
      hush('preempted');
      pending = null;
      speak(suggestion, now);
      schedule();
      return;
    }
    if (pending && now >= pending.expiresAt) pending = null;
    if (!pending || spec.priority >= pending.priority) {
      pending = { suggestion, priority: spec.priority, expiresAt: now + spec.waitMs };
    }
    flush();
  }

  const context = (): ConciergeRuleContext => ({ now: clock.now(), state, memory });

  const listen = <E extends object>(
    feed: Listen<E> | undefined,
    type: keyof E,
    run: (payload: unknown) => void,
  ) => {
    if (!feed) return;
    unsubscribers.push(feed.on(type, run));
  };

  const feedFor = (feed: ConciergeFeed): Listen<Record<PropertyKey, unknown>> | undefined =>
    (feed === 'game' ? options.bus : options.feeds?.[feed]) as
      Listen<Record<PropertyKey, unknown>> | undefined;

  listen(options.bus, 'drop:requested', () => {
    memory.drops += 1;
    if (!live()) return;
    lastDropAt = clock.now();
    schedule();
  });

  // Rules hear an event before a cinematic ends on it, so its own line wins the floor it frees.
  for (const entry of rules) {
    const pick = entry.pick as (
      payload: unknown,
      ctx: ConciergeRuleContext,
    ) => ConciergeSuggestion | null;
    listen(feedFor(entry.feed), entry.event, (payload) => {
      if (disposed) return;
      const suggestion = pick(payload, context());
      if (suggestion) offer(suggestion);
    });
  }

  const startQuiet = (source: string): void => {
    quiet.set(source, clock.now() + CINEMATIC_QUIET_MAX_MS);
    if (live()) hush('quiet');
    schedule();
  };
  const endQuiet = (source: string): void => {
    if (!quiet.delete(source)) return;
    const now = clock.now();
    if (lastDropAt !== null) lastDropAt = now;
    // The cinematic itself was the breather: what it leads to may speak as it hands back.
    if (quietUntil(now) <= now) floorFreeAt = Math.min(floorFreeAt, Math.max(now, openingEndsAt));
    flush();
  };
  const crate = (payload: unknown): string => `crate:${(payload as { crateId: string }).crateId}`;
  const safe = (payload: unknown): string => `safe:${(payload as { safeId: string }).safeId}`;
  const card = (payload: unknown): string => `scratch:${(payload as { cardId: string }).cardId}`;
  const cinematics: readonly {
    readonly feed: ConciergeFeed;
    readonly start: string;
    readonly end: readonly string[];
    readonly key: (payload: unknown) => string;
  }[] = [
    {
      feed: 'crates',
      start: 'crate:fell',
      end: ['crate:collected', 'crate:rejected', 'crate:failed'],
      key: crate,
    },
    { feed: 'safes', start: 'safe:requested', end: ['safe:collected', 'safe:rejected'], key: safe },
    {
      feed: 'scratch',
      start: 'scratch:requested',
      end: ['scratch:collected', 'scratch:rejected'],
      key: card,
    },
    {
      feed: 'ascension',
      start: 'ascension:requested',
      end: ['ascension:completed', 'ascension:rejected'],
      key: () => 'ascension',
    },
  ];
  for (const cinematic of cinematics) {
    const feed = feedFor(cinematic.feed);
    listen(feed, cinematic.start, (payload) => {
      startQuiet(cinematic.key(payload));
    });
    for (const end of cinematic.end) {
      listen(feed, end, (payload) => {
        endQuiet(cinematic.key(payload));
      });
    }
  }

  return {
    events,
    get muted() {
      return muted;
    },
    get current() {
      return speaking?.line ?? null;
    },
    setMuted(next) {
      if (disposed || next === muted) return;
      if (next) {
        hush('muted');
        pending = null;
        lastDropAt = null;
      }
      muted = next;
      writeConciergeMuted(store, muted);
      schedule();
      events.emit('concierge:muted', { muted });
    },
    setQuiet(source, on) {
      if (disposed) return;
      if (on) {
        quiet.set(source, Number.POSITIVE_INFINITY);
        if (live()) hush('quiet');
        schedule();
      } else {
        endQuiet(source);
      }
    },
    dismiss() {
      if (!live() || !speaking) return;
      hush('dismissed');
      flush();
    },
    dispose() {
      if (disposed) return;
      hush('disposed');
      disposed = true;
      pending = null;
      clearTimer();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      quiet.clear();
    },
  };
}
