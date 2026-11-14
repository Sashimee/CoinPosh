import './safe.css';
import type { Rarity } from '@coinposh/shared';
import type { Bus } from '../../../app/bus.ts';
import type { HapticPattern } from '../../../app/feedback.ts';
import type { DuckOptions, ImpactEvent } from '../../../audio/index.ts';
import { h, rectOf } from '../../../ui/dom.ts';
import { schedule } from '../../../ui/motion/loop.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../palette.ts';
import { makeSparks, sparkAt, type Spark } from '../ascend/sparks.ts';
import {
  beatAt,
  flyPose,
  linePose,
  SAFE_COLLECT_CUE,
  safeBeats,
  safeCinematicMs,
  safeCue,
  safePose,
  safeRevealDuck,
  safeSparkCount,
  safeTimeline,
  type SafeBeat,
  type SafeCue,
  type SafeOpenedBy,
  type SafePose,
  type SafeTimeline,
} from './plan.ts';

export interface SafeCinematicEvents {
  /** Fired as each beat plays, so the scene or analytics can follow without coupling. */
  'safeCinematic:beat': { readonly beat: SafeBeat };
  /** The player collected (tap, key or the auto-collect); the contents are on their way. */
  'safeCinematic:collect': { readonly auto: boolean };
}

/** One content line, already translated. */
export interface SafeCinematicLine {
  readonly name: string;
  readonly detail: string | null;
  /** Item rarity for charms and album cards; null for currency and plain items. */
  readonly rarity: Rarity | null;
  readonly chip: string | null;
  /** Currency lines fly to the wallet plaque through `onCollect`; items fly to `flyTarget`. */
  readonly kind: 'currency' | 'item';
}

/** Already-translated text; the cinematic has no i18n of its own. */
export interface SafeCinematicLabels {
  readonly title: string;
  /** The roll's rarity, shown on the vault once the door is open. */
  readonly rarity: string;
  readonly collect: string;
  readonly skip: string;
  /** Read by screen readers when the contents land, e.g. "Rare safe: +1,200 Coins". */
  readonly announce: string;
}

export interface SafeAudioPort {
  playImpact(event: ImpactEvent): void;
  duckMusic?(options: DuckOptions): void;
}

export interface SafeCinematicOptions {
  /** The overlay is appended here; usually the UI root laid over the canvas. */
  readonly host: HTMLElement;
  readonly openedBy: SafeOpenedBy;
  /** The server's roll rarity. */
  readonly rarity: Rarity;
  readonly lines: readonly SafeCinematicLine[];
  readonly labels: SafeCinematicLabels;
  readonly reducedMotion: boolean;
  readonly audio?: () => SafeAudioPort | null;
  /** Called for each beat's haptic; the caller decides whether haptics are on. */
  readonly haptic?: (pattern: HapticPattern) => void;
  readonly events?: Bus<SafeCinematicEvents>;
  /** Where item lines fly on collect, usually the inventory button. */
  readonly flyTarget?: () => Element | null;
  /** The currency lines' elements at the collect, for the wallet plaque to fly from. */
  readonly onCollect?: (currencyLines: readonly HTMLElement[]) => void;
  readonly seed?: number;
}

export type SafeCinematicPhase = 'opening' | 'settled' | 'collecting' | 'done';

const SPARK_FIELD = 340;

interface FlyingLine {
  readonly el: HTMLElement;
  readonly dx: number;
  readonly dy: number;
}

/**
 * The safe opening over the game: the vault lands, a Key turns (Key opens only), the dial
 * spins through its combination with a ratchet tick per notch, the bolt slides, time freezes
 * as it clears and the door swings open on its weight. Light in the roll's rarity spills out,
 * the contents pop up one by one, and a collect flies them into the HUD. `done` resolves once
 * the overlay has gone; a tap skips to the contents, a second tap collects.
 */
