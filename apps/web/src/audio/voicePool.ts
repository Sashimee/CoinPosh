export const MAX_VOICES = 24;
/**
 * Oscillators and buffer sources alive at once, across every voice. The audio thread pays per
 * source (plus its envelope gain), not per voice, so this is the budget that protects a mid phone.
 */
export const MAX_ACTIVE_SOURCES = 96;
/** Sources a single burst window may start; bounds main-thread node creation during a sweep. */
export const BURST_SOURCES_PER_WINDOW = 32;

export const VoicePriority = {
  quietImpact: 10,
  loudImpact: 60,
  ui: 80,
  combo: 100,
} as const;

export interface PooledVoice {
  readonly priority: number;
  readonly startTime: number;
  readonly endTime: number;
  /** Number of audio sources the voice runs; counted against the pool's source budget. */
  readonly cost: number;
  /** Fades the voice out quickly and frees its nodes; called when the voice is stolen. */
  release(now: number): void;
}

/**
 * A voice loses importance as it decays: a loud hit that is nearly silent is a better steal
 * candidate than a quiet hit that just started.
 */
export function effectivePriority(voice: PooledVoice, now: number): number {
  const span = voice.endTime - voice.startTime;
  if (span <= 0) return 0;
  const remaining = Math.min(1, Math.max(0, (voice.endTime - now) / span));
  return voice.priority * remaining;
}

export class VoicePool<V extends PooledVoice> {
  private readonly voices: V[] = [];

  constructor(
    readonly capacity: number = MAX_VOICES,
    readonly sourceBudget: number = MAX_ACTIVE_SOURCES,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`VoicePool capacity must be a positive integer, got ${capacity}`);
    }
    if (!Number.isInteger(sourceBudget) || sourceBudget < 1) {
      throw new RangeError(
        `VoicePool source budget must be a positive integer, got ${sourceBudget}`,
      );
    }
  }

  get activeCount(): number {
    return this.voices.length;
  }

  get activeCost(): number {
    return this.voices.reduce((sum, voice) => sum + voice.cost, 0);
  }

  /** True when a voice of this priority and cost would fit, using free room or stolen voices. */
  canAdmit(priority: number, cost: number, now: number): boolean {
    return this.planAdmission(priority, cost, now) !== null;
  }

  /** Adds the voice, stealing the least important ones until both the voice and source caps fit. */
  admit(voice: V, now: number): boolean {
    const victims = this.planAdmission(voice.priority, voice.cost, now);
    if (victims === null) return false;
    for (const victim of victims) {
      this.voices.splice(this.voices.indexOf(victim), 1);
      victim.release(now);
    }
    this.voices.push(voice);
    return true;
  }

  releaseAll(now: number): void {
    for (const voice of this.voices.splice(0)) voice.release(now);
  }

  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i];
      if (voice !== undefined && voice.endTime <= now) this.voices.splice(i, 1);
    }
  }

  /** Returns the voices to steal (possibly none), or null when the voice cannot be admitted. */
  private planAdmission(priority: number, cost: number, now: number): V[] | null {
    if (!Number.isInteger(cost) || cost < 1) {
      throw new RangeError(`Voice cost must be a positive integer source count, got ${cost}`);
    }
    this.reap(now);
    if (cost > this.sourceBudget) return null;
    let count = this.voices.length;
    let used = this.activeCost;
    const fits = () => count < this.capacity && used + cost <= this.sourceBudget;
    if (fits()) return [];
    const victims: V[] = [];
    for (const voice of this.stealOrder(now)) {
      if (effectivePriority(voice, now) > priority) return null;
      victims.push(voice);
      count--;
      used -= voice.cost;
      if (fits()) return victims;
    }
    return null;
  }

  /** Least important first; among equals, the oldest goes first. */
  private stealOrder(now: number): V[] {
    return [...this.voices].sort(
      (a, b) => effectivePriority(a, now) - effectivePriority(b, now) || a.startTime - b.startTime,
    );
  }
}

/**
 * Caps how many new voices start inside one short window. A pusher sweep can report dozens of
 * contacts in a single physics step; building nodes for all of them would cost a frame and the
 * ear cannot separate them anyway. The cap is in sources, so one rich hit spends more than a tick.
 */
export class BurstLimiter {
  private windowStart = -Infinity;
  private used = 0;

  constructor(
    readonly maxCostPerWindow = BURST_SOURCES_PER_WINDOW,
    readonly windowSeconds = 0.02,
  ) {}

  /** A voice costlier than the whole window still gets through when the window is empty. */
  tryConsume(now: number, cost = 1): boolean {
    if (now - this.windowStart >= this.windowSeconds) {
      this.windowStart = now;
      this.used = 0;
    }
    if (this.used > 0 && this.used + cost > this.maxCostPerWindow) return false;
    this.used += cost;
    return true;
  }
}
