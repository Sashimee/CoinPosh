import type { CascadeTier } from '@coinposh/shared';
import type { DuckOptions } from '../../mixer.ts';
import type { Composition, DrumKind } from '../riviera.ts';
import { ADAPTIVE_PARTS, PART_SPECS, partsForTier, type AdaptivePart } from './stems.ts';
import {
  jackpotSting,
  STING_DUCK_TAIL_BEATS,
  STING_LANDING_BEAT,
  stingLengthBeats,
} from './sting.ts';
import {
  assertSwing,
  MAX_TEMPO_SWING_BPM,
  nextBarTempo,
  REDUCED_TEMPO_SWING_BPM,
  tempoForDropRate,
} from './tempo.ts';

/** How far ahead of the audio clock notes are committed. Survives a 250 ms main-thread stall. */
export const SCHEDULE_LOOKAHEAD_SECONDS = 0.32;
/** Nothing is ever scheduled closer to "now" than this, so a late pump never lands in the past. */
export const MIN_LEAD_SECONDS = 0.012;
const START_DELAY_SECONDS = 0.06;
const ENTER_FADE_BEATS = 1;
const LEAVE_FADE_BEATS = 4;
const STING_DUCK_DB = -14;
const REDUCED_STING_DUCK_DB = -8;
const STING_DUCK_ATTACK = 0.04;
const STING_DUCK_RELEASE = 1.6;

export type ToneInstrument = 'keys' | 'bass' | 'vibes';

export type ScheduledEvent =
  | {
      readonly kind: 'tone';
      readonly part: AdaptivePart | 'sting';
      readonly instrument: ToneInstrument;
      readonly at: number;
      readonly secondsPerBeat: number;
      readonly durationBeats: number;
      readonly midi: number;
      readonly velocity: number;
    }
  | {
      readonly kind: 'drum';
      readonly part: AdaptivePart;
      readonly drum: DrumKind;
      readonly at: number;
      readonly secondsPerBeat: number;
      readonly velocity: number;
    };

/** `set` jumps (first point, or catching up after a stall); `ramp` glides from the last point. */
export interface GainPoint {
  readonly part: AdaptivePart;
  readonly time: number;
  readonly value: number;
  readonly mode: 'set' | 'ramp';
}

export interface BarStart {
  /** Bars played since start; the loop bar is `index % composition.bars`. */
  readonly index: number;
  readonly start: number;
  readonly bpm: number;
}

export interface ScheduleWindow {
  readonly from: number;
  readonly to: number;
  readonly bars: readonly BarStart[];
  readonly events: readonly ScheduledEvent[];
  readonly gains: readonly GainPoint[];
}

export interface StingPlan {
  readonly at: number;
  readonly events: readonly ScheduledEvent[];
  readonly duck: Required<DuckOptions>;
  /** When the bed is fully back. */
  readonly restoredAt: number;
  /** Seconds from `at` until the last sting note is released. */
  readonly length: number;
}

interface Bar extends BarStart {
  readonly secondsPerBeat: number;
  readonly end: number;
}

type LoopEvent =
  | {
      readonly kind: 'tone';
      readonly part: AdaptivePart;
      readonly instrument: ToneInstrument;
      readonly beat: number;
      readonly durationBeats: number;
      readonly midi: number;
      readonly velocity: number;
    }
  | {
      readonly kind: 'drum';
      readonly part: AdaptivePart;
      readonly drum: DrumKind;
      readonly beat: number;
      readonly velocity: number;
    };

interface CurvePoint {
  readonly time: number;
  readonly value: number;
}

const EMPTY_WINDOW: ScheduleWindow = { from: 0, to: 0, bars: [], events: [], gains: [] };

function assertTime(name: string, time: number): void {
  if (!Number.isFinite(time) || time < 0) {
    throw new RangeError(`${name} must be a non-negative audio-clock time in seconds, got ${time}`);
  }
}

