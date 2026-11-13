import type { ImpactEvent } from '../../../audio/index.ts';
import type { HapticPattern } from '../../../app/feedback.ts';
import {
  clamp01,
  easeInCubic,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  progress,
} from '../../easing.ts';
import type { JuiceItem } from '../../juice.ts';

/** Beats of the ascension, in ms of cinematic time (real time minus the hit-stop). */
export interface AscendTimeline {
  /** The table sinks into the floor over this long, from 0. */
  readonly sinkMs: number;
  readonly curtainAtMs: number;
  readonly curtainMs: number;
  /** The Gold Bars medallion stamps onto the curtain; time freezes here for `hitStopMs`. */
  readonly stampAtMs: number;
  readonly hitStopMs: number;
  readonly countMs: number;
  readonly liftAtMs: number;
  readonly liftMs: number;
  readonly riseAtMs: number;
  readonly riseMs: number;
  /** Real ms, hit-stop included, at which the cinematic hands back to the game. */
  readonly totalMs: number;
}

/**
 * 03-ART-AUDIO-JUICE.md: the table sinks into the floor, a curtain falls, a new venue rises,
 * in 3 s. The Gold Bars land on the curtain as a heavy stamp with a hit-stop, so the payout
 * reads as the climax, then the curtain lifts on the next venue.
 */
export const FULL_ASCEND: AscendTimeline = {
  sinkMs: 900,
  curtainAtMs: 520,
  curtainMs: 560,
  stampAtMs: 1_120,
  hitStopMs: 70,
  countMs: 560,
  liftAtMs: 1_900,
  liftMs: 520,
  riseAtMs: 2_080,
  riseMs: 850,
  totalMs: 3_000,
};

/**
 * Reduced motion: nothing sinks, falls, stamps or rises. The curtain fades in, the Gold Bars
 * appear at their final value, the curtain fades out on the next venue. Same 3 s, so the
 * player still has time to read the payout.
 */
export const REDUCED_ASCEND: AscendTimeline = {
  sinkMs: 0,
  curtainAtMs: 0,
  curtainMs: 320,
  stampAtMs: 360,
  hitStopMs: 0,
  countMs: 0,
  liftAtMs: 2_300,
  liftMs: 400,
  riseAtMs: 2_300,
  riseMs: 400,
  totalMs: 3_000,
};

export function ascendTimeline(reducedMotion: boolean): AscendTimeline {
  return reducedMotion ? REDUCED_ASCEND : FULL_ASCEND;
}

/** Real elapsed ms to cinematic ms: the clock holds still through the hit-stop. */
export function cinematicMs(realMs: number, timeline: AscendTimeline): number {
  const t = Math.max(0, realMs);
  if (t <= timeline.stampAtMs) return t;
  if (t <= timeline.stampAtMs + timeline.hitStopMs) return timeline.stampAtMs;
  return t - timeline.hitStopMs;
}

export type AscendBeatKind = 'sink' | 'curtain' | 'stamp' | 'lift' | 'rise' | 'done';

export interface AscendBeat {
  readonly kind: AscendBeatKind;
  /** Real ms from the start, hit-stop included. */
  readonly atMs: number;
}

export function ascendBeats(timeline: AscendTimeline): readonly AscendBeat[] {
  const real = (ms: number) => (ms > timeline.stampAtMs ? ms + timeline.hitStopMs : ms);
  const beats: AscendBeat[] = [
    { kind: 'sink', atMs: 0 },
    { kind: 'curtain', atMs: real(timeline.curtainAtMs) },
    { kind: 'stamp', atMs: real(timeline.stampAtMs) },
    { kind: 'lift', atMs: real(timeline.liftAtMs) },
    { kind: 'rise', atMs: real(timeline.riseAtMs) },
    { kind: 'done', atMs: timeline.totalMs },
  ];
  return beats.sort((a, b) => a.atMs - b.atMs);
}

/** The sound and haptic each beat plays; the stamp is the heaviest moment of the whole flow. */
export const ASCEND_CUES: Readonly<
  Record<
    AscendBeatKind,
    { readonly sounds: readonly ImpactEvent[]; readonly haptic: HapticPattern | null }
  >
> = {
  sink: { sounds: [{ material: 'wood', velocity: 0.9, pan: 0 }], haptic: [18, 40, 12] },
  curtain: { sounds: [{ material: 'wood', velocity: 1.2, pan: 0 }], haptic: 22 },
  stamp: {
    sounds: [
      { material: 'metal', velocity: 1.8, pan: 0 },
      { material: 'coin', velocity: 1.4, pan: -0.2 },
      { material: 'coin', velocity: 1.1, pan: 0.2 },
    ],
    haptic: [40, 30, 18],
  },
  lift: { sounds: [{ material: 'coin', velocity: 0.8, pan: 0.15 }], haptic: null },
  rise: {
    sounds: [
      { material: 'metal', velocity: 0.9, pan: -0.15 },
      { material: 'coin', velocity: 1.2, pan: 0.15 },
    ],
    haptic: [12, 50, 24],
  },
  done: { sounds: [], haptic: null },
};

