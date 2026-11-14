import { RARITIES, type Rarity } from '@coinposh/shared';
import type { HapticPattern } from '../../../app/feedback.ts';
import type { DuckOptions, ImpactEvent } from '../../../audio/index.ts';
import {
  clamp01,
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
  progress,
} from '../../easing.ts';
import type { JuiceItem } from '../../juice.ts';

/** Beats of the safe opening up to the moment its contents rest, in ms of cinematic time. */
export interface SafeTimeline {
  /** The vault door scales in over the veil from 0. */
  readonly enterMs: number;
  /** A Key slides into the lock and turns; 0 for a timer open, which needs no Key. */
  readonly keyMs: number;
  readonly dialAtMs: number;
  readonly dialMs: number;
  readonly boltAtMs: number;
  readonly boltMs: number;
  /** The bolt clears its keeper here and time freezes for `hitStopMs`. */
  readonly unlockAtMs: number;
  readonly hitStopMs: number;
  readonly swingAtMs: number;
  readonly swingMs: number;
  /** Light spills from the vault and the first content line pops out. */
  readonly revealAtMs: number;
  readonly lineStaggerMs: number;
  readonly linePopMs: number;
  /** The door has settled and the contents rest; the player may collect from here. */
  readonly settleAtMs: number;
  /** Time the contents stay up before they collect themselves. */
  readonly autoCollectMs: number;
  /** The contents fly into the HUD and the overlay fades over this long after a collect. */
  readonly flyMs: number;
}

/** Dial segments: right, left, right, like a combination lock. Degrees, then share of the spin. */
export const DIAL_TURNS: readonly { readonly to: number; readonly share: number }[] = [
  { to: 440, share: 0.42 },
  { to: 100, share: 0.33 },
  { to: 290, share: 0.25 },
];
/** One ratchet tick each time the dial passes a notch. */
export const DIAL_NOTCH_DEG = 45;
/** How far the door swings open, about its hinge on the left. */
export const DOOR_OPEN_DEG = 112;

/**
 * 03-ART-AUDIO-JUICE.md: the dial spins with ratchet ticks, the bolt slides, the door swings
 * with weight. The contents are on screen 1.9 s after the tap and the player may skip to them
 * at any moment, so the safe never stands between the player and the table for long.
 */
export const FULL_SAFE: SafeTimeline = {
  enterMs: 320,
  keyMs: 0,
  dialAtMs: 240,
  dialMs: 940,
  boltAtMs: 1_200,
  boltMs: 200,
  unlockAtMs: 1_400,
  hitStopMs: 60,
  swingAtMs: 1_400,
  swingMs: 640,
  revealAtMs: 1_640,
  lineStaggerMs: 90,
  linePopMs: 380,
  settleAtMs: 2_140,
  autoCollectMs: 2_600,
  flyMs: 560,
};

/** The Key slides in and turns before the dial spins, so a Key open reads as a Key spent. */
const KEY_LEAD_MS = 360;

/**
 * Reduced motion: no spin, swing, shake or hit-stop. The closed door fades in, one bolt clunk
 * plays, the door cross-fades to the lit, open vault and the contents appear in place. The
 * contents stay up as long as in the full variant so there is time to read them.
 */
export const REDUCED_SAFE: SafeTimeline = {
  enterMs: 200,
  keyMs: 0,
  dialAtMs: 200,
  dialMs: 0,
  boltAtMs: 200,
  boltMs: 0,
  unlockAtMs: 200,
  hitStopMs: 0,
  swingAtMs: 200,
  swingMs: 300,
  revealAtMs: 420,
  lineStaggerMs: 0,
  linePopMs: 200,
  settleAtMs: 640,
  autoCollectMs: 2_600,
  flyMs: 320,
};

function shifted(timeline: SafeTimeline, leadMs: number): SafeTimeline {
  return {
    ...timeline,
    keyMs: leadMs,
    dialAtMs: timeline.dialAtMs + leadMs,
    boltAtMs: timeline.boltAtMs + leadMs,
    unlockAtMs: timeline.unlockAtMs + leadMs,
    swingAtMs: timeline.swingAtMs + leadMs,
    revealAtMs: timeline.revealAtMs + leadMs,
    settleAtMs: timeline.settleAtMs + leadMs,
  };
}

export type SafeOpenedBy = 'key' | 'timer';

export function safeTimeline(reducedMotion: boolean, openedBy: SafeOpenedBy): SafeTimeline {
  if (reducedMotion) return REDUCED_SAFE;
  return openedBy === 'key' ? shifted(FULL_SAFE, KEY_LEAD_MS) : FULL_SAFE;
}