/** Splits the loop into bars of events, each placed by its beat inside the bar. */
function indexLoop(composition: Composition): LoopEvent[][] {
  const { bars, beatsPerBar } = composition;
  const loopBeats = bars * beatsPerBar;
  const byBar: LoopEvent[][] = Array.from({ length: bars }, () => []);
  const place = (time: number, build: (beat: number) => LoopEvent) => {
    const wrapped = ((time % loopBeats) + loopBeats) % loopBeats;
    const bar = Math.min(bars - 1, Math.floor(wrapped / beatsPerBar));
    byBar[bar]?.push(build(wrapped - bar * beatsPerBar));
  };
  const tones = (
    notes: Composition['keys'],
    instrument: ToneInstrument,
    parts: readonly AdaptivePart[],
  ) => {
    for (const note of notes) {
      for (const part of parts) {
        place(note.time, (beat) => ({
          kind: 'tone',
          part,
          instrument,
          beat,
          durationBeats: note.duration,
          midi: note.midi + PART_SPECS[part].transpose,
          velocity: note.velocity,
        }));
      }
    }
  };
  tones(composition.keys, 'keys', ['keys']);
  tones(composition.bass, 'bass', ['bass']);
  tones(composition.vibes, 'vibes', ['vibes', 'sparkle']);
  for (const hit of composition.drums) {
    const part = ADAPTIVE_PARTS.find((p) => PART_SPECS[p].drum === hit.kind);
    if (!part) throw new Error(`No adaptive part plays the "${hit.kind}" drum`);
    place(hit.time, (beat) => ({
      kind: 'drum',
      part,
      drum: hit.kind,
      beat,
      velocity: hit.velocity,
    }));
  }
  for (const events of byBar) events.sort((a, b) => a.beat - b.beat);
  return byBar;
}

function levelAt(curve: readonly CurvePoint[], time: number): number {
  let previous: CurvePoint | undefined;
  for (const point of curve) {
    if (point.time > time) {
      if (!previous) return point.value;
      const span = point.time - previous.time;
      if (span <= 0) return point.value;
      return previous.value + ((point.value - previous.value) * (time - previous.time)) / span;
    }
    previous = point;
  }
  return previous?.value ?? 0;
}

/**
 * The adaptive music clock, as pure logic over audio-clock seconds. Each `pump(now)` commits
 * the next slice of notes and gain automation and never revisits it, so every later decision
 * (a tempo change, a stem crossfade) lands on a bar or beat at or after the committed edge.
 * That is what keeps it free of clicks, doubled notes and events in the past.
 */
export class AdaptiveScheduler {
  private readonly loop: LoopEvent[][];
  private readonly beatsPerBar: number;
  private readonly baseBpm: number;
  private bars: Bar[] = [];
  private committed = 0;
  private running = false;
  private enabled = true;
  private swing = MAX_TEMPO_SWING_BPM;
  private dropRate: number | null = null;
  private tier: CascadeTier | null = null;
  private parts: ReadonlySet<AdaptivePart> = partsForTier(null);
  private curves = new Map<AdaptivePart, CurvePoint[]>();
  private lastEmitted = new Map<AdaptivePart, number>();
  private stingUntil = -Infinity;
  private readonly sting = jackpotSting();

