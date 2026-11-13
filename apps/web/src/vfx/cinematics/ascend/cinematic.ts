import './ascend.css';
import type { Bus } from '../../../app/bus.ts';
import type { HapticPattern } from '../../../app/feedback.ts';
import type { ImpactEvent } from '../../../audio/index.ts';
import { rivieraTokens } from '../../../scene/venues/riviera/palette.ts';
import { icon } from '../../../ui/icons.ts';
import { h } from '../../../ui/dom.ts';
import { schedule } from '../../../ui/motion/loop.ts';
import {
  ASCEND_CUES,
  ascendBeats,
  ascendPose,
  ascendTimeline,
  cinematicMs,
  sparkCount,
  type AscendBeat,
  type AscendPose,
  type AscendTimeline,
} from './plan.ts';
import { makeSparks, sparkAt, type Spark } from './sparks.ts';

export interface AscendCinematicEvents {
  /** Fired as each beat plays, so audio, haptics or the scene can follow without coupling. */
  'ascendCinematic:beat': { readonly beat: AscendBeat };
}

/** Already-translated text; the cinematic has no i18n of its own. */
export interface AscendCinematicLabels {
  readonly goldBars: string;
  readonly venue: string;
  readonly skip: string;
  /** Read by screen readers when the payout lands, e.g. "+20 Gold Bars". */
  readonly announce: string;
}

export interface AscendCinematicOptions {
  /** The overlay is appended here; usually the UI root laid over the canvas. */
  readonly host: HTMLElement;
  /** The rendered table (the WebGL canvas); it sinks and rises with the cinematic. */
  readonly stage?: HTMLElement | null;
  /** Server-confirmed Gold Bars granted by this ascension. */
  readonly goldBars: number;
  readonly formatAmount: (value: number) => string;
  readonly labels: AscendCinematicLabels;
  readonly reducedMotion: boolean;
  readonly audio?: () => { playImpact(event: ImpactEvent): void } | null;
  /** Called for each beat's haptic; the caller decides whether haptics are on. */
  readonly haptic?: (pattern: HapticPattern) => void;
  readonly events?: Bus<AscendCinematicEvents>;
  readonly seed?: number;
}

const SPARK_FIELD = 320;
const SPARK_LIGHT = rivieraTokens.champagne;
const SPARK_GOLD = rivieraTokens['gold-brushed'];
const SINK_DEPTH = 0.45;
const SINK_SHRINK = 0.14;

/**
 * Plays the 3 s ascension over the game: the stage sinks, a velvet curtain drops, the Gold
 * Bars stamp onto it with a hit-stop and a spark burst, then the curtain lifts as the next
 * venue rises. `done` resolves when it hands back; a tap fast-forwards past the payout.
 */
export class AscendCinematic {
  readonly el: HTMLElement;
  readonly timeline: AscendTimeline;
  readonly done: Promise<void>;
  private readonly beats: readonly AscendBeat[];
  private readonly sparks: readonly Spark[];
  private readonly paint: CanvasRenderingContext2D;
  private readonly curtain: HTMLElement;
  private readonly medallion: HTMLElement;
  private readonly amount: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly title: HTMLElement;
  private readonly announce: HTMLElement;
  private readonly sparkCanvas: HTMLCanvasElement;
  private readonly stageStyle: { transform: string; filter: string } | null;
  private resolve: () => void = () => undefined;
  private realMs = 0;
  private nextBeat = 0;
  private stopFrames: () => void = () => undefined;
  private finished = false;