/** Real elapsed ms to cinematic ms: the clock holds still through the hit-stop. */
export function safeCinematicMs(realMs: number, timeline: SafeTimeline): number {
  const t = Math.max(0, realMs);
  if (t <= timeline.unlockAtMs) return t;
  if (t <= timeline.unlockAtMs + timeline.hitStopMs) return timeline.unlockAtMs;
  return t - timeline.hitStopMs;
}

/** Real ms (hit-stop included) of a cinematic-time instant. */
export function safeRealMs(ms: number, timeline: SafeTimeline): number {
  return ms > timeline.unlockAtMs ? ms + timeline.hitStopMs : ms;
}

/** The dial's angle in degrees `ms` into the spin, each segment eased like a hand on the knob. */
export function dialAngle(ms: number, timeline: SafeTimeline): number {
  if (timeline.dialMs <= 0) return 0;
  const t = clamp01((ms - timeline.dialAtMs) / timeline.dialMs);
  let from = 0;
  let start = 0;
  for (const turn of DIAL_TURNS) {
    const end = start + turn.share;
    if (t <= end || turn === DIAL_TURNS[DIAL_TURNS.length - 1]) {
      const local = easeInOutCubic(progress(t, start, end));
      return from + (turn.to - from) * local;
    }
    from = turn.to;
    start = end;
  }
  return from;
}

export type SafeBeatKind =
  'enter' | 'key' | 'tick' | 'turn' | 'bolt' | 'unlock' | 'swing' | 'reveal' | 'settled';

export interface SafeBeat {
  readonly kind: SafeBeatKind;
  /** Real ms from the start, hit-stop included. */
  readonly atMs: number;
  /** For ticks, the notch count so far (1-based); for turns, the segment (1-based); else 0. */
  readonly step: number;
}

const TICK_SAMPLE_MS = 2;

function dialBeats(timeline: SafeTimeline): SafeBeat[] {
  if (timeline.dialMs <= 0) return [];
  const beats: SafeBeat[] = [];
  let notch = 0;
  let ticks = 0;
  for (
    let ms = timeline.dialAtMs;
    ms <= timeline.dialAtMs + timeline.dialMs;
    ms += TICK_SAMPLE_MS
  ) {
    const reached = Math.floor(dialAngle(ms, timeline) / DIAL_NOTCH_DEG);
    if (reached !== notch) {
      notch = reached;
      ticks += 1;
      beats.push({ kind: 'tick', atMs: ms, step: ticks });
    }
  }
  let start = timeline.dialAtMs;
  DIAL_TURNS.forEach((turn, index) => {
    start += turn.share * timeline.dialMs;
    if (index < DIAL_TURNS.length - 1) {
      beats.push({ kind: 'turn', atMs: Math.round(start), step: index + 1 });
    }
  });
  return beats;
}

/** Every beat up to `settled`, in the order they play. */
export function safeBeats(timeline: SafeTimeline): readonly SafeBeat[] {
  const at = (ms: number) => safeRealMs(ms, timeline);
  const beats: SafeBeat[] = [
    { kind: 'enter', atMs: 0, step: 0 },
    ...(timeline.keyMs > 0
      ? [{ kind: 'key' as const, atMs: at(timeline.keyMs * 0.55), step: 0 }]
      : []),
    ...dialBeats(timeline),
    { kind: 'bolt', atMs: at(timeline.boltAtMs), step: 0 },
    { kind: 'unlock', atMs: at(timeline.unlockAtMs), step: 0 },
    {
      kind: 'swing',
      atMs:
        timeline.swingAtMs >= timeline.unlockAtMs
          ? timeline.swingAtMs + timeline.hitStopMs
          : timeline.swingAtMs,
      step: 0,
    },
    { kind: 'reveal', atMs: at(timeline.revealAtMs), step: 0 },
    { kind: 'settled', atMs: at(timeline.settleAtMs), step: 0 },
  ];
  return beats.sort((a, b) => a.atMs - b.atMs);
}

/** Real ms at which the cinematic reaches `kind` (its first beat of that kind). */
export function beatAt(beats: readonly SafeBeat[], kind: SafeBeatKind): number {
  const beat = beats.find((candidate) => candidate.kind === kind);
  if (beat === undefined) throw new Error(`Safe cinematic: the timeline has no ${kind} beat`);
  return beat.atMs;
}

function rank(rarity: Rarity): number {
  return RARITIES.indexOf(rarity);
}

export interface SafeCue {
  readonly sounds: readonly ImpactEvent[];
  readonly haptic: HapticPattern | null;
}

/**
 * The sound and haptic of a beat. Ratchet ticks climb in weight through the spin and pan with
 * the knob; the engine itself jitters each hit's pitch, so no two ticks sound the same. The
 * reveal rings louder the rarer the roll.
 */
