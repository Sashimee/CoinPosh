export const MAX_VOICES = 24;

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

  constructor(readonly capacity: number = MAX_VOICES) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`VoicePool capacity must be a positive integer, got ${capacity}`);
    }
  }

  get activeCount(): number {
    return this.voices.length;
  }

  /** True when a voice of this priority would get a slot, either free or stolen. */
  canAdmit(priority: number, now: number): boolean {
    this.reap(now);
    if (this.voices.length < this.capacity) return true;
    const victim = this.findVictim(now);
    return victim !== null && effectivePriority(victim, now) <= priority;
  }

  /** Adds the voice, stealing the least important one if the pool is full. */
  admit(voice: V, now: number): boolean {
    if (!this.canAdmit(voice.priority, now)) return false;
    if (this.voices.length >= this.capacity) {
      const victim = this.findVictim(now);
      if (victim === null) return false;
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

  private findVictim(now: number): V | null {
    let victim: V | null = null;
    let lowest = Infinity;
    for (const voice of this.voices) {
      const score = effectivePriority(voice, now);
      if (
        score < lowest ||
        (score === lowest && victim !== null && voice.startTime < victim.startTime)
      ) {
        victim = voice;
        lowest = score;
      }
    }
    return victim;
  }
}

/**
 * Caps how many new voices start inside one short window. A pusher sweep can report dozens of
 * contacts in a single physics step; building nodes for all of them would cost a frame and the
 * ear cannot separate them anyway.
 */
export class BurstLimiter {
  private windowStart = -Infinity;
  private count = 0;

  constructor(
    readonly maxPerWindow = 6,
    readonly windowSeconds = 0.02,
  ) {}

  tryConsume(now: number): boolean {
    if (now - this.windowStart >= this.windowSeconds) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.maxPerWindow) return false;
    this.count++;
    return true;
  }
}
