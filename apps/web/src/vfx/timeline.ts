interface Cue {
  readonly at: number;
  readonly order: number;
  readonly run: () => void;
}

/**
 * Schedules the beats of a choreography in effect time, which hit-stop and slow-mo scale,
 * so an implosion that is frozen mid-flight also delays its flash.
 */
export class Timeline {
  private now = 0;
  private order = 0;
  private cues: Cue[] = [];

  get pending(): number {
    return this.cues.length;
  }

  /** Runs `run` after `delay` seconds of effect time; a delay of 0 runs on the next update. */
  at(delay: number, run: () => void): void {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError(`Timeline.at needs a finite delay >= 0 seconds, got ${delay}`);
    }
    this.cues.push({ at: this.now + delay, order: this.order++, run });
    this.cues.sort((a, b) => a.at - b.at || a.order - b.order);
  }

  update(dt: number): void {
    this.now += Math.max(0, dt);
    while (this.cues.length > 0) {
      const next = this.cues[0];
      if (!next || next.at > this.now) break;
      this.cues.shift();
      next.run();
    }
  }

  clear(): void {
    this.cues = [];
  }
}