export function safeCue(beat: SafeBeat, rarity: Rarity): SafeCue {
  const weight = rank(rarity);
  switch (beat.kind) {
    case 'enter':
      return { sounds: [{ material: 'wood', velocity: 0.7 }], haptic: null };
    case 'key':
      return {
        sounds: [
          { material: 'metal', velocity: 0.55, pan: 0.2 },
          { material: 'coin', velocity: 0.4, pan: 0.2 },
        ],
        haptic: 14,
      };
    case 'tick':
      return {
        sounds: [
          {
            material: 'metal',
            velocity: Math.min(0.75, 0.22 + beat.step * 0.018),
            pan: beat.step % 2 === 0 ? 0.12 : -0.12,
          },
        ],
        haptic: null,
      };
    case 'turn':
      return { sounds: [{ material: 'metal', velocity: 0.85, pan: 0 }], haptic: 10 };
    case 'bolt':
      return {
        sounds: [
          { material: 'metal', velocity: 1.9, pan: 0.25 },
          { material: 'wood', velocity: 1.1, pan: 0.25 },
        ],
        haptic: [28, 24, 16],
      };
    case 'unlock':
      return { sounds: [{ material: 'metal', velocity: 1.2, pan: 0 }], haptic: null };
    case 'swing':
      return { sounds: [{ material: 'wood', velocity: 0.45, pan: -0.3 }], haptic: 12 };
    case 'reveal':
      return {
        sounds: [
          { material: 'metal', velocity: 1.5 + weight * 0.2, pan: 0 },
          { material: 'coin', velocity: 1.3 + weight * 0.25, pan: -0.35 },
          { material: 'coin', velocity: 1.3 + weight * 0.25, pan: 0.35 },
        ],
        haptic: weight >= rank('legendary') ? [40, 30, 40] : [30, 20],
      };
    case 'settled':
      return { sounds: [{ material: 'wood', velocity: 1.4, pan: -0.3 }], haptic: null };
  }
}

/** The collect: coins pour toward the HUD. */
export const SAFE_COLLECT_CUE: SafeCue = {
  sounds: [
    { material: 'coin', velocity: 1.2, pan: -0.1 },
    { material: 'coin', velocity: 0.9, pan: 0.15 },
  ],
  haptic: 18,
};

/** The music steps back under the reveal, further the rarer the roll. */
export function safeRevealDuck(rarity: Rarity): DuckOptions {
  return { depthDb: -7 - rank(rarity) * 2.5, attack: 0.05, hold: 1.4, release: 0.9 };
}

/** Everything the overlay needs to draw one frame of the opening. */
export interface SafePose {
  /** 0..1 dim behind the vault. */
  readonly veil: number;
  /** Scale of the whole vault: 0 hidden, overshoots past 1 as it lands, then 1. */
  readonly vault: number;
  readonly vaultOpacity: number;
  /** 0 the Key outside the lock, 1 fully in; null on a timer open. */
  readonly keyIn: number | null;
  /** The Key's turn in the lock, in degrees. */
  readonly keyTurn: number;
  readonly dial: number;
  /** 0 locked, 1 the bolt fully drawn. */
  readonly bolt: number;
  /** The door's swing in degrees about its hinge; overshoots and settles. */
  readonly swing: number;
  /** 0..1 opacity of the closed door; reduced motion fades it instead of swinging it. */
  readonly door: number;
  /** 0..1 rarity light spilling from inside the vault. */
  readonly glow: number;
  /** 0..1 white-gold flash on the unlock and the reveal. */
  readonly flash: number;
  /** Shake offset in px; 0 under reduced motion. */
  readonly shake: number;
}

const vaultLand = easeOutBack(1.6);
const swingWeight = easeOutBack(1.15);
const SHAKE_PX = 6;
const SHAKE_MS = 240;
const SHAKE_WIGGLES = 4;
const FLASH_MS = 320;

function shakeAt(ms: number, at: number, scale: number): number {
  const t = progress(ms, at, at + SHAKE_MS);
  if (t <= 0 || t >= 1) return 0;
  return SHAKE_PX * scale * Math.sin(t * Math.PI * 2 * SHAKE_WIGGLES) * (1 - t);
}

function flashAt(ms: number, at: number): number {
  const t = progress(ms, at, at + FLASH_MS);
  return t <= 0 || t >= 1 ? 0 : 1 - easeOutCubic(t);
}

/**
 * Samples the opening at `ms` of cinematic time (see `safeCinematicMs`). Pure, so the
 * choreography is tested frame by frame without a DOM.
 */
