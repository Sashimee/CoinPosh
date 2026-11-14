import './scratch.css';
import { SCRATCH_GRID_SIZE, type Rarity } from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { HapticPattern } from '../../app/feedback.ts';
import type { DuckOptions, ImpactEvent } from '../../audio/index.ts';
import { h, rectOf } from '../../ui/dom.ts';
import { schedule } from '../../ui/motion/loop.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../palette.ts';
import { ScratchFlow, type ScratchStep } from './flow.ts';
import { BRUSH_RADIUS, strokeStamps, type ScratchPoint } from './mask.ts';
import {
  autoRevealPath,
  cellSweepPath,
  clearAmount,
  enterPose,
  flakeSpawns,
  flarePose,
  flyPose,
  matchDuck,
  matchGlintSpawns,
  pathPoint,
  prizeCount,
  prizeLinePose,
  ScrapeVoice,
  scratchCue,
  scratchTimeline,
  sealingPose,
  seededRandom,
  sweepProgress,
  SWEEP_RADIUS,
  type ScratchCue,
  type ScratchTimeline,
} from './plan.ts';
import { createScratchSurface, SURFACE_MARGIN, type ScratchSurface } from './surface.ts';

export interface ScratchAudioPort {
  playImpact(event: ImpactEvent): void;
  duckMusic?(options: DuckOptions): void;
}

/** Already-translated text for the sealed card; the card has no i18n of its own. */
export interface ScratchCardLabels {
  readonly title: string;
  readonly rule: string;
  /** "Card 1 of 3"; empty to hide. */
  readonly count: string;
  readonly scratch: string;
  readonly sealing: string;
  readonly revealAll: string;
  readonly collect: string;
  readonly close: string;
  readonly hint: string;
  readonly odds: string;
  /** A covered cell's accessible name, by position (1-based). */
  readonly coveredCell: (position: number) => string;
}

/** One prize line, already translated. Currency lines count up through `count`. */
export interface ScratchPrizeLine {
  readonly kind: 'currency' | 'item';
  readonly name: string;
  readonly detail: string | null;
  readonly rarity: Rarity | null;
  readonly chip: string | null;
  /** The line's text with `share` (0..1) of its amount shown, for the count-up. */
  readonly count?: (share: number) => string;
}

/** The server's answer, with the words that go with it. */
export interface ScratchAnswer {
  readonly grid: readonly Rarity[];
  readonly rarity: Rarity;
  readonly lines: readonly ScratchPrizeLine[];
  /** Each gem's name by rarity, for the cells and the announcements. */
  readonly gemName: (rarity: Rarity) => string;
  /** A cell's accessible name once uncovered, by position (1-based). */
  readonly uncoveredCell: (position: number, gem: string) => string;
  /** Read out when the match lands, e.g. "Three Rare gems: +1,200 Coins". */
  readonly announce: string;
  /** The rarity chip over the prize, e.g. "Rare". */
  readonly rarityName: string;
  /** The Certified Fair chip's text, e.g. "Certified Fair #42". */
  readonly fair: string;
  readonly fairLabel: string;
}

export interface ScratchCardEvents {
  'scratchCard:uncovered': { readonly cell: number; readonly rarity: Rarity };
  /** The three gems flared: the result is on screen. */
  'scratchCard:matched': { readonly rarity: Rarity; readonly cells: readonly number[] };
  /** The prize has settled; COLLECT is offered and waits for the player. */
  'scratchCard:settled': Record<string, never>;
  'scratchCard:collect': Record<string, never>;
}

export type ScratchCardPhase =
  | 'sealed'
  | 'revealing'
  | 'scratching'
  | 'sweeping'
  | 'clearing'
  | 'matched'
  | 'settled'
  | 'collecting'
  | 'done';

