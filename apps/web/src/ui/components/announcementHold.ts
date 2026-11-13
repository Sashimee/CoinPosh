/**
 * Quiets HUD announcements while something else owns the screen, such as a crate cinematic.
 * Holds nest: the announcements stay quiet until every hold is released.
 */
export interface AnnouncementHold {
  readonly held: boolean;
  /** Starts a hold; the returned release ends it, and only its first call counts. */
  hold(): () => void;
  /** Hears every change between quiet and free; returns its unsubscribe. */
  onChange(listener: (held: boolean) => void): () => void;
}

export function createAnnouncementHold(): AnnouncementHold {
  let holds = 0;
  const listeners = new Set<(held: boolean) => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener(holds > 0);
  };
  return {
    get held() {
      return holds > 0;
    },
    hold() {
      holds += 1;
      if (holds === 1) notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0) notify();
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const holdsByOwner = new WeakMap<object, AnnouncementHold>();

/** The one hold shared by everything that announces for `owner`, such as a UI's store. */
export function announcementHoldFor(owner: object): AnnouncementHold {
  let found = holdsByOwner.get(owner);
  if (!found) {
    found = createAnnouncementHold();
    holdsByOwner.set(owner, found);
  }
  return found;
}

export interface RankAnnouncements {
  /** A new, higher rank while nothing holds announcements. */
  readonly rise: (rank: number) => void;
  /** The hold ended after rising to `peak`; `live` is the rank the count stands at now. */
  readonly replay: (peak: number, live: number) => void;
}

/**
 * How a peak kept quiet by a hold is announced once the hold ends. Only a rank the count still
 * stands at earns the centre stamp; a peak the cascade has already fallen from would announce a
 * rank that is over, over the table the player just got back, so it only pulses on the rail.
 */
export type PeakReplay = 'stamp' | 'pulse';

export function peakReplay(peak: number, live: number): PeakReplay {
  return live >= peak ? 'stamp' : 'pulse';
}

export interface RankGate {
  /** The live rank, which keeps following the count through a hold. */
  readonly live: number;
  /** Feeds the rank the count stands at. */
  update(rank: number): void;
  dispose(): void;
}

/**
 * Announces each rise in a rank, except under a hold: there it only remembers the highest rank
 * the rises reached, and announces that one rank once when the hold ends. The live rank is never
 * held back, so whatever reads it, like a multiplier, keeps counting underneath.
 */
export function createRankGate(
  hold: AnnouncementHold,
  announce: RankAnnouncements,
  initial = 0,
): RankGate {
  let live = initial;
  let peak = 0;
  const stop = hold.onChange((held) => {
    if (held || peak === 0) return;
    const reached = peak;
    peak = 0;
    announce.replay(reached, live);
  });
  return {
    get live() {
      return live;
    },
    update(rank) {
      const rising = rank > live;
      live = rank;
      if (!rising) return;
      if (hold.held) peak = Math.max(peak, rank);
      else announce.rise(rank);
    },
    dispose: stop,
  };
}

/** Whatever voices the cascade's tiers: a rise to a higher tier plays its flourish chime. */
export interface TierVoice {
  setComboTier(tier: number): void;
}

export interface HeldTierVoice extends TierVoice {
  dispose(): void;
}

/**
 * Keeps a tier voice to `hold`: a rise under the hold stays silent, and the highest tier it
 * reached chimes once when the hold ends, in step with the HUD's rank stamp. A drop below the
 * voiced tier still reaches the voice under the hold, since drops never chime, so the ladder
 * notes keep the right voicing and the replayed peak is always a rise that chimes.
 */
export function holdTierVoice(
  voice: () => TierVoice | null,
  hold: AnnouncementHold,
): HeldTierVoice {
  let voiced = 0;
  const send = (tier: number): void => {
    const target = voice();
    if (!target) return;
    voiced = tier;
    target.setComboTier(tier);
  };
  const gate = createRankGate(hold, {
    rise: send,
    replay(peak, live) {
      send(peak);
      if (live < peak) send(live);
    },
  });
  return {
    setComboTier(tier) {
      const rising = tier > gate.live;
      gate.update(tier);
      if (rising) return;
      if (!hold.held || tier < voiced) send(tier);
    },
    dispose() {
      gate.dispose();
    },
  };
}
