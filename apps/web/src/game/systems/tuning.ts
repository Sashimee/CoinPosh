import {
  cascade,
  rateEnvelope,
  rateEnvelopeDerivation,
  upgradeLines,
  upgradeStat,
} from '@coinposh/economy';
import { MOCK_RULES } from '../../net/mock/rules.ts';
import { TICK_RATE_HZ } from '../simWorker/sim-api.ts';

export const MS_PER_TICK = 1000 / TICK_RATE_HZ;

/** Rounds up, as the server does, so a chain the server accepts is never cut short here. */
export function ticksFor(ms: number): number {
  return Math.ceil(ms / MS_PER_TICK);
}

export const CASCADE = cascade;
export const CASCADE_WINDOW_TICKS = ticksFor(cascade.windowMs);

export const MIN_TICKS_BETWEEN_DROPS = MOCK_RULES.minTicksBetweenDrops;

// TODO(economy-designer): the fall envelope is read from the Demo mock's rules, so live play
// shapes its claims to the mock's cap; serve it from @coinposh/economy or the shared protocol.
/** The most falls the server accepts on a single tick. */
export const FALL_CLAIMS_PER_TICK = MOCK_RULES.fallEnvelope.maxPerTick;

/**
 * A pour streams at the steadiest rate the server's drop envelope allows at base upgrades, so
 * a long pour never trips the drop cap that the economy derived for honest play.
 */
export const POUR_STREAM_TICKS = Math.max(
  MIN_TICKS_BETWEEN_DROPS,
  ticksFor(rateEnvelope.drops.windowMs / rateEnvelope.drops.max),
);

/** The beat marker sits at the economy's mean pour length, the pour the envelope assumes. */
export const POUR_TARGET_MS = rateEnvelopeDerivation.meanPourSeconds * 1000;

export const DECORUM_PER_NUDGE = MOCK_RULES.decorumPerNudge;
export const DECORUM_DECAY_PER_SECOND = MOCK_RULES.decorumDecayPerSecond;

const DECORUM_LINES = upgradeLines.filter((line) => line.effect.stat === 'decorumCapacity');
if (DECORUM_LINES.length === 0) {
  throw new Error('packages/economy upgradeLines has no line with the decorumCapacity stat.');
}

/** Same product the server takes across every line that feeds the stat. */
export function decorumCapacity(levels: Readonly<Record<string, number>>): number {
  let capacity = 1;
  for (const line of DECORUM_LINES) capacity *= upgradeStat(line, levels[line.id] ?? 0);
  return capacity;
}

// TODO(economy-designer): the Perfect Pour window has no number in packages/economy yet. This
// is the only gameplay number defined in game/systems; move it to the economy config (and give
// the bonus a server-side claim) and import it here. Requested as a T-1.10 follow-up.
export const PERFECT_POUR_HALF_WINDOW_MS = 120;