export interface ScratchCardOptions {
  readonly host: HTMLElement;
  readonly labels: ScratchCardLabels;
  readonly reducedMotion: boolean;
  /** The player asked to scratch: ask the house for the grid, then call `reveal` or `refuse`. */
  readonly onBegin: () => void;
  /** The currency lines' elements at the collect, for the wallet plaque to fly from. */
  readonly onCollect?: (currencyLines: readonly HTMLElement[]) => void;
  /** The close button or Escape before a prize is up. */
  readonly onClose?: () => void;
  /** The odds (sealed) or the proof (revealed) chip was pressed. */
  readonly onFair?: (trigger: HTMLElement, revealed: boolean) => void;
  readonly audio?: () => ScratchAudioPort | null;
  readonly haptic?: (pattern: HapticPattern) => void;
  readonly events?: Bus<ScratchCardEvents>;
  /** Where item lines fly on collect, usually the inventory button. */
  readonly flyTarget?: () => Element | null;
  /** Starts the foil; the default tries WebGPU, then WebGL2, then a 2D canvas. */
  readonly surface?: () => Promise<ScratchSurface>;
  readonly seed?: number;
}

interface Stroke {
  readonly pointerId: number;
  last: ScratchPoint | null;
  lastAt: number;
}

interface Sweep {
  readonly path: readonly ScratchPoint[];
  readonly durationMs: number;
  readonly radius: number;
  ms: number;
  last: ScratchPoint | null;
}

interface FlyingLine {
  readonly el: HTMLElement;
  readonly dx: number;
  readonly dy: number;
}

const SCRAPE_HAPTIC_EVERY = 3;

/**
 * The scratch card over the game. The foil is whole until the house has rolled: the first
 * touch (or "Scratch it") asks for the grid, and only once it is painted under the foil does
 * the brush uncover anything. Each stroke rasps, throws foil flakes and pops the gems it
 * clears; once enough is off the rest dissolves, time freezes on the three matching gems,
 * they flare in their rarity and the prize counts up. COLLECT waits for the player.
 */
export class ScratchCard {
  readonly el: HTMLElement;
  readonly timeline: ScratchTimeline;
  readonly done: Promise<void>;
  readonly flow = new ScratchFlow();
  private readonly ticket: HTMLElement;
  private readonly window: HTMLElement;
  private readonly cells: readonly HTMLButtonElement[];
  private readonly gems: readonly HTMLElement[];
  private readonly cta: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly fairButton: HTMLButtonElement;
  private readonly prize: HTMLElement;
  private readonly prizeRarity: HTMLElement;
  private readonly prizeList: HTMLUListElement;
  private readonly hint: HTMLElement;
  private readonly announcer: HTMLElement;
  private readonly random: () => number;
  private readonly scrape = new ScrapeVoice();
  private surface: ScratchSurface | null = null;
  /** No foil could start: the CSS cover stands in and fades away instead of being scratched. */
  private foilless = false;
  private pendingRevealAll = false;
  private answer: ScratchAnswer | null = null;
  private lineEls: HTMLElement[] = [];
  private current: ScratchCardPhase = 'sealed';
  private stroke: Stroke | null = null;
  private sweep: Sweep | null = null;
  private pendingCell: number | null = null;
  private resolve: () => void = () => undefined;
  private stopFrames: () => void = () => undefined;
  private ms = 0;
  private phaseMs = 0;
  private hitStopMs = 0;
  private flakesThisFrame = 0;
  private scrapes = 0;
  private uncoveredCount = 0;
  private flying: readonly FlyingLine[] = [];
  private tilt = { x: 0, y: 0 };
  private disposed = false;