/** Everything the stage needs to draw one frame of the ascension. */
export interface AscendPose {
  /** 0 the table where it stands, 1 sunk through the floor; back to 0 as the new venue rises. */
  readonly sink: number;
  /** Brightness of the stage, 1 full, lower while it sinks into the dark. */
  readonly stageLight: number;
  /** 0 curtain up out of view, 1 down covering the screen. Overshoots slightly as it lands. */
  readonly curtain: number;
  /** 0..1 opacity of the curtain layer; only reduced motion fades it rather than dropping it. */
  readonly curtainOpacity: number;
  /** Scale of the Gold Bars medallion: 0 hidden, slams past 1 on the stamp and settles to 1. */
  readonly stamp: number;
  /** 0..1 share of the Gold Bars counted up on the medallion. */
  readonly count: number;
  /** 0..1 white-gold flash on the stamp. */
  readonly flash: number;
  /** Screen shake offset in px; 0 under reduced motion. */
  readonly shake: number;
  /** 0 the new venue below the floor, 1 risen; overshoots on the way. */
  readonly rise: number;
  /** 0..1 opacity of the next venue's name over the risen stage. */
  readonly title: number;
}

const STAGE_DARK = 0.35;
const curtainLand = easeOutBack(1.25);
const stampSlam = easeOutBack(2.6);
const riseSettle = easeOutBack(1.35);
const STAMP_MS = 260;
const FLASH_MS = 380;
const SHAKE_PX = 9;
const SHAKE_MS = 320;
const SHAKE_WIGGLES = 5;
const TITLE_HOLD_MS = 120;

/**
 * Samples the ascension at `ms` of cinematic time (see `cinematicMs`). Pure, so the
 * choreography is tested frame by frame without a GPU or a DOM.
 */
export function ascendPose(
  ms: number,
  timeline: AscendTimeline,
  reducedMotion: boolean,
): AscendPose {
  const t = Math.max(0, ms);
  const down = progress(t, timeline.curtainAtMs, timeline.curtainAtMs + timeline.curtainMs);
  const up = progress(t, timeline.liftAtMs, timeline.liftAtMs + timeline.liftMs);
  const risen = progress(t, timeline.riseAtMs, timeline.riseAtMs + timeline.riseMs);
  const stamped = progress(t, timeline.stampAtMs, timeline.stampAtMs + STAMP_MS);
  const flashed = progress(t, timeline.stampAtMs, timeline.stampAtMs + FLASH_MS);
  const counted = easeOutCubic(
    progress(t, timeline.stampAtMs, timeline.stampAtMs + timeline.countMs),
  );
  const titleIn = progress(
    t,
    timeline.riseAtMs + TITLE_HOLD_MS,
    timeline.riseAtMs + timeline.riseMs,
  );

  if (reducedMotion) {
    const covered = clamp01(down) * (1 - clamp01(up));
    return {
      sink: 0,
      stageLight: 1 - (1 - STAGE_DARK) * covered,
      curtain: covered > 0 ? 1 : 0,
      curtainOpacity: covered,
      stamp: t >= timeline.stampAtMs ? 1 - clamp01(up) : 0,
      count: counted,
      flash: 0,
      shake: 0,
      rise: risen >= 1 ? 1 : 0,
      title: titleIn,
    };
  }

  const sunk = easeInCubic(progress(t, 0, timeline.sinkMs));
  const sink = t < timeline.riseAtMs ? sunk : 1 - riseSettle(risen);
  const curtain = t < timeline.liftAtMs ? curtainLand(down) : 1 - easeInOutCubic(up);
  const shakeT = progress(t, timeline.stampAtMs, timeline.stampAtMs + SHAKE_MS);
  const shake =
    shakeT <= 0 || shakeT >= 1
      ? 0
      : SHAKE_PX * Math.sin(shakeT * Math.PI * 2 * SHAKE_WIGGLES) * (1 - shakeT);
  const stamp = t < timeline.stampAtMs ? 0 : stampSlam(stamped) * (1 - easeInCubic(up));
  return {
    sink,
    stageLight: 1 - (1 - STAGE_DARK) * clamp01(Math.max(sink, curtain)),
    curtain,
    curtainOpacity: 1,
    stamp,
    count: counted,
    flash: t < timeline.stampAtMs || flashed >= 1 ? 0 : 1 - easeOutCubic(flashed),
    shake,
    rise: riseSettle(risen),
    title: titleIn,
  };
}

/** Gold sparks blown off the stamp: more for bigger payouts, on a log scale, capped for phones. */
export const SPARKS_MIN = 18;
export const SPARKS_MAX = 72;

export function sparkCount(goldBars: number): number {
  if (!Number.isFinite(goldBars) || goldBars <= 0) return 0;
  return Math.min(
    SPARKS_MAX,
    Math.max(SPARKS_MIN, Math.round(SPARKS_MIN + 14 * Math.log10(goldBars))),
  );
}

/**
 * The ascension's contribution to the juice checklist without sound: the stamp shakes the
 * screen and buzzes, sparks fly, the medallion slams and overshoots, the stage darkens and
 * flashes, the Gold Bars count up, the hit-stop freezes time, and the table sinks out of frame.
 */
export const ASCEND_JUICE: {
  readonly items: readonly JuiceItem[];
  readonly reduced: string;
} = {
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
    'No sink, drop, slam, shake, sparks, hit-stop or rise: the curtain fades in over a dimmed table, the Gold Bars appear at their final value with the beat sounds and haptics, and the curtain fades out on the next venue.',
};
