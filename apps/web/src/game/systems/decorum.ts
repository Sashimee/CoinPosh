export interface DecorumRules {
  readonly perNudge: number;
  readonly decayPerSecond: number;
}

export interface DecorumSnapshot {
  readonly used: number;
  readonly capacity: number;
  readonly fraction: number;
  readonly frozenSeconds: number;
}

/**
 * The client's running estimate of the Decorum meter. Nudges and decay move it right away so
 * the meter answers the thumb; every server answer replaces the estimate, and only the server
 * starts a Concierge freeze. Times are local monotonic milliseconds.
 */
export class DecorumModel {
  readonly #rules: DecorumRules;
  #capacity: number;
  #points = 0;
  #at: number;
  #frozenUntil: number | null = null;

  constructor(rules: DecorumRules, capacity: number, nowMs: number) {
    if (!(rules.perNudge > 0) || !(rules.decayPerSecond >= 0)) {
      throw new RangeError(
        `DecorumModel: perNudge must be > 0 and decayPerSecond ≥ 0, got ${rules.perNudge} and ${rules.decayPerSecond}`,
      );
    }
    this.#rules = rules;
    this.#capacity = requireCapacity(capacity);
    this.#at = nowMs;
  }

  get capacity(): number {
    return this.#capacity;
  }

  frozen(nowMs: number): boolean {
    return this.#frozenUntil !== null && nowMs < this.#frozenUntil;
  }

  setCapacity(capacity: number, nowMs: number): void {
    this.#decay(nowMs);
    const fraction = this.#points / this.#capacity;
    this.#capacity = requireCapacity(capacity);
    this.#points = fraction * this.#capacity;
  }

  /** Predicts the meter after a nudge the server has not answered yet. */
  nudge(nowMs: number): void {
    this.#decay(nowMs);
    this.#points = Math.min(this.#capacity, this.#points + this.#rules.perNudge);
  }

  /** Takes the server's meter; `freezeMs` is how long the Concierge freeze has left, if any. */
  reconcile(fraction: number, freezeMs: number | null, nowMs: number): void {
    if (!(fraction >= 0 && fraction <= 1)) {
      throw new RangeError(`DecorumModel.reconcile: fraction must be in [0, 1], got ${fraction}`);
    }
    this.#points = fraction * this.#capacity;
    this.#at = nowMs;
    this.#frozenUntil = freezeMs !== null && freezeMs > 0 ? nowMs + freezeMs : null;
  }

  /** Ends a freeze whose time is up; returns true on the frame it thaws. */
  thawIfDue(nowMs: number): boolean {
    if (this.#frozenUntil === null || nowMs < this.#frozenUntil) return false;
    this.#frozenUntil = null;
    return true;
  }

  snapshot(nowMs: number): DecorumSnapshot {
    this.#decay(nowMs);
    const frozenSeconds =
      this.#frozenUntil === null ? 0 : Math.max(0, (this.#frozenUntil - nowMs) / 1000);
    return {
      used: this.#points,
      capacity: this.#capacity,
      fraction: this.#points / this.#capacity,
      frozenSeconds,
    };
  }

  #decay(nowMs: number): void {
    const elapsed = Math.max(0, nowMs - this.#at) / 1000;
    this.#at = Math.max(this.#at, nowMs);
    this.#points = Math.max(0, this.#points - elapsed * this.#rules.decayPerSecond);
  }
}

function requireCapacity(capacity: number): number {
  if (!(capacity > 0) || !Number.isFinite(capacity)) {
    throw new RangeError(`DecorumModel: capacity must be a positive number, got ${capacity}`);
  }
  return capacity;
}