  constructor(composition: Composition) {
    if (composition.bars < 1 || composition.beatsPerBar < 1 || !(composition.bpm > 0)) {
      throw new RangeError(
        `Adaptive music needs at least one bar of beats at a positive tempo, got ${composition.bars} bars of ${composition.beatsPerBar} at ${composition.bpm} BPM`,
      );
    }
    this.loop = indexLoop(composition);
    this.beatsPerBar = composition.beatsPerBar;
    this.baseBpm = composition.bpm;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The tempo new bars ease toward. */
  get targetTempo(): number {
    if (this.dropRate === null) return this.baseBpm;
    return tempoForDropRate(this.dropRate, this.baseBpm, this.swing);
  }

  get activeParts(): ReadonlySet<AdaptivePart> {
    return this.parts;
  }

  get committedUntil(): number {
    return this.committed;
  }

  /** The tempo of the bar sounding at `time`, or the target before the music starts. */
  tempoAt(time: number): number {
    return this.barAt(time)?.bpm ?? this.targetTempo;
  }

  /** The level a part's crossfade has reached at `time`; 0..1 of the part's mix level. */
  partLevelAt(part: AdaptivePart, time: number): number {
    const curve = this.curves.get(part);
    return curve ? levelAt(curve, time) : 0;
  }

  start(now: number): void {
    assertTime('Music start time', now);
    const start = now + START_DELAY_SECONDS;
    const bpm = this.targetTempo;
    this.bars = [this.makeBar(0, start, bpm)];
    this.committed = start;
    this.curves = new Map(
      ADAPTIVE_PARTS.map((part) => [
        part,
        [{ time: start, value: this.parts.has(part) ? PART_SPECS[part].level : 0 }],
      ]),
    );
    this.lastEmitted = new Map();
    this.stingUntil = -Infinity;
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.bars = [];
    this.curves = new Map();
  }

  /** Audio off: the clock keeps time but no notes are committed until it is back on. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setReducedMotion(reduced: boolean): void {
    this.swing = reduced ? REDUCED_TEMPO_SWING_BPM : MAX_TEMPO_SWING_BPM;
    assertSwing(this.swing);
  }

  get reducedMotion(): boolean {
    return this.swing === REDUCED_TEMPO_SWING_BPM;
  }

  /** Drops per second the player is feeding the table; tempo follows from the next bar on. */
  setDropRate(dropsPerSecond: number): void {
    tempoForDropRate(dropsPerSecond, this.baseBpm, this.swing);
    this.dropRate = dropsPerSecond;
  }

  /**
   * Parts entering fade up over a beat from the next beat, so a tier-up is heard almost at
   * once and on the grid. Parts leaving fade over a bar, so the band winds down, never cuts.
   */
  setCascadeTier(tier: CascadeTier | null, now: number): void {
    if (this.running) assertTime('Cascade tier time', now);
    const next = partsForTier(tier);
    this.tier = tier;
    const previous = this.parts;
    this.parts = next;
    if (!this.running) return;
    const at = this.nextBeat(Math.max(this.committed, now + MIN_LEAD_SECONDS));
    const secondsPerBeat = this.barAt(at)?.secondsPerBeat ?? 60 / this.baseBpm;
    for (const part of ADAPTIVE_PARTS) {
      const entering = next.has(part) && !previous.has(part);
      const leaving = !next.has(part) && previous.has(part);
      if (entering)
        this.rampPart(part, at, PART_SPECS[part].level, ENTER_FADE_BEATS * secondsPerBeat);
      if (leaving) this.rampPart(part, at, 0, LEAVE_FADE_BEATS * secondsPerBeat);
    }
  }

  get cascadeTier(): CascadeTier | null {
    return this.tier;
  }

  pump(now: number): ScheduleWindow {
    assertTime('Pump time', now);
    if (!this.running) return EMPTY_WINDOW;
    const from = Math.max(this.committed, now + MIN_LEAD_SECONDS);
    const to = now + SCHEDULE_LOOKAHEAD_SECONDS;
    if (to <= from) return { ...EMPTY_WINDOW, from, to: from };
    this.ensureBars(to);
    const skippedFrom = this.committed;
    const window: ScheduleWindow = {
      from,
      to,
      bars: this.bars
        .filter((bar) => bar.start >= from && bar.start < to)
        .map(({ index, start, bpm }) => ({ index, start, bpm })),
      events: this.enabled ? this.eventsBetween(from, to) : [],
      gains: this.gainsBetween(skippedFrom, from, to),
    };
    this.committed = to;
    this.pruneBefore(from);
    return window;
  }

  /**
   * The jackpot sting, starting right away (zero-latency) and phrased in the bed's tempo, with
   * the duck it needs from the mixer. A jackpot while one is still ringing returns null.
   */
  jackpot(now: number): StingPlan | null {
    assertTime('Jackpot time', now);
    if (now < this.stingUntil) return null;
    const at = now + MIN_LEAD_SECONDS;
    const secondsPerBeat = 60 / this.tempoAt(at);
    const events: ScheduledEvent[] = this.sting.map((note) => ({
      kind: 'tone',
      part: 'sting',
      instrument: note.instrument,
      at: at + note.beat * secondsPerBeat,
      secondsPerBeat,
      durationBeats: note.durationBeats,
      midi: note.midi,
      velocity: note.velocity,
    }));
    const duck: Required<DuckOptions> = {
      depthDb: this.reducedMotion ? REDUCED_STING_DUCK_DB : STING_DUCK_DB,
      attack: STING_DUCK_ATTACK,
      hold: (STING_LANDING_BEAT + STING_DUCK_TAIL_BEATS) * secondsPerBeat - STING_DUCK_ATTACK,
      release: STING_DUCK_RELEASE,
    };
    const restoredAt = now + duck.attack + duck.hold + duck.release;
    this.stingUntil = now + duck.attack + duck.hold;
    return { at, events, duck, restoredAt, length: stingLengthBeats(this.sting) * secondsPerBeat };
  }

  private makeBar(index: number, start: number, bpm: number): Bar {
    const secondsPerBeat = 60 / bpm;
    return { index, start, bpm, secondsPerBeat, end: start + this.beatsPerBar * secondsPerBeat };
  }

  private ensureBars(time: number): void {
    let last = this.bars.at(-1);
    if (!last) throw new Error('Adaptive scheduler has no bars: call start() before scheduling');
    while (last.end <= time) {
      const bpm = nextBarTempo(last.bpm, this.targetTempo, this.baseBpm, this.swing);
      last = this.makeBar(last.index + 1, last.end, bpm);
      this.bars.push(last);
    }
  }

  private barAt(time: number): Bar | undefined {
    if (!this.running) return undefined;
    const first = this.bars[0];
    if (first && time < first.start) return first;
    this.ensureBars(time);
    return this.bars.find((bar) => time >= bar.start && time < bar.end);
  }

  private nextBeat(time: number): number {
    const bar = this.barAt(time);
    if (!bar) return time;
    if (time <= bar.start) return bar.start;
    const beats = Math.ceil((time - bar.start) / bar.secondsPerBeat - 1e-9);
    return Math.min(bar.end, bar.start + beats * bar.secondsPerBeat);
  }

  private rampPart(part: AdaptivePart, at: number, value: number, duration: number): void {
    const curve = this.curves.get(part) ?? [];
    const from = levelAt(curve, at);
    const kept = curve.filter((point) => point.time < at);
    kept.push({ time: at, value: from }, { time: at + duration, value });
    this.curves.set(part, kept);
  }

  /** A part is worth scheduling while it can be heard at the note or within the next beat. */
  private audible(part: AdaptivePart, time: number, secondsPerBeat: number): boolean {
    const curve = this.curves.get(part);
    if (!curve) return false;
    return levelAt(curve, time) > 0 || levelAt(curve, time + secondsPerBeat) > 0;
  }

  private eventsBetween(from: number, to: number): ScheduledEvent[] {
    const events: ScheduledEvent[] = [];
    for (const bar of this.bars) {
      if (bar.end <= from || bar.start >= to) continue;
      const loopBar = this.loop[bar.index % this.loop.length] ?? [];
      for (const event of loopBar) {
        const at = bar.start + event.beat * bar.secondsPerBeat;
        if (at < from || at >= to || !this.audible(event.part, at, bar.secondsPerBeat)) continue;
        events.push(
          event.kind === 'tone'
            ? {
                kind: 'tone',
                part: event.part,
                instrument: event.instrument,
                at,
                secondsPerBeat: bar.secondsPerBeat,
                durationBeats: event.durationBeats,
                midi: event.midi,
                velocity: event.velocity,
              }
            : {
                kind: 'drum',
                part: event.part,
                drum: event.drum,
                at,
                secondsPerBeat: bar.secondsPerBeat,
                velocity: event.velocity,
              },
        );
      }
    }
    return events;
  }

  /**
   * Breakpoints inside the window, plus the line's value at the window's far edge while a fade
   * is still travelling. Without that edge point the param would sit flat until the fade's end
   * is committed, then jump onto the line.
   */
  private gainsBetween(committed: number, from: number, to: number): GainPoint[] {
    const gains: GainPoint[] = [];
    for (const part of ADAPTIVE_PARTS) {
      const curve = this.curves.get(part) ?? [];
      const skipped = from > committed;
      const emit = (time: number, value: number, mode: GainPoint['mode']) => {
        gains.push({ part, time, value, mode });
        this.lastEmitted.set(part, value);
      };
      if (!this.lastEmitted.has(part) || skipped) emit(from, levelAt(curve, from), 'set');
      for (const point of curve) {
        if (point.time > from && point.time < to) emit(point.time, point.value, 'ramp');
      }
      const edge = levelAt(curve, to);
      if (edge !== this.lastEmitted.get(part)) emit(to, edge, 'ramp');
    }
    return gains;
  }

  private pruneBefore(time: number): void {
    while (this.bars.length > 1 && (this.bars[0]?.end ?? Infinity) <= time) this.bars.shift();
    for (const [part, curve] of this.curves) {
      let firstNeeded = 0;
      while (firstNeeded < curve.length - 1 && (curve[firstNeeded + 1]?.time ?? Infinity) <= time) {
        firstNeeded++;
      }
      if (firstNeeded > 0) this.curves.set(part, curve.slice(firstNeeded));
    }
  }
}
