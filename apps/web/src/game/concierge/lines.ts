/** The portrait's faces (03-ART-AUDIO-JUICE.md); the speech card and the voice bark follow it. */
export const CONCIERGE_EXPRESSIONS = ['pleased', 'wry', 'scandalised'] as const;
export type ConciergeExpression = (typeof CONCIERGE_EXPRESSIONS)[number];

/** A remark reacts to what just happened; a tip tells the player something worth doing. */
export type ConciergeLineKind = 'remark' | 'tip';

/**
 * How badly a line wants the floor. A line at `answer` or above may cut in over a lesser one and
 * skips the breather between lines: it answers a tap, or it is the moment everyone came for.
 */
export const CONCIERGE_PRIORITY = {
  chatter: 10,
  remark: 30,
  tip: 50,
  moment: 70,
  answer: 85,
  urgent: 95,
} as const;

export const CUT_IN_PRIORITY = CONCIERGE_PRIORITY.answer;

/** How long the speech card stays up, by kind: a tip has more to read. */
export const CONCIERGE_DURATION_MS: Readonly<Record<ConciergeLineKind, number>> = {
  remark: 3400,
  tip: 5600,
};

/**
 * Every line id has this many interchangeable variants, `concierge.<lineId>.<variant>` from 0,
 * so the character never repeats itself twice running. The copy (T-14.03) supplies each one.
 */
export const CONCIERGE_LINE_VARIANTS = 5;

export interface ConciergeLineSpec {
  readonly expression: ConciergeExpression;
  readonly kind: ConciergeLineKind;
  readonly priority: number;
  /** The same line stays unsaid this long after it was last said; Infinity means once a session. */
  readonly cooldownMs: number;
  /** How long it may wait for the floor (a line ending, a cinematic) before it is stale. */
  readonly waitMs: number;
}

const ONCE = Number.POSITIVE_INFINITY;
const { chatter, remark, tip, moment, answer, urgent } = CONCIERGE_PRIORITY;

/** Stable line ids. Text, portrait and voice key off these and nothing else. */
export const CONCIERGE_LINES = {
  'greeting.firstCascade': {
    expression: 'pleased',
    kind: 'remark',
    priority: moment,
    cooldownMs: ONCE,
    waitMs: 4000,
  },
  'cascade.chic': {
    expression: 'pleased',
    kind: 'remark',
    priority: chatter,
    cooldownMs: 90_000,
    waitMs: 2500,
  },
  'cascade.lavish': {
    expression: 'pleased',
    kind: 'remark',
    priority: remark,
    cooldownMs: 60_000,
    waitMs: 2500,
  },
  'cascade.opulent': {
    expression: 'pleased',
    kind: 'remark',
    priority: moment,
    cooldownMs: 45_000,
    waitMs: 3000,
  },
  'cascade.decadent': {
    expression: 'wry',
    kind: 'remark',
    priority: moment + 5,
    cooldownMs: 30_000,
    waitMs: 3000,
  },
  'cascade.obscene': {
    expression: 'scandalised',
    kind: 'remark',
    priority: urgent,
    cooldownMs: 20_000,
    waitMs: 4000,
  },
  'fusion.first': {
    expression: 'pleased',
    kind: 'tip',
    priority: moment,
    cooldownMs: ONCE,
    waitMs: 5000,
  },
  'fusion.minor': {
    expression: 'pleased',
    kind: 'remark',
    priority: chatter,
    cooldownMs: 120_000,
    waitMs: 2000,
  },
  'fusion.platinum': {
    expression: 'pleased',
    kind: 'remark',
    priority: remark,
    cooldownMs: 60_000,
    waitMs: 3000,
  },
  'fusion.diamond': {
    expression: 'pleased',
    kind: 'remark',
    priority: moment,
    cooldownMs: 45_000,
    waitMs: 3000,
  },
  'fusion.heirloom': {
    expression: 'scandalised',
    kind: 'remark',
    priority: urgent,
    cooldownMs: 30_000,
    waitMs: 4000,
  },
  'pour.perfect': {
    expression: 'pleased',
    kind: 'remark',
    priority: chatter,
    cooldownMs: 75_000,
    waitMs: 2000,
  },
  'decorum.warning': {
    expression: 'wry',
    kind: 'tip',
    priority: tip + 5,
    cooldownMs: 60_000,
    waitMs: 2500,
  },
  'decorum.freeze': {
    expression: 'scandalised',
    kind: 'remark',
    priority: urgent,
    cooldownMs: 0,
    waitMs: 3000,
  },
  'decorum.stillFrozen': {
    expression: 'wry',
    kind: 'remark',
    priority: remark,
    cooldownMs: 20_000,
    waitMs: 1500,
  },
  'tip.aimCentre': {
    expression: 'wry',
    kind: 'tip',
    priority: tip,
    cooldownMs: 120_000,
    waitMs: 4000,
  },
  'crate.arrived': {
    expression: 'pleased',
    kind: 'remark',
    priority: remark,
    cooldownMs: 90_000,
    waitMs: 2500,
  },
  'reward.modest': {
    expression: 'wry',
    kind: 'remark',
    priority: chatter,
    cooldownMs: 120_000,
    waitMs: 3000,
  },
  'reward.rare': {
    expression: 'pleased',
    kind: 'remark',
    priority: moment,
    cooldownMs: 30_000,
    waitMs: 4000,
  },
  'reward.legendary': {
    expression: 'scandalised',
    kind: 'remark',
    priority: urgent,
    cooldownMs: 0,
    waitMs: 5000,
  },
  'vault.empty': {
    expression: 'wry',
    kind: 'tip',
    priority: answer,
    cooldownMs: 15_000,
    waitMs: 1500,
  },
  'vault.welcomeBack': {
    expression: 'pleased',
    kind: 'remark',
    priority: moment,
    cooldownMs: 0,
    waitMs: 4000,
  },
  'vault.capped': { expression: 'wry', kind: 'tip', priority: moment, cooldownMs: 0, waitMs: 4000 },
  'tip.upgradeAffordable': {
    expression: 'pleased',
    kind: 'tip',
    priority: tip + 10,
    cooldownMs: 120_000,
    waitMs: 6000,
  },
  'upgrade.purchased': {
    expression: 'pleased',
    kind: 'remark',
    priority: remark,
    cooldownMs: 60_000,
    waitMs: 2500,
  },
  'tip.feedTower': {
    expression: 'wry',
    kind: 'tip',
    priority: tip,
    cooldownMs: 180_000,
    waitMs: 4000,
  },
  'tower.wobbling': {
    expression: 'scandalised',
    kind: 'remark',
    priority: moment,
    cooldownMs: 45_000,
    waitMs: 2000,
  },
  'tip.idle': {
    expression: 'wry',
    kind: 'tip',
    priority: tip - 10,
    cooldownMs: 90_000,
    waitMs: 3000,
  },
  'ascension.arrived': {
    expression: 'pleased',
    kind: 'remark',
    priority: urgent,
    cooldownMs: 0,
    waitMs: 6000,
  },
} as const satisfies Record<string, ConciergeLineSpec>;

export type ConciergeLineId = keyof typeof CONCIERGE_LINES;

export const CONCIERGE_LINE_IDS = Object.keys(CONCIERGE_LINES) as readonly ConciergeLineId[];

export function isConciergeLineId(value: unknown): value is ConciergeLineId {
  return typeof value === 'string' && Object.hasOwn(CONCIERGE_LINES, value);
}

export function conciergeLine(lineId: ConciergeLineId): ConciergeLineSpec {
  return CONCIERGE_LINES[lineId];
}