export function safePose(ms: number, timeline: SafeTimeline, reducedMotion: boolean): SafePose {
  const t = Math.max(0, ms);
  const entered = progress(t, 0, timeline.enterMs);
  const swingT = progress(t, timeline.swingAtMs, timeline.swingAtMs + timeline.swingMs);
  const glow = easeOutCubic(progress(t, timeline.swingAtMs, timeline.revealAtMs + 160));

  if (reducedMotion) {
    return {
      veil: clamp01(entered),
      vault: 1,
      vaultOpacity: clamp01(entered),
      keyIn: null,
      keyTurn: 0,
      dial: 0,
      bolt: t >= timeline.boltAtMs ? 1 : 0,
      swing: 0,
      door: 1 - clamp01(swingT),
      glow,
      flash: 0,
      shake: 0,
    };
  }

  const keyT = timeline.keyMs > 0 ? progress(t, 0, timeline.keyMs) : null;
  const flash = Math.max(flashAt(t, timeline.unlockAtMs) * 0.7, flashAt(t, timeline.revealAtMs));
  return {
    veil: easeOutCubic(entered),
    vault: vaultLand(entered),
    vaultOpacity: clamp01(entered * 2),
    keyIn: keyT === null ? null : easeOutCubic(progress(keyT, 0, 0.55)),
    keyTurn: keyT === null ? 0 : 90 * easeInOutCubic(progress(keyT, 0.55, 1)),
    dial: dialAngle(t, timeline),
    bolt: easeInQuad(progress(t, timeline.boltAtMs, timeline.boltAtMs + timeline.boltMs)),
    swing: DOOR_OPEN_DEG * swingWeight(easeInQuad(swingT) * 0.35 + swingT * 0.65),
    door: 1,
    glow,
    flash,
    shake:
      shakeAt(t, timeline.unlockAtMs, 1) +
      shakeAt(t, timeline.swingAtMs + timeline.swingMs * 0.55, 0.5),
  };
}

/** One content line as it pops out of the vault. */
export interface LinePose {
  /** 0..1 opacity. */
  readonly shown: number;
  /** Scale, overshooting past 1 as the line lands. */
  readonly scale: number;
  /** px the line still sits below its resting place (it rises out of the vault). */
  readonly rise: number;
}

const linePopSpring = easeOutBack(2.2);
const LINE_RISE_PX = 36;

export function linePose(
  ms: number,
  index: number,
  timeline: SafeTimeline,
  reducedMotion: boolean,
): LinePose {
  const at = timeline.revealAtMs + index * timeline.lineStaggerMs;
  const t = progress(ms, at, at + timeline.linePopMs);
  if (reducedMotion) return { shown: clamp01(t), scale: 1, rise: 0 };
  return {
    shown: clamp01(t * 2.5),
    scale: t <= 0 ? 0.4 : 0.4 + 0.6 * linePopSpring(t),
    rise: LINE_RISE_PX * (1 - easeOutCubic(t)),
  };
}

/** The contents' flight into the HUD and the overlay's fade, `ms` after the collect. */
export interface FlyPose {
  /** 0 at rest in the vault, 1 arrived at the HUD. */
  readonly travel: number;
  /** Scale of an item line on its way; it shrinks into the inventory icon. */
  readonly scale: number;
  /** 0..1 opacity of the vault and veil while they leave. */
  readonly fade: number;
}

export function flyPose(ms: number, timeline: SafeTimeline, reducedMotion: boolean): FlyPose {
  const t = progress(ms, 0, timeline.flyMs);
  if (reducedMotion) return { travel: 0, scale: 1, fade: 1 - clamp01(t) };
  const travel = easeInOutCubic(t);
  return { travel, scale: 1 - 0.82 * travel, fade: 1 - easeInQuad(t) };
}

/** Sparks off the reveal: more the rarer the roll, capped for phones. */
export function safeSparkCount(rarity: Rarity): number {
  return 16 + rank(rarity) * 10;
}

/**
 * What the opening gives the juice checklist without sound: the bolt and the door's landing
 * shake the vault and buzz, sparks fly off the reveal, the vault lands with overshoot and every
 * content line pops with a spring, the vault lights in the roll's rarity with a flash, the
 * contents pop as rarity-coloured text and fly into the HUD, the unlock freezes for a hit-stop,
 * and the door swings in perspective toward the camera.
 */
export const SAFE_JUICE: { readonly items: readonly JuiceItem[]; readonly reduced: string } = {
  items: [
    'sound',
    'hapticOrShake',
    'particles',
    'squashOvershoot',
    'lightResponse',
    'numberPop',
    'timeManipulation',
    'camera',
  ],
  reduced:
    'No spin, swing, shake, sparks, overshoot or hit-stop: the closed vault fades in, the bolt clunks, the door cross-fades to the lit open vault, the contents appear in place with the beat sounds and haptics, and fade into the HUD.',
};