export class SafeCinematic {
  readonly el: HTMLElement;
  readonly timeline: SafeTimeline;
  readonly done: Promise<void>;
  readonly beats: readonly SafeBeat[];
  private readonly sparks: readonly Spark[];
  private readonly paint: CanvasRenderingContext2D;
  private readonly sparkCanvas: HTMLCanvasElement;
  private readonly lineEls: readonly HTMLElement[];
  private readonly collectButton: HTMLButtonElement;
  private readonly announce: HTMLElement;
  private readonly sparkColors: readonly string[];
  private resolve: () => void = () => undefined;
  private realMs = 0;
  private settledMs = 0;
  private flyMs = 0;
  private nextBeat = 0;
  private flying: readonly FlyingLine[] = [];
  private stopFrames: () => void = () => undefined;
  private current: SafeCinematicPhase = 'opening';

  constructor(private readonly options: SafeCinematicOptions) {
    if (options.lines.length === 0) {
      throw new RangeError('SafeCinematic needs the server roll to hold at least one reward');
    }
    this.timeline = safeTimeline(options.reducedMotion, options.openedBy);
    this.beats = safeBeats(this.timeline);
    this.sparks = options.reducedMotion
      ? []
      : makeSparks(safeSparkCount(options.rarity), options.seed ?? options.lines.length);
    this.sparkColors =
      options.rarity === 'heirloom'
        ? HEIRLOOM_PRISM
        : [RARITY_COLORS[options.rarity], RARITY_COLORS.legendary];
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });

    this.lineEls = options.lines.map((line) =>
      h(
        'li',
        {
          class: 'cp-safe-line',
          attrs: {
            'data-kind': line.kind,
            ...(line.rarity === null ? {} : { 'data-rarity': line.rarity }),
          },
        },
        h('span', { class: 'cp-safe-line-name', text: line.name }),
        line.chip === null ? null : h('span', { class: 'cp-safe-line-chip', text: line.chip }),
        line.detail === null
          ? null
          : h('span', { class: 'cp-safe-line-detail', text: line.detail }),
      ),
    );
    this.lineEls.forEach((el, index) => {
      const rarity = options.lines[index]?.rarity ?? null;
      if (rarity !== null) el.style.setProperty('--cp-safe-line-accent', RARITY_COLORS[rarity]);
    });

    const dial = h(
      'div',
      { class: 'cp-safe-dial' },
      h('span', { class: 'cp-safe-dial-face' }),
      h('span', { class: 'cp-safe-dial-mark' }),
    );
    const door = h(
      'div',
      { class: 'cp-safe-door' },
      h('span', { class: 'cp-safe-door-rim' }),
      dial,
      h('span', { class: 'cp-safe-handle' }),
      h('span', { class: 'cp-safe-bolt' }),
      h('span', { class: 'cp-safe-hinge' }),
    );
    const key =
      options.openedBy === 'key' && !options.reducedMotion
        ? h('span', { class: 'cp-safe-key' }, h('span', { class: 'cp-safe-key-bow' }))
        : null;
    this.sparkCanvas = h('canvas', { class: 'cp-safe-sparks' });
    const vault = h(
      'div',
      { class: 'cp-safe-vault', attrs: { 'aria-hidden': 'true' } },
      h('span', { class: 'cp-safe-interior' }, h('span', { class: 'cp-safe-glow' })),
      door,
      key,
    );
    this.collectButton = h('button', {
      class: 'cp-buy cp-safe-collect',
      attrs: { type: 'button', 'data-testid': 'safe-collect' },
      text: options.labels.collect,
    });
    this.announce = h('p', { class: 'cp-sr-only', attrs: { 'aria-live': 'assertive' } });
    this.el = h(
      'div',
      {
        class: 'cp-safe',
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': options.labels.title,
          'data-motion': options.reducedMotion ? 'reduced' : 'full',
          'data-rarity': options.rarity,
          'data-phase': 'opening',
          'data-testid': 'safe-cinematic',
        },
      },
      h('div', { class: 'cp-safe-veil' }),
      h('div', { class: 'cp-safe-flash', attrs: { 'aria-hidden': 'true' } }),
      h(
        'div',
        { class: 'cp-safe-stage' },
        h('p', { class: 'cp-safe-title', text: options.labels.title }),
        vault,
        this.sparkCanvas,
        h('p', { class: 'cp-safe-rarity', text: options.labels.rarity }),
        h('ul', { class: 'cp-safe-lines' }, ...this.lineEls),
        this.collectButton,
      ),
      this.announce,
      h('p', {
        class: 'cp-safe-skip',
        attrs: { 'aria-hidden': 'true' },
        text: options.labels.skip,
      }),
    );
    this.el.style.setProperty('--cp-safe-accent', RARITY_COLORS[options.rarity]);
    if (options.rarity === 'heirloom') {
      this.el.style.setProperty('--cp-safe-prism', HEIRLOOM_PRISM.join(', '));
    }

    const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
    this.sparkCanvas.width = Math.round(SPARK_FIELD * pixelRatio);
    this.sparkCanvas.height = Math.round(SPARK_FIELD * pixelRatio);
    const paint = this.sparkCanvas.getContext('2d');
    if (!paint) throw new Error('SafeCinematic: the browser refused a 2D canvas for the sparks');
    paint.scale(pixelRatio, pixelRatio);
    this.paint = paint;

    this.el.addEventListener('pointerdown', this.onPointer);
    this.collectButton.addEventListener('click', this.onCollectClick);
    this.el.ownerDocument.addEventListener('keydown', this.onKey);
    options.host.append(this.el);
    this.render();
    this.stopFrames = schedule(this.frame);
  }

  get phase(): SafeCinematicPhase {
    return this.current;
  }

  /** Jumps to the contents if the door is still closed; collects once they are up. */
  skip(): void {
    if (this.current === 'opening') {
      const reveal = beatAt(this.beats, 'reveal');
      while (this.nextBeat < this.beats.length) {
        const beat = this.beats[this.nextBeat];
        if (beat === undefined || beat.atMs >= reveal) break;
        this.nextBeat += 1;
      }
      this.realMs = beatAt(this.beats, 'settled');
      this.advance();
      return;
    }
    this.collect(false);
  }

  /** Sends the contents into the HUD; does nothing before they are up or after the first call. */
  collect(auto = false): void {
    if (this.current !== 'settled') return;
    this.current = 'collecting';
    this.el.dataset.phase = 'collecting';
    this.cue(SAFE_COLLECT_CUE);
    this.options.events?.emit('safeCinematic:collect', { auto });
    const target = this.options.flyTarget?.() ?? null;
    const goal = target === null ? null : centre(rectOf(target));
    const currency: HTMLElement[] = [];
    const items: FlyingLine[] = [];
    this.options.lines.forEach((line, index) => {
      const el = this.lineEls[index];
      if (el === undefined) return;
      if (line.kind === 'currency') {
        currency.push(el);
        return;
      }
      const from = centre(rectOf(el));
      items.push({ el, dx: goal ? goal.x - from.x : 0, dy: goal ? goal.y - from.y : 0 });
    });
    this.flying = items;
    this.options.onCollect?.(currency);
    this.render();
  }

  dispose(): void {
    this.finish();
  }

  private readonly onPointer = (event: Event): void => {
    if (event.target === this.collectButton) return;
    this.skip();
  };

  private readonly onCollectClick = (): void => {
    if (this.current === 'opening') {
      this.skip();
      return;
    }
    this.collect(false);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || this.current === 'collecting' || this.current === 'done') return;
    if (event.key !== 'Escape' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.skip();
  };

  private readonly frame = (dt: number): boolean => {
    if (this.current === 'done') return false;
    const step = dt * 1000;
    if (this.current === 'collecting') {
      this.flyMs += step;
      if (this.flyMs >= this.timeline.flyMs) {
        this.finish();
        return false;
      }
      this.render();
      return true;
    }
    if (this.current === 'settled') {
      this.settledMs += step;
      if (this.settledMs >= this.timeline.autoCollectMs) this.collect(true);
    }
    this.realMs += step;
    this.advance();
    return true;
  };

  private advance(): void {
    while (this.nextBeat < this.beats.length) {
      const beat = this.beats[this.nextBeat];
      if (beat === undefined || beat.atMs > this.realMs) break;
      this.nextBeat += 1;
      this.play(beat);
    }
    this.render();
  }

  private play(beat: SafeBeat): void {
    this.cue(safeCue(beat, this.options.rarity));
    if (beat.kind === 'reveal') {
      this.options.audio?.()?.duckMusic?.(safeRevealDuck(this.options.rarity));
      this.announce.textContent = this.options.labels.announce;
      this.el.dataset.revealed = 'true';
    }
    if (beat.kind === 'settled' && this.current === 'opening') {
      this.current = 'settled';
      this.el.dataset.phase = 'settled';
      this.collectButton.focus({ preventScroll: true });
    }
    this.options.events?.emit('safeCinematic:beat', { beat });
  }

  private cue(cue: SafeCue): void {
    const audio = this.options.audio?.() ?? null;
    for (const sound of cue.sounds) audio?.playImpact(sound);
    if (cue.haptic !== null) this.options.haptic?.(cue.haptic);
  }

  private render(): void {
    const { reducedMotion } = this.options;
    const ms = safeCinematicMs(this.realMs, this.timeline);
    this.applyPose(safePose(ms, this.timeline, reducedMotion));
    this.lineEls.forEach((el, index) => {
      const pose = linePose(ms, index, this.timeline, reducedMotion);
      el.style.setProperty('--cp-safe-line-shown', pose.shown.toFixed(3));
      el.style.setProperty('--cp-safe-line-scale', pose.scale.toFixed(4));
      el.style.setProperty('--cp-safe-line-rise', `${pose.rise.toFixed(2)}px`);
    });
    const fly = flyPose(this.flyMs, this.timeline, reducedMotion);
    this.el.style.setProperty(
      '--cp-safe-fade',
      this.current === 'collecting' ? fly.fade.toFixed(3) : '1',
    );
    for (const line of this.flying) {
      line.el.style.setProperty('--cp-safe-fly-x', `${(line.dx * fly.travel).toFixed(1)}px`);
      line.el.style.setProperty('--cp-safe-fly-y', `${(line.dy * fly.travel).toFixed(1)}px`);
      line.el.style.setProperty('--cp-safe-fly-scale', fly.scale.toFixed(4));
    }
    this.drawSparks(ms - this.timeline.revealAtMs);
  }

  private applyPose(pose: SafePose): void {
    const { style } = this.el;
    style.setProperty('--cp-safe-veil', pose.veil.toFixed(3));
    style.setProperty('--cp-safe-vault', pose.vault.toFixed(4));
    style.setProperty('--cp-safe-vault-opacity', pose.vaultOpacity.toFixed(3));
    style.setProperty('--cp-safe-key-in', (pose.keyIn ?? 0).toFixed(4));
    style.setProperty('--cp-safe-key-turn', `${pose.keyTurn.toFixed(2)}deg`);
    style.setProperty('--cp-safe-dial', `${pose.dial.toFixed(2)}deg`);
    style.setProperty('--cp-safe-bolt', pose.bolt.toFixed(4));
    style.setProperty('--cp-safe-swing', `${(-pose.swing).toFixed(2)}deg`);
    style.setProperty('--cp-safe-door', pose.door.toFixed(3));
    style.setProperty('--cp-safe-glow', pose.glow.toFixed(3));
    style.setProperty('--cp-safe-flash', pose.flash.toFixed(3));
    style.setProperty('--cp-safe-shake', `${pose.shake.toFixed(2)}px`);
  }

  private drawSparks(sinceRevealMs: number): void {
    const { paint } = this;
    paint.clearRect(0, 0, SPARK_FIELD, SPARK_FIELD);
    if (sinceRevealMs < 0 || this.current === 'collecting') return;
    const middle = SPARK_FIELD / 2;
    const colors = this.sparkColors;
    for (const spark of this.sparks) {
      const frame = sparkAt(spark, sinceRevealMs);
      if (frame === null) continue;
      paint.globalAlpha = frame.alpha;
      paint.fillStyle =
        colors[Math.min(colors.length - 1, Math.floor(frame.tint * colors.length))] ?? '';
      paint.beginPath();
      paint.arc(middle + frame.x, middle + frame.y, frame.radius, 0, Math.PI * 2);
      paint.fill();
    }
    paint.globalAlpha = 1;
  }

  private finish(): void {
    if (this.current === 'done') return;
    this.current = 'done';
    this.stopFrames();
    this.el.removeEventListener('pointerdown', this.onPointer);
    this.collectButton.removeEventListener('click', this.onCollectClick);
    this.el.ownerDocument.removeEventListener('keydown', this.onKey);
    this.el.remove();
    this.resolve();
  }
}

function centre(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