  constructor(private readonly options: ScratchCardOptions) {
    this.timeline = scratchTimeline(options.reducedMotion);
    this.random = seededRandom(options.seed ?? 0x5c2a7c4);
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
    const { labels } = options;

    this.gems = Array.from({ length: SCRATCH_GRID_SIZE }, () =>
      h('span', { class: 'cp-scratch-gem', attrs: { 'aria-hidden': 'true' } }),
    );
    this.cells = this.gems.map((gem, index) =>
      h(
        'button',
        {
          class: 'cp-scratch-cell',
          attrs: {
            type: 'button',
            'data-cell': String(index),
            'aria-label': labels.coveredCell(index + 1),
          },
        },
        gem,
      ),
    );
    this.window = h(
      'div',
      { class: 'cp-scratch-window', attrs: { 'data-testid': 'scratch-window' } },
      h(
        'div',
        { class: 'cp-scratch-grid', attrs: { role: 'group', 'aria-label': labels.hint } },
        ...this.cells,
      ),
      h('div', { class: 'cp-scratch-cover', attrs: { 'aria-hidden': 'true' } }),
    );
    this.hint = h('p', { class: 'cp-scratch-hint', text: labels.hint });
    this.prizeRarity = h('p', { class: 'cp-scratch-prize-rarity' });
    this.prizeList = h('ul', { class: 'cp-scratch-lines' });
    this.prize = h(
      'div',
      { class: 'cp-scratch-prize', attrs: { 'aria-hidden': 'true' } },
      this.prizeRarity,
      this.prizeList,
    );
    this.cta = h('button', {
      class: 'cp-buy cp-scratch-cta',
      attrs: { type: 'button', 'data-testid': 'scratch-cta' },
      text: labels.scratch,
    });
    this.closeButton = h('button', {
      class: 'cp-scratch-close',
      attrs: { type: 'button', 'aria-label': labels.close, 'data-testid': 'scratch-close' },
      text: '×',
    });
    this.fairButton = h('button', {
      class: 'cp-scratch-fair',
      attrs: { type: 'button', 'data-testid': 'scratch-fair' },
      text: labels.odds,
    });
    this.announcer = h('p', { class: 'cp-sr-only', attrs: { 'aria-live': 'polite' } });
    this.ticket = h(
      'div',
      { class: 'cp-scratch-ticket' },
      this.closeButton,
      labels.count === '' ? null : h('p', { class: 'cp-scratch-count', text: labels.count }),
      h('h2', { class: 'cp-scratch-title', text: labels.title }),
      h('p', { class: 'cp-scratch-rule', text: labels.rule }),
      this.window,
      this.hint,
      this.prize,
      h('div', { class: 'cp-scratch-actions' }, this.fairButton, this.cta),
    );
    this.el = h(
      'div',
      {
        class: 'cp-scratch',
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': labels.title,
          'data-motion': options.reducedMotion ? 'reduced' : 'full',
          'data-phase': 'sealed',
          'data-testid': 'scratch-card',
        },
      },
      h('div', { class: 'cp-scratch-veil' }),
      h('div', { class: 'cp-scratch-flash', attrs: { 'aria-hidden': 'true' } }),
      this.ticket,
      this.announcer,
    );

