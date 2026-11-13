export interface RetakeSteps<Booted, Laid> {
  /**
   * Resolves once a fresh sim worker in this page reports ready. It runs before the table is
   * taken, so a page that cannot run a sim never takes the table from the tab still playing it.
   */
  readonly simReady: () => Promise<void>;
  /** The `hydrate=boot` call: takes the table session back and says how to lay the table. */
  readonly boot: () => Promise<Booted>;
  /** Starts the sim laid from `booted` and resolves once that sim is ready. */
  readonly lay: (booted: Booted) => Promise<Laid>;
  /** Hands the table to the laid sim: this page adopts the session and input resumes. */
  readonly play: (laid: Laid, booted: Booted) => void;
  /** Throws away a laid sim that never got the table. */
  readonly discard: (laid: Laid) => void;
}

/**
 * "Play here" as one call: a sim must be ready before the table is taken, and this page adopts
 * the new session only once the table is laid in a ready sim, so play resumes the moment the
 * lease is ours. Rejects with the step that failed; the caller keeps "Play here" up to retry.
 */
export function createRetake<Booted, Laid>(steps: RetakeSteps<Booted, Laid>): () => Promise<void> {
  return async () => {
    await steps.simReady();
    const booted = await steps.boot();
    const laid = await steps.lay(booted);
    try {
      steps.play(laid, booted);
    } catch (error) {
      steps.discard(laid);
      throw error;
    }
  };
}