  constructor(private readonly options: AscendCinematicOptions) {
    if (!Number.isInteger(options.goldBars) || options.goldBars < 0) {
      throw new RangeError(
        `AscendCinematic needs the server's whole, non-negative Gold Bars, got ${options.goldBars}`,
      );
    }
    this.timeline = ascendTimeline(options.reducedMotion);
    this.beats = ascendBeats(this.timeline);
    this.sparks = options.reducedMotion
      ? []
      : makeSparks(sparkCount(options.goldBars), options.seed ?? options.goldBars);
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });

    this.curtain = h(
      'div',
      { class: 'cp-ascend-curtain', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'cp-ascend-fringe' }),
    );
    this.amount = h('span', { class: 'cp-ascend-amount' });
    this.medallion = h(
      'div',
      { class: 'cp-ascend-medallion', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'cp-ascend-medallion-icon' }, icon('goldBar')),
      this.amount,
      h('span', { class: 'cp-ascend-medallion-label', text: options.labels.goldBars }),
    );
    this.sparkCanvas = h('canvas', { class: 'cp-ascend-sparks', attrs: { 'aria-hidden': 'true' } });
    this.flash = h('div', { class: 'cp-ascend-flash', attrs: { 'aria-hidden': 'true' } });
    this.title = h('p', { class: 'cp-ascend-title', text: options.labels.venue });
    this.announce = h('p', { class: 'cp-sr-only', attrs: { 'aria-live': 'assertive' } });
    const skipHint = h('p', {
      class: 'cp-ascend-skip',
      attrs: { 'aria-hidden': 'true' },
      text: options.labels.skip,
    });
    this.el = h(
      'div',
      {
        class: 'cp-ascend',
        attrs: {
          role: 'presentation',
          'data-motion': options.reducedMotion ? 'reduced' : 'full',
          'data-testid': 'ascend-cinematic',
        },
      },
      this.curtain,
      this.flash,
      this.sparkCanvas,
      this.medallion,
      this.title,
      this.announce,
      skipHint,
    );

    const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
    this.sparkCanvas.width = Math.round(SPARK_FIELD * pixelRatio);
    this.sparkCanvas.height = Math.round(SPARK_FIELD * pixelRatio);
    const paint = this.sparkCanvas.getContext('2d');
    if (!paint) throw new Error('AscendCinematic: the browser refused a 2D canvas for the sparks');
    paint.scale(pixelRatio, pixelRatio);
    this.paint = paint;

    const stage = options.stage ?? null;
    this.stageStyle = stage
      ? { transform: stage.style.transform, filter: stage.style.filter }
      : null;

    this.el.addEventListener('pointerdown', this.onSkip);
    options.host.append(this.el);
    this.render();
    this.stopFrames = schedule(this.frame);
  }

  /** Jumps to the payout if it has not landed yet, otherwise straight to the end. */
  skip(): void {
    if (this.finished) return;
    const stampReal = this.beatAt('stamp') + this.timeline.hitStopMs;
    const liftReal = this.beatAt('lift');
    this.realMs = this.realMs < stampReal ? liftReal : this.timeline.totalMs;
    this.advance();
  }

  dispose(): void {
    this.finish();
  }

  private readonly onSkip = (): void => {
    this.skip();
  };

  private readonly frame = (dt: number): boolean => {
    if (this.finished) return false;
    this.realMs += dt * 1000;
    this.advance();
    return !this.finished;
  };

  private advance(): void {
    while (this.nextBeat < this.beats.length) {
      const beat = this.beats[this.nextBeat];
      if (beat === undefined || beat.atMs > this.realMs) break;
      this.nextBeat += 1;
      this.play(beat);
    }
    if (this.realMs >= this.timeline.totalMs) {
      this.finish();
      return;
    }
    this.render();
  }

  private beatAt(kind: AscendBeat['kind']): number {
    const beat = this.beats.find((candidate) => candidate.kind === kind);
    if (beat === undefined) throw new Error(`AscendCinematic: the timeline has no ${kind} beat`);
    return beat.atMs;
  }

  private play(beat: AscendBeat): void {
    const cue = ASCEND_CUES[beat.kind];
    const audio = this.options.audio?.() ?? null;
    for (const sound of cue.sounds) audio?.playImpact(sound);
    if (cue.haptic !== null) this.options.haptic?.(cue.haptic);
    if (beat.kind === 'stamp') this.announce.textContent = this.options.labels.announce;
    this.options.events?.emit('ascendCinematic:beat', { beat });
  }

  private render(): void {
    const ms = cinematicMs(this.realMs, this.timeline);
    const pose = ascendPose(ms, this.timeline, this.options.reducedMotion);
    this.applyPose(pose);
    this.drawSparks(ms - this.timeline.stampAtMs);
  }

  private applyPose(pose: AscendPose): void {
    const { el } = this;
    el.style.setProperty('--cp-ascend-curtain', pose.curtain.toFixed(4));
    el.style.setProperty('--cp-ascend-curtain-opacity', pose.curtainOpacity.toFixed(3));
    el.style.setProperty('--cp-ascend-stamp', pose.stamp.toFixed(4));
    el.style.setProperty('--cp-ascend-flash', pose.flash.toFixed(3));
    el.style.setProperty('--cp-ascend-shake', `${pose.shake.toFixed(2)}px`);
    el.style.setProperty('--cp-ascend-title', pose.title.toFixed(3));
    const shown = Math.round(this.options.goldBars * pose.count);
    const text = `+${this.options.formatAmount(shown)}`;
    if (this.amount.textContent !== text) this.amount.textContent = text;
    const stage = this.options.stage;
    if (!stage) return;
    const depth = pose.sink * SINK_DEPTH * 100;
    const scale = 1 - pose.sink * SINK_SHRINK;
    stage.style.transform =
      pose.sink === 0 ? '' : `translateY(${depth.toFixed(2)}%) scale(${scale.toFixed(4)})`;
    stage.style.filter = pose.stageLight >= 1 ? '' : `brightness(${pose.stageLight.toFixed(3)})`;
  }

  private drawSparks(sinceStampMs: number): void {
    const { paint } = this;
    paint.clearRect(0, 0, SPARK_FIELD, SPARK_FIELD);
    if (sinceStampMs < 0) return;
    const centre = SPARK_FIELD / 2;
    for (const spark of this.sparks) {
      const frame = sparkAt(spark, sinceStampMs);
      if (frame === null) continue;
      paint.globalAlpha = frame.alpha;
      paint.fillStyle = frame.tint > 0.5 ? SPARK_GOLD : SPARK_LIGHT;
      paint.beginPath();
      paint.arc(centre + frame.x, centre + frame.y, frame.radius, 0, Math.PI * 2);
      paint.fill();
    }
    paint.globalAlpha = 1;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopFrames();
    this.el.removeEventListener('pointerdown', this.onSkip);
    const stage = this.options.stage;
    if (stage && this.stageStyle) {
      stage.style.transform = this.stageStyle.transform;
      stage.style.filter = this.stageStyle.filter;
    }
    this.el.remove();
    this.resolve();
  }
}