    this.window.addEventListener('pointerdown', this.onPointerDown);
    this.window.addEventListener('pointermove', this.onPointerMove);
    this.window.addEventListener('pointerup', this.onPointerUp);
    this.window.addEventListener('pointercancel', this.onPointerUp);
    this.window.addEventListener('pointerleave', this.onPointerLeave);
    for (const cell of this.cells) cell.addEventListener('click', this.onCellClick);
    this.cta.addEventListener('click', this.onCta);
    this.closeButton.addEventListener('click', this.onCloseClick);
    this.fairButton.addEventListener('click', this.onFairClick);
    this.el.ownerDocument.addEventListener('keydown', this.onKey);
    globalThis.addEventListener('resize', this.onResize);
    options.host.append(this.el);
    this.render();
    this.stopFrames = schedule(this.frame);
    this.cta.focus({ preventScroll: true });
    void this.startSurface();
  }

  get phase(): ScratchCardPhase {
    return this.current;
  }

  /** The foil is up and drawn: scratching can show the gems. */
  get ready(): boolean {
    return this.surface !== null;
  }

  /** The house's grid. Paints the gems under the foil; scratching uncovers them from here on. */
  reveal(answer: ScratchAnswer): void {
    if (this.current !== 'revealing') {
      throw new Error(`ScratchCard.reveal came while the card was ${this.current}, not revealing`);
    }
    this.flow.accept(answer.grid, answer.rarity);
    this.answer = answer;
    answer.grid.forEach((rarity, index) => {
      const gem = this.gems[index];
      if (gem === undefined) return;
      gem.dataset.rarity = rarity;
      gem.style.setProperty('--cp-gem', RARITY_COLORS[rarity]);
    });
    this.lineEls = answer.lines.map((line) => {
      const el = h(
        'li',
        {
          class: 'cp-scratch-line',
          attrs: {
            'data-kind': line.kind,
            ...(line.rarity === null ? {} : { 'data-rarity': line.rarity }),
          },
        },
        h('span', { class: 'cp-scratch-line-name', text: line.count ? line.count(0) : line.name }),
        line.chip === null ? null : h('span', { class: 'cp-scratch-line-chip', text: line.chip }),
        line.detail === null
          ? null
          : h('span', { class: 'cp-scratch-line-detail', text: line.detail }),
      );
      if (line.rarity !== null)
        el.style.setProperty('--cp-scratch-line-accent', RARITY_COLORS[line.rarity]);
      return el;
    });
    this.prizeList.replaceChildren(...this.lineEls);
    this.prizeRarity.textContent = answer.rarityName;
    this.el.style.setProperty('--cp-scratch-accent', RARITY_COLORS[answer.rarity]);
    if (answer.rarity === 'heirloom')
      this.el.style.setProperty('--cp-scratch-prism', HEIRLOOM_PRISM.join(', '));
    this.el.dataset.rarity = answer.rarity;
    this.fairButton.textContent = answer.fair;
    this.fairButton.setAttribute('aria-label', answer.fairLabel);
    this.cue(scratchCue('live', null));
    this.setPhase('scratching');
    this.cta.textContent = this.options.labels.revealAll;
    this.cta.disabled = false;
    if (this.foilless) {
      this.pendingCell = null;
      this.startClearing();
      return;
    }
    if (this.pendingCell !== null) {
      const cell = this.pendingCell;
      this.pendingCell = null;
      this.sweepCell(cell);
    }
  }

  /** The house turned the reveal down: the card is whole again, with `message` said aloud. */
  refuse(message: string): void {
    if (this.current !== 'revealing') return;
    this.flow.refuse();
    this.pendingCell = null;
    this.pendingRevealAll = false;
    this.stroke = null;
    this.setPhase('sealed');
    this.cta.textContent = this.options.labels.scratch;
    this.cta.disabled = false;
    this.hint.textContent = message;
    this.hint.dataset.tone = 'deny';
    this.announcer.textContent = message;
    this.cue(scratchCue('deny', null));
  }

  /**
   * "Reveal all": a wide brush sweeps the window, or (reduced motion) the foil fades. Asked
   * before the foil is up, it waits for it with the button held down.
   */
  revealAll(): void {
    if (this.current !== 'scratching') return;
    this.stroke = null;
    if (this.surface === null && !this.foilless) {
      this.pendingRevealAll = true;
      this.pendingCell = null;
      this.cta.disabled = true;
      return;
    }
    if (this.timeline.autoRevealMs === 0 || this.surface === null) {
      this.startClearing();
      return;
    }
    this.sweep = {
      path: autoRevealPath(),
      durationMs: this.timeline.autoRevealMs,
      radius: SWEEP_RADIUS,
      ms: 0,
      last: null,
    };
    this.setPhase('sweeping');
    this.cta.disabled = true;
  }

  /** Sends the prize into the HUD. Only once it has settled, and only the first time. */
  collect(): void {
    if (this.current !== 'settled' || !this.flow.collect()) return;
    this.setPhase('collecting');
    this.cta.disabled = true;
    this.cue(scratchCue('collect', null));
    this.options.events?.emit('scratchCard:collect', {});
    const target = this.options.flyTarget?.() ?? null;
    const goal = target === null ? null : centre(rectOf(target));
    const currency: HTMLElement[] = [];
    const items: FlyingLine[] = [];
    this.answer?.lines.forEach((line, index) => {
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
  }

  dispose(): void {
    this.finish();
  }

  private async startSurface(): Promise<void> {
    let surface: ScratchSurface;
    try {
      surface = await (this.options.surface ?? createScratchSurface)();
    } catch (error) {
      console.error(
        'CoinPosh scratch: no foil surface could start; the card fades its cover to show the prize',
        error,
      );
      if (this.disposed) return;
      this.foilless = true;
      this.el.dataset.foil = 'none';
      if (this.current === 'scratching') {
        this.pendingCell = null;
        this.pendingRevealAll = false;
        this.startClearing();
      }
      return;
    }
    if (this.disposed) {
      surface.dispose();
      return;
    }
    this.surface = surface;
    surface.canvas.classList.add('cp-scratch-foil');
    surface.canvas.setAttribute('aria-hidden', 'true');
    surface.canvas.style.setProperty('--cp-scratch-margin', String(SURFACE_MARGIN));
    this.window.append(surface.canvas);
    this.onResize();
    surface.frame(0);
    this.el.dataset.foil = surface.kind;
    if (this.current !== 'scratching') return;
    if (this.pendingRevealAll) {
      this.pendingRevealAll = false;
      this.revealAll();
      return;
    }
    if (this.pendingCell !== null) {
      const cell = this.pendingCell;
      this.pendingCell = null;
      this.sweepCell(cell);
    }
  }

  private begin(): boolean {
    if (this.current !== 'sealed' || !this.flow.begin()) return false;
    this.setPhase('revealing');
    this.hint.textContent = this.options.labels.sealing;
    delete this.hint.dataset.tone;
    this.cta.textContent = this.options.labels.sealing;
    this.cta.disabled = true;
    this.cue(scratchCue('seal', null));
    this.options.onBegin();
    return true;
  }

  private pointOf(event: PointerEvent): ScratchPoint {
    const rect = rectOf(this.window);
    return {
      x: (event.clientX - rect.left) / Math.max(rect.width, 1),
      y: (event.clientY - rect.top) / Math.max(rect.height, 1),
    };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.stroke !== null) return;
    if (this.current === 'sealed') this.begin();
    if (this.current !== 'revealing' && this.current !== 'scratching') return;
    event.preventDefault();
    this.window.setPointerCapture(event.pointerId);
    const point = this.pointOf(event);
    this.stroke = { pointerId: event.pointerId, last: null, lastAt: event.timeStamp };
    this.scrape.reset();
    this.drawStroke(point, event.timeStamp);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = this.pointOf(event);
    this.surface?.setPointer(point);
    this.aim(point);
    if (this.stroke?.pointerId !== event.pointerId) return;
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const each of events.length > 0 ? events : [event]) {
      this.drawStroke(this.pointOf(each), each.timeStamp);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.stroke?.pointerId !== event.pointerId) return;
    this.stroke = null;
    if (this.window.hasPointerCapture(event.pointerId))
      this.window.releasePointerCapture(event.pointerId);
  };

  private readonly onPointerLeave = (): void => {
    this.surface?.setPointer(null);
    this.aim(null);
  };

  /** The card leans a few degrees toward the finger, as a real ticket held up to the light. */
  private aim(point: ScratchPoint | null): void {
    const deg = this.timeline.tiltDeg;
    this.tilt =
      point === null
        ? { x: 0, y: 0 }
        : { x: (point.x - 0.5) * 2 * deg, y: (0.5 - point.y) * 2 * deg };
  }

  private drawStroke(point: ScratchPoint, at: number): void {
    const stroke = this.stroke;
    if (stroke === null) return;
    if (!this.flow.canScratch || this.surface === null) {
      stroke.last = null;
      return;
    }
    const from = stroke.last;
    const stamps = from === null ? [point] : strokeStamps(from, point);
    const distance = from === null ? 0 : Math.hypot(point.x - from.x, point.y - from.y);
    const seconds = Math.max((at - stroke.lastAt) / 1000, 1 / 240);
    stroke.last = point;
    stroke.lastAt = at;
    const direction = from === null ? { x: 0, y: 1 } : { x: point.x - from.x, y: point.y - from.y };
    this.applyStamps(stamps, BRUSH_RADIUS, direction);
    const voice = this.scrape.advance(point, distance, distance / seconds);
    if (voice !== null) {
      this.options.audio?.()?.playImpact(voice);
      this.scrapes += 1;
      if (this.scrapes % SCRAPE_HAPTIC_EVERY === 0) this.options.haptic?.([4]);
    }
  }

  private applyStamps(
    stamps: readonly ScratchPoint[],
    radius: number,
    direction: { readonly x: number; readonly y: number },
  ): void {
    const surface = this.surface;
    if (surface === null) return;
    for (const stamp of stamps) surface.stamp(stamp, radius);
    const step = this.flow.scratch(stamps, radius);
    if (step.cleared > 0) this.throwFlakes(stamps, direction);
    this.onStep(step);
  }

  private throwFlakes(
    stamps: readonly ScratchPoint[],
    direction: { readonly x: number; readonly y: number },
  ): void {
    const { flakesPerStamp, flakeFrameBudget } = this.timeline;
    if (flakesPerStamp === 0 || this.surface === null) return;
    for (const stamp of stamps) {
      const room = flakeFrameBudget - this.flakesThisFrame;
      if (room <= 0) return;
      const count = Math.min(room, flakesPerStamp);
      this.surface.flakes(flakeSpawns(stamp, direction, count, this.random));
      this.flakesThisFrame += count;
    }
  }

  private onStep(step: ScratchStep): void {
    const grid = this.flow.grid;
    if (grid === null) return;
    for (const cell of step.uncovered) this.uncover(cell, grid);
    if (step.paired.length > 0 && !step.clearing) {
      const rarity = grid[step.paired[0] ?? 0] ?? null;
      this.cue(scratchCue('pair', rarity));
      for (const cell of step.paired) this.gems[cell]?.classList.add('cp-scratch-gem--pair');
    }
    if (step.clearing) this.startClearing(false);
  }

  private uncover(cell: number, grid: readonly Rarity[]): void {
    const rarity = grid[cell];
    const gem = this.gems[cell];
    const button = this.cells[cell];
    const answer = this.answer;
    if (rarity === undefined || gem === undefined || button === undefined || answer === null)
      return;
    if (gem.classList.contains('cp-scratch-gem--shown')) return;
    gem.classList.add('cp-scratch-gem--shown');
    const name = answer.gemName(rarity);
    button.setAttribute('aria-label', answer.uncoveredCell(cell + 1, name));
    button.dataset.uncovered = 'true';
    this.cue(scratchCue('uncover', rarity, this.uncoveredCount));
    this.uncoveredCount += 1;
    this.options.events?.emit('scratchCard:uncovered', { cell, rarity });
  }

  /** The rest of the foil goes. `scratched` is false when the player cleared enough by hand. */
  private startClearing(scratched = true): void {
    if (scratched && this.flow.phase === 'scratching') this.flow.clear();
    const grid = this.flow.grid;
    if (grid === null) return;
    for (let cell = 0; cell < SCRATCH_GRID_SIZE; cell++) this.uncover(cell, grid);
    this.sweep = null;
    this.stroke = null;
    this.setPhase('clearing');
    this.cta.disabled = true;
    this.cue(scratchCue('clear', null));
  }

  private match(): void {
    const match = this.flow.match;
    if (match === null || !this.flow.settle()) return;
    this.setPhase('matched');
    this.hitStopMs = this.timeline.hitStopMs;
    this.surface?.setTimeScale(this.hitStopMs > 0 ? 0 : 1);
    this.cue(scratchCue('match', match.rarity));
    this.options.audio?.()?.duckMusic?.(matchDuck(match.rarity, this.timeline.settleMs / 1000));
    for (const cell of match.cells) this.cells[cell]?.classList.add('cp-scratch-cell--match');
    this.ticket.classList.add('cp-scratch-ticket--won');
    if (this.timeline.matchGlints > 0) {
      this.surface?.glints(
        matchGlintSpawns(match.cells, match.rarity, this.timeline.matchGlints, this.random),
      );
    }
    this.prize.removeAttribute('aria-hidden');
    this.hint.textContent = '';
    if (this.answer !== null) this.announcer.textContent = this.answer.announce;
    this.options.events?.emit('scratchCard:matched', { rarity: match.rarity, cells: match.cells });
  }

  private settle(): void {
    this.setPhase('settled');
    this.cta.textContent = this.options.labels.collect;
    this.cta.disabled = false;
    this.cta.dataset.testid = 'scratch-collect';
    this.cta.focus({ preventScroll: true });
    this.options.events?.emit('scratchCard:settled', {});
  }

  private sweepCell(cell: number): void {
    if (this.current !== 'scratching') return;
    if (this.surface === null) {
      this.pendingCell = cell;
      return;
    }
    const path = cellSweepPath(cell);
    if (this.timeline.cellSweepMs === 0) {
      const stamps = path.flatMap((point, index) => {
        const from = path[index - 1];
        return from === undefined ? [point] : strokeStamps(from, point, SWEEP_RADIUS);
      });
      this.applyStamps(stamps, SWEEP_RADIUS, { x: 1, y: 0 });
      return;
    }
    this.sweep = {
      path,
      durationMs: this.timeline.cellSweepMs,
      radius: SWEEP_RADIUS,
      ms: 0,
      last: null,
    };
  }

  private runSweep(step: number): void {
    const sweep = this.sweep;
    if (sweep === null) return;
    sweep.ms = Math.min(sweep.durationMs, sweep.ms + step);
    const point = pathPoint(sweep.path, sweepProgress(sweep.ms, sweep.durationMs));
    const from = sweep.last;
    sweep.last = point;
    const stamps = from === null ? [point] : strokeStamps(from, point, sweep.radius);
    const direction = from === null ? { x: 1, y: 0 } : { x: point.x - from.x, y: point.y - from.y };
    this.surface?.setPointer(point);
    const distance = from === null ? 0 : Math.hypot(point.x - from.x, point.y - from.y);
    const voice = this.scrape.advance(point, distance, distance / Math.max(step / 1000, 1 / 240));
    if (voice !== null) this.options.audio?.()?.playImpact(voice);
    this.applyStamps(stamps, sweep.radius, direction);
    if (this.sweep !== sweep) return;
    if (sweep.ms >= sweep.durationMs) {
      this.sweep = null;
      this.surface?.setPointer(null);
      if (this.current === 'sweeping') this.startClearing();
    }
  }

  private readonly onCellClick = (event: MouseEvent): void => {
    if (event.detail !== 0) return;
    const cell = Number((event.currentTarget as HTMLElement).dataset.cell);
    if (this.current === 'sealed') {
      this.pendingCell = cell;
      if (!this.begin()) this.pendingCell = null;
      return;
    }
    if (this.current === 'revealing') {
      this.pendingCell = cell;
      return;
    }
    if (this.sweep === null) this.sweepCell(cell);
  };

  private readonly onCta = (): void => {
    if (this.current === 'sealed') this.begin();
    else if (this.current === 'scratching') this.revealAll();
    else if (this.current === 'settled') this.collect();
  };

  private readonly onCloseClick = (): void => {
    this.close();
  };

  private close(): void {
    if (this.current === 'collecting' || this.current === 'done') return;
    if (this.current === 'settled') {
      this.collect();
      return;
    }
    this.options.onClose?.();
    this.finish();
  }

  private readonly onFairClick = (): void => {
    this.options.onFair?.(this.fairButton, this.answer !== null);
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.key !== 'Escape') return;
    event.preventDefault();
    this.close();
  };

  private readonly onResize = (): void => {
    const surface = this.surface;
    if (surface === null) return;
    surface.resize(
      rectOf(this.window).width || this.window.clientWidth,
      globalThis.devicePixelRatio || 1,
    );
  };

  private setPhase(phase: ScratchCardPhase): void {
    this.current = phase;
    this.phaseMs = 0;
    this.el.dataset.phase = phase;
  }

  private cue(cue: ScratchCue): void {
    const audio = this.options.audio?.() ?? null;
    for (const sound of cue.sounds) audio?.playImpact(sound);
    if (cue.haptic !== null) this.options.haptic?.(cue.haptic);
  }

  private readonly frame = (dt: number): boolean => {
    if (this.current === 'done') return false;
    const real = dt * 1000;
    this.flakesThisFrame = 0;
    if (this.hitStopMs > 0) {
      this.hitStopMs -= real;
      if (this.hitStopMs <= 0) this.surface?.setTimeScale(1);
      this.surface?.frame(dt);
      return true;
    }
    this.ms += real;
    this.phaseMs += real;
    if (this.current === 'sweeping' || (this.current === 'scratching' && this.sweep !== null))
      this.runSweep(real);
    if (this.current === 'clearing' && this.phaseMs >= this.timeline.clearMs) this.match();
    if (this.current === 'matched' && this.phaseMs >= this.timeline.settleMs) this.settle();
    if (this.current === 'collecting' && this.phaseMs >= this.timeline.flyMs) {
      this.finish();
      return false;
    }
    this.render();
    this.surface?.frame(dt);
    return true;
  };

  private matchedMs(): number {
    if (this.current === 'matched') return this.phaseMs;
    if (this.current === 'settled' || this.current === 'collecting')
      return this.timeline.settleMs + this.phaseMs;
    return -1;
  }

  private render(): void {
    const { timeline } = this;
    const { style } = this.el;
    const enter = enterPose(this.ms, timeline);
    const seal = this.current === 'revealing' ? sealingPose(this.phaseMs, timeline) : null;
    style.setProperty('--cp-scratch-in', enter.opacity.toFixed(3));
    style.setProperty('--cp-scratch-scale', (enter.scale * (seal?.scale ?? 1)).toFixed(4));
    style.setProperty('--cp-scratch-rise', `${(enter.rise + (seal?.rise ?? 0)).toFixed(2)}px`);
    style.setProperty('--cp-scratch-tilt-x', `${(this.tilt.y + (seal?.tilt ?? 0)).toFixed(2)}deg`);
    style.setProperty('--cp-scratch-tilt-y', `${this.tilt.x.toFixed(2)}deg`);

    if (this.current === 'clearing') {
      const amount = clearAmount(this.phaseMs, timeline);
      if (timeline.reduced) this.surface?.setFade(amount);
      else this.surface?.setClear(amount);
      if (this.foilless) style.setProperty('--cp-scratch-cover', (1 - amount).toFixed(3));
    } else if (this.foilless && this.matchedMs() >= 0) {
      style.setProperty('--cp-scratch-cover', '0');
    }

    const sinceMatch = this.matchedMs();
    const match = this.flow.match;
    if (sinceMatch >= 0 && match !== null) {
      match.cells.forEach((cell, order) => {
        const pose = flarePose(sinceMatch, order, timeline);
        const el = this.cells[cell];
        el?.style.setProperty('--cp-scratch-flare', pose.scale.toFixed(4));
        el?.style.setProperty('--cp-scratch-glow', pose.glow.toFixed(3));
      });
      style.setProperty(
        '--cp-scratch-flash',
        timeline.reduced ? '0' : Math.max(0, 1 - sinceMatch / 260).toFixed(3),
      );
      this.lineEls.forEach((el, index) => {
        const pose = prizeLinePose(sinceMatch, index, timeline);
        el.style.setProperty('--cp-scratch-line-shown', pose.shown.toFixed(3));
        el.style.setProperty('--cp-scratch-line-scale', pose.scale.toFixed(4));
        el.style.setProperty('--cp-scratch-line-rise', `${pose.rise.toFixed(2)}px`);
        const line = this.answer?.lines[index];
        const name = el.firstElementChild;
        if (line?.count && name !== null)
          name.textContent = line.count(prizeCount(sinceMatch, index, timeline));
      });
    }

    if (this.current === 'collecting') {
      const fly = flyPose(this.phaseMs, timeline);
      style.setProperty('--cp-scratch-fade', fly.fade.toFixed(3));
      for (const line of this.flying) {
        line.el.style.setProperty('--cp-scratch-fly-x', `${(line.dx * fly.travel).toFixed(1)}px`);
        line.el.style.setProperty('--cp-scratch-fly-y', `${(line.dy * fly.travel).toFixed(1)}px`);
        line.el.style.setProperty('--cp-scratch-fly-scale', fly.scale.toFixed(4));
      }
    }
  }

  private finish(): void {
    if (this.current === 'done') return;
    this.current = 'done';
    this.disposed = true;
    this.stopFrames();
    this.window.removeEventListener('pointerdown', this.onPointerDown);
    this.window.removeEventListener('pointermove', this.onPointerMove);
    this.window.removeEventListener('pointerup', this.onPointerUp);
    this.window.removeEventListener('pointercancel', this.onPointerUp);
    this.window.removeEventListener('pointerleave', this.onPointerLeave);
    for (const cell of this.cells) cell.removeEventListener('click', this.onCellClick);
    this.cta.removeEventListener('click', this.onCta);
    this.closeButton.removeEventListener('click', this.onCloseClick);
    this.fairButton.removeEventListener('click', this.onFairClick);
    this.el.ownerDocument.removeEventListener('keydown', this.onKey);
    globalThis.removeEventListener('resize', this.onResize);
    this.surface?.dispose();
    this.surface = null;
    this.el.remove();
    this.resolve();
  }
}

function centre(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
