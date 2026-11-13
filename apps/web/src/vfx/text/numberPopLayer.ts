import { easeOutCubic } from '../easing.ts';
import { HEIRLOOM_PRISM } from '../palette.ts';
import {
  createPopPath,
  holdPath,
  type MutablePopFrame,
  movePath,
  POP_TIMING,
  popFontSize,
  popFrame,
  type PopPath,
  type ScreenPoint,
} from './arc.ts';
import {
  boxesOverlap,
  boxGap,
  canCoalesce,
  COALESCE,
  emptyBox,
  placeClear,
  popBox,
  type Box,
} from './coalesce.ts';
import { formatPopNumber } from './format.ts';
import { watchSurfaces, type SurfaceProbe } from './surfaces.ts';
import { PopTally } from './tally.ts';

export interface PopRequest {
  readonly text: string;
  readonly magnitude: number;
  /** Text colour, also used for the glow and the landing ring. */
  readonly color: string;
  /** Animates the heirloom prism gradient across the text instead of a flat colour. */
  readonly prism: boolean;
  readonly from: ScreenPoint;
  readonly to: ScreenPoint;
  readonly onArrive?: () => void;
}

interface PopSlot {
  readonly el: HTMLSpanElement;
  readonly arrivals: (() => void)[];
  /** Scratch for placement and coalescing, so neither allocates a box per check. */
  readonly box: Box;
  path: PopPath | null;
  age: number;
  /** The closing tally of credits held behind a sheet. */
  tally: boolean;
  /** Credits folded into this pop; above 1 it counts up and lands as a tally. */
  credits: number;
  value: number;
  /** Size of the share whose colour the pop wears. */
  lead: number;
  prism: boolean;
  glyphs: number;
  /** Glyphs of the total it is counting toward. */
  finalGlyphs: number;
  fontSize: number;
  sumX: number;
  sumY: number;
  lastCreditAge: number;
  shown: number;
  countFrom: number;
  countAge: number;
  driftX: number;
  driftY: number;
  punchAge: number;
  /** Seconds its departure has been held for the stagger or a blocked lane. */
  wait: number;
  flying: boolean;
}

interface Burst {
  readonly el: HTMLSpanElement;
  readonly at: ScreenPoint;
  readonly kind: 'ring' | 'spark';
  readonly duration: number;
  /** Ring: peak scale. Spark: how far it flies, in px, along `angle`. */
  readonly size: number;
  readonly angle: number;
  age: number;
}

const POOL = 24;
const BURST_S = 0.34;
/**
 * Beat between a sheet starting to close and the tally springing in, so the eye follows
 * the sheet away first. The frame that sees the close counts toward it, so a slow frame
 * releases at once instead of adding a second frame on top: inside 300 ms from 10 fps.
 */
export const TALLY_DELAY_S = 0.08;
const TALLY_SCALE = 1.14;
const TALLY_FLARE_S = 0.55;
const TALLY_SPARKS = 9;
const SPARK_S = 0.42;
/** Points along the first two thirds of a flight checked for pops in the way. */
const LANE_SAMPLES = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68] as const;
/** Points a flight is projected through, over what is left of it, when a pop looks for room. */
const AHEAD = 6;
const ABSORB_SPARKS = 3;
/** Peak of the pop-in overshoot (easeOutBack 2.2 from 0.3) times the merge punch. */
const SWELL = 1.11 * (1 + COALESCE.punchScale);
const STYLE_ID = 'coinposh-vfx-pops';

const CSS = `
.cp-pops{position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;z-index:30}
.cp-pops[data-under]{z-index:-1}
.cp-pop{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform,opacity;
  font-family:"Playfair Display","Cormorant Garamond",Georgia,serif;font-weight:700;
  font-variant-numeric:tabular-nums lining-nums;letter-spacing:.01em;color:var(--pop);
  text-shadow:0 0 .35em color-mix(in srgb,var(--pop) 70%,transparent),0 .06em 0 rgba(20,12,4,.55),0 .12em .4em rgba(0,0,0,.35)}
.cp-pop[data-tally],.cp-pop[data-count]{--flare:0;
  text-shadow:0 0 calc(.4em + var(--flare) * .9em) color-mix(in srgb,var(--pop) 80%,transparent),
    0 0 calc(var(--flare) * .3em) #fff8e7,0 .06em 0 rgba(20,12,4,.55),0 .12em .4em rgba(0,0,0,.35)}
.cp-pop[data-prism]{background:linear-gradient(100deg,${HEIRLOOM_PRISM.join(',')},${HEIRLOOM_PRISM[0]});
  background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:cp-prism 1.1s linear infinite;filter:drop-shadow(0 0 .3em rgba(245,185,66,.6))}
.cp-pop[data-prism][data-tally],.cp-pop[data-prism][data-count]{filter:drop-shadow(0 0 calc(.35em + var(--flare) * .8em) rgba(245,185,66,.75))}
.cp-burst{position:absolute;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
  border:2px solid var(--pop);box-shadow:0 0 14px var(--pop),inset 0 0 10px var(--pop);will-change:transform,opacity}
.cp-spark{position:absolute;left:0;top:0;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;
  background:#fff8e7;box-shadow:0 0 6px 1px var(--pop),0 0 12px var(--pop);will-change:transform,opacity}
@keyframes cp-prism{to{background-position:300% 0}}
.cp-pops[data-reduced] .cp-pop[data-prism]{animation:none;background-position:30% 0}
`;

/**
 * Floating value text over the canvas. Each pop springs in with overshoot, hangs a beat,
 * then sweeps up into the HUD target from below (clear of the plaque's label) and lands
 * with a small ring burst there; `onArrive` lets the HUD tick its odometer at the exact
 * moment of contact.
 *
 * DOM rather than in-scene text keeps the serif crisp at any DPR and costs no draw calls.
 * Reduced motion: the value fades in where it was earned and fades out, with no flight,
 * and the heirloom prism is held still; `onArrive` still fires at the end.
 *
 * Open sheets and dialogs: pops never paint over them. While one is open new pops are
 * held, and pops already in flight drop under it (the layer stacks below the rest of the
 * UI host) to finish behind the backdrop. Once it closes the held credits play as one
 * tally pop: bigger, flaring as it springs in, and landing with a double ring and a spray
 * of sparks. Reduced motion shows the tally fading in place, without the arc or sparks.
 *
 * Crowds: a credit that lands within `COALESCE.windowS` and `COALESCE.gapPx` of a pop
 * still hanging folds into it. The pop punches, flares, glides to the middle of its
 * credits and counts up to their exact sum, takes the colour of the biggest share, hangs
 * long enough for the total to read and lands with every credit's `onArrive`. A pop that
 * does not fold is nudged clear of the others, and flights into one target leave
 * `COALESCE.flightGapS` apart, so no two pops print over each other. Reduced motion
 * folds the same way but swaps the number in place, with no count, glide or punch.
 */
export class NumberPopLayer {
  readonly root: HTMLDivElement;
  private reduced = false;
  private readonly slots: PopSlot[] = [];
  private readonly bursts: Burst[] = [];
  private readonly tally = new PopTally();
  private readonly surfaces: SurfaceProbe;
  private releaseIn: number | null = null;
  private clock = 0;
  private lastFlightAt = Number.NEGATIVE_INFINITY;
  private lastFlightTo: ScreenPoint | null = null;
  private readonly taken: Box[] = [];
  private readonly probe = emptyBox();
  private readonly lane = emptyBox();
  private readonly ahead: Box[] = Array.from({ length: POOL * AHEAD }, emptyBox);
  private readonly frame: MutablePopFrame = { x: 0, y: 0, scale: 1, opacity: 0 };

  /** `surfaces` is for tests; by default the layer watches the page's own dialogs. */
  constructor(
    private readonly overlay: HTMLElement,
    surfaces: (doc: Document, layer: HTMLElement) => SurfaceProbe = watchSurfaces,
  ) {
    const doc = overlay.ownerDocument;
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.head.append(style);
    }
    this.root = doc.createElement('div');
    this.root.className = 'cp-pops';
    this.root.setAttribute('aria-hidden', 'true');
    overlay.append(this.root);
    for (let i = 0; i < POOL; i++) {
      const el = doc.createElement('span');
      el.className = 'cp-pop';
      el.hidden = true;
      this.root.append(el);
      this.slots.push({
        el,
        arrivals: [],
        box: emptyBox(),
        path: null,
        age: 0,
        tally: false,
        credits: 0,
        value: 0,
        lead: 0,
        prism: false,
        glyphs: 0,
        finalGlyphs: 0,
        fontSize: 0,
        sumX: 0,
        sumY: 0,
        lastCreditAge: 0,
        shown: 0,
        countFrom: 0,
        countAge: Number.POSITIVE_INFINITY,
        driftX: 0,
        driftY: 0,
        punchAge: Number.POSITIVE_INFINITY,
        wait: 0,
        flying: false,
      });
    }
    this.surfaces = surfaces(doc, this.root);
  }

  /**
   * The facade's preference, not the OS media query, drives the prism too, so an in-app
   * toggle (or a forced option) holds it still and a forced `false` keeps it moving.
   */
  get reducedMotion(): boolean {
    return this.reduced;
  }

  set reducedMotion(reduced: boolean) {
    this.reduced = reduced;
    if (reduced) this.root.dataset.reduced = '';
    else delete this.root.dataset.reduced;
  }

  get active(): number {
    return this.slots.filter((s) => s.path).length;
  }

  /** Credits waiting behind an open sheet for the closing tally. */
  get held(): number {
    return this.tally.size;
  }

  /** Pixel position of `el`'s centre in this layer's coordinates, for HUD targets. */
  centerOf(el: Element): ScreenPoint {
    const target = el.getBoundingClientRect();
    const origin = this.overlay.getBoundingClientRect();
    return {
      x: target.left + target.width / 2 - origin.left,
      y: target.top + target.height / 2 - origin.top,
    };
  }

  get size(): { readonly width: number; readonly height: number } {
    return { width: this.overlay.clientWidth, height: this.overlay.clientHeight };
  }

  spawn(request: PopRequest): void {
    if (this.surfaces.read().blocking) {
      this.tally.add(request);
      return;
    }
    this.launch(request, false);
  }

  update(realDt: number): void {
    const dt = Math.max(0, realDt);
    this.clock += dt;
    this.followSurfaces(dt);
    for (const slot of this.slots) {
      if (!slot.path) continue;
      slot.age += dt;
      this.queueFlight(slot);
      const path = slot.path;
      const t = slot.age - slot.wait;
      if (t >= path.duration) {
        this.land(slot);
        continue;
      }
      this.count(slot, dt);
      const f = popFrame(path, t, this.frame);
      const settle = Math.exp(-dt / COALESCE.driftS);
      slot.driftX *= settle;
      slot.driftY *= settle;
      let punch = 0;
      if (slot.punchAge < COALESCE.punchS) {
        slot.punchAge += dt;
        punch = mergePunch(slot.punchAge);
      }
      const scale = f.scale * (slot.tally ? TALLY_SCALE : 1) * (1 + punch * COALESCE.punchScale);
      const x = f.x + slot.driftX;
      const y = f.y + slot.driftY;
      slot.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%) scale(${scale.toFixed(3)})`;
      slot.el.style.opacity = f.opacity.toFixed(3);
      if (slot.tally) {
        slot.el.style.setProperty('--flare', tallyFlare(t, path).toFixed(3));
      } else if (slot.credits > 1) {
        const flare = path.reducedMotion ? 0.35 : 0.25 + Math.max(0, punch) * 0.9;
        slot.el.style.setProperty('--flare', flare.toFixed(3));
      }
    }
    this.updateBursts(dt);
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.path = null;
      slot.arrivals.length = 0;
      slot.el.hidden = true;
    }
    for (const burst of this.bursts) burst.el.remove();
    this.bursts.length = 0;
    this.tally.clear();
    this.releaseIn = null;
    this.lastFlightAt = Number.NEGATIVE_INFINITY;
    this.lastFlightTo = null;
  }

  dispose(): void {
    this.clear();
    this.surfaces.dispose();
    this.root.remove();
  }

  private launch(request: PopRequest, tally: boolean): void {
    const into = this.coalesceTarget(request);
    if (into) {
      this.absorb(into, request, tally);
      return;
    }
    const slot = this.slots.find((s) => !s.path) ?? this.oldest();
    if (slot.path) this.land(slot);
    const fontSize = popFontSize(request.magnitude);
    const from = this.clearSpot(request.from, request.text.length, fontSize, tally);
    slot.path = createPopPath(from, request.to, this.reducedMotion);
    slot.age = 0;
    slot.tally = tally;
    slot.credits = 1;
    slot.value = request.magnitude;
    slot.lead = Math.abs(request.magnitude);
    slot.prism = request.prism;
    slot.glyphs = request.text.length;
    slot.finalGlyphs = request.text.length;
    slot.fontSize = fontSize;
    slot.sumX = from.x;
    slot.sumY = from.y;
    slot.lastCreditAge = 0;
    slot.shown = request.magnitude;
    slot.countFrom = request.magnitude;
    slot.countAge = Number.POSITIVE_INFINITY;
    slot.driftX = 0;
    slot.driftY = 0;
    slot.punchAge = Number.POSITIVE_INFINITY;
    slot.wait = 0;
    slot.flying = false;
    slot.arrivals.length = 0;
    if (request.onArrive) slot.arrivals.push(request.onArrive);
    const { el } = slot;
    el.textContent = request.text;
    if (request.prism) el.dataset.prism = '';
    else delete el.dataset.prism;
    if (tally) el.dataset.tally = '';
    else delete el.dataset.tally;
    delete el.dataset.count;
    el.style.setProperty('--pop', request.color);
    el.style.fontSize = `${fontSize}px`;
    el.style.opacity = '0';
    el.hidden = false;
  }

  /** The hanging pop this credit folds into, if any: the nearest that still takes credits. */
  private coalesceTarget(request: PopRequest): PopSlot | null {
    const reduced = this.reducedMotion;
    const incoming = popBox(
      request.text.length,
      popFontSize(request.magnitude),
      request.from.x,
      request.from.y - (reduced ? 0 : POP_TIMING.rise),
      1,
      this.probe,
    );
    let best: PopSlot | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const slot of this.slots) {
      const { path } = slot;
      if (path?.reducedMotion !== reduced) continue;
      const gap = boxGap(incoming, this.restingBox(slot, true));
      const open = {
        age: slot.age - slot.wait,
        lastCreditAge: slot.lastCreditAge,
        departsAt: path.popIn + path.hang,
        to: path.to,
      };
      if (gap < bestGap && canCoalesce(open, request.to, gap) && this.roomToGrow(slot, request)) {
        best = slot;
        bestGap = gap;
      }
    }
    return best;
  }

  /** Whether the pop can take `request` without its bigger total touching another pop. */
  private roomToGrow(slot: PopSlot, request: PopRequest): boolean {
    const path = slot.path;
    if (!path) return false;
    const value = slot.value + request.magnitude;
    const glyphs = Math.max(slot.glyphs, this.format(value).length);
    return this.spotIsFree(slot, path.from, glyphs, popFontSize(value));
  }

  /**
   * Folds a credit into a hanging pop: the exact sum counts up from what is showing, the
   * pop glides toward the middle of its credits (if that spot is free), punches and flares,
   * and its departure moves back so the new total has time to read.
   */
  private absorb(slot: PopSlot, request: PopRequest, tally: boolean): void {
    const path = slot.path;
    if (!path) throw new Error('numberPop tried to fold a credit into a pop that is not showing');
    slot.credits += 1;
    slot.value += request.magnitude;
    slot.sumX += request.from.x;
    slot.sumY += request.from.y;
    slot.lastCreditAge = slot.age;
    if (request.onArrive) slot.arrivals.push(request.onArrive);
    if (tally) {
      slot.tally = true;
      slot.el.dataset.tally = '';
    }
    if (request.prism && !slot.prism) {
      slot.prism = true;
      slot.el.dataset.prism = '';
      slot.el.style.setProperty('--pop', request.color);
    } else if (!slot.prism && Math.abs(request.magnitude) > slot.lead) {
      slot.lead = Math.abs(request.magnitude);
      slot.el.style.setProperty('--pop', request.color);
    }
    slot.el.dataset.count = '';
    slot.finalGlyphs = this.format(slot.value).length;
    slot.glyphs = Math.max(slot.glyphs, slot.finalGlyphs);
    slot.fontSize = popFontSize(slot.value);
    slot.el.style.fontSize = `${slot.fontSize}px`;
    let next = holdPath(path, Math.max(path.hang, slot.age + COALESCE.readS - path.popIn));
    if (path.reducedMotion) {
      slot.path = next;
      this.show(slot, slot.value);
      return;
    }
    const centre = { x: slot.sumX / slot.credits, y: slot.sumY / slot.credits };
    if (this.spotIsFree(slot, centre, slot.glyphs, slot.fontSize)) {
      slot.driftX += path.from.x - centre.x;
      slot.driftY += path.from.y - centre.y;
      next = movePath(next, centre);
    }
    slot.path = next;
    slot.punchAge = 0;
    slot.countFrom = slot.shown;
    slot.countAge = 0;
    const sparkAt = {
      x: next.from.x + slot.driftX,
      y: next.from.y - POP_TIMING.rise + slot.driftY,
    };
    const color = slot.el.style.getPropertyValue('--pop');
    for (let i = 0; i < ABSORB_SPARKS; i++) {
      const angle = -Math.PI / 2 + (i - 1) * 0.9 + (slot.credits % 2) * 0.3;
      this.burstAt(sparkAt, color, 'spark', SPARK_S * 0.7, 18 + i * 5, angle);
    }
  }

  /** Steps the count-up toward the exact sum; its last frame always shows the true value. */
  private count(slot: PopSlot, dt: number): void {
    if (slot.countAge >= COALESCE.countS) return;
    slot.countAge += dt;
    const k = slot.countAge / COALESCE.countS;
    const value =
      k >= 1
        ? slot.value
        : Math.round(slot.countFrom + (slot.value - slot.countFrom) * easeOutCubic(k));
    if (value !== slot.shown) this.show(slot, value);
  }

  private show(slot: PopSlot, value: number): void {
    slot.shown = value;
    slot.el.textContent = this.format(value);
  }

  private format(value: number): string {
    return formatPopNumber(this.root.ownerDocument.documentElement.lang, value);
  }

  /**
   * Keeps a pop that is due to fly hanging while another flight into the same target has
   * only just left, or while a hanging pop sits in the lane it would rise through, so arcs
   * leave in a stagger and never print over another pop.
   */
  private queueFlight(slot: PopSlot): void {
    const path = slot.path;
    if (!path || slot.flying || path.reducedMotion) return;
    const late = slot.age - slot.wait - (path.popIn + path.hang);
    if (late < 0) return;
    if (slot.wait < COALESCE.maxWaitS && (this.tooSoonAfter(path) || this.laneBlocked(slot))) {
      slot.wait += late;
      return;
    }
    slot.flying = true;
    this.lastFlightAt = this.clock;
    this.lastFlightTo = path.to;
  }

  private tooSoonAfter(path: PopPath): boolean {
    const last = this.lastFlightTo;
    if (!last || this.clock - this.lastFlightAt >= COALESCE.flightGapS) return false;
    return Math.hypot(last.x - path.to.x, last.y - path.to.y) <= COALESCE.sameTargetPx;
  }

  private laneBlocked(slot: PopSlot): boolean {
    const path = slot.path;
    if (!path) return false;
    const departs = path.popIn + path.hang;
    for (const k of LANE_SAMPLES) {
      const lane = this.flightBox(slot, departs + path.flight * k, this.lane);
      for (const other of this.slots) {
        if (other === slot || !other.path || other.flying) continue;
        if (boxesOverlap(lane, this.restingBox(other))) return true;
      }
    }
    return false;
  }

  private flightBox(slot: PopSlot, t: number, out: Box): Box {
    const path = slot.path;
    if (!path) throw new Error('numberPop measured a pop that is not showing');
    const f = popFrame(path, t, this.frame);
    const scale = f.scale * (slot.tally ? TALLY_SCALE : 1);
    return popBox(slot.glyphs, slot.fontSize, f.x + slot.driftX, f.y + slot.driftY, scale, out);
  }

  /**
   * Where the pop's text rests while it hangs, swollen by its overshoot. `settled` asks
   * for where it is heading rather than where it is: at the middle of its credits, as
   * wide as its final total, so a run of falls along the lip keeps folding into it.
   */
  private restingBox(slot: PopSlot, settled = false): Box {
    const path = slot.path;
    if (!path) throw new Error('numberPop measured a pop that is not showing');
    const rise = path.reducedMotion ? 0 : POP_TIMING.rise;
    const scale = (slot.tally ? TALLY_SCALE : 1) * (path.reducedMotion ? 1 : SWELL);
    return popBox(
      settled ? slot.finalGlyphs : slot.glyphs,
      slot.fontSize,
      path.from.x + (settled ? 0 : slot.driftX),
      path.from.y - rise + (settled ? 0 : slot.driftY),
      scale,
      slot.box,
    );
  }

  /** Where the pop is right now: its resting box, or its spot on the arc once it flies. */
  private currentBox(slot: PopSlot): Box {
    if (!slot.flying) return this.restingBox(slot);
    return this.flightBox(slot, slot.age - slot.wait, slot.box);
  }

  /** A launch point near `from` whose resting box overlaps no pop on screen. */
  private clearSpot(
    from: ScreenPoint,
    glyphs: number,
    fontSize: number,
    tally: boolean,
  ): ScreenPoint {
    const rise = this.reducedMotion ? 0 : POP_TIMING.rise;
    const scale = (tally ? TALLY_SCALE : 1) * (this.reducedMotion ? 1 : SWELL);
    const own = popBox(glyphs, fontSize, 0, 0, scale, this.probe);
    const spot = placeClear(
      { x: from.x, y: from.y - rise },
      own.right - own.left,
      own.bottom - own.top,
      this.collectTaken(null),
      this.size,
    );
    this.taken.length = 0;
    return { x: spot.x, y: spot.y + rise };
  }

  /**
   * Every box a pop other than `except` holds now or will sweep through: hanging pops
   * where they rest, flights along the rest of their arc. Reuses the layer's scratch boxes.
   */
  private collectTaken(except: PopSlot | null): readonly Box[] {
    const taken = this.taken;
    taken.length = 0;
    let ahead = 0;
    for (const slot of this.slots) {
      const path = slot.path;
      if (!path || slot === except) continue;
      taken.push(this.currentBox(slot));
      if (!slot.flying) continue;
      const departs = path.popIn + path.hang;
      const k0 = Math.min(1, Math.max(0, (slot.age - slot.wait - departs) / path.flight));
      for (let i = 1; i <= AHEAD; i++) {
        const box = this.ahead[ahead++];
        if (!box) break;
        const k = k0 + ((1 - k0) * i) / (AHEAD + 1);
        taken.push(this.flightBox(slot, departs + path.flight * k, box));
      }
    }
    return taken;
  }

  /** Whether `slot` could rest at `from`, this size, without touching another pop on screen. */
  private spotIsFree(slot: PopSlot, from: ScreenPoint, glyphs: number, fontSize: number): boolean {
    const reduced = slot.path?.reducedMotion ?? this.reducedMotion;
    const scale = (slot.tally ? TALLY_SCALE : 1) * (reduced ? 1 : SWELL);
    const rise = reduced ? 0 : POP_TIMING.rise;
    const own = popBox(glyphs, fontSize, from.x, from.y - rise, scale, this.probe);
    const free = this.collectTaken(slot).every((box) => !boxesOverlap(own, box));
    this.taken.length = 0;
    return free;
  }

  /**
   * Stacks the layer under any modal surface on screen and, once the last one stops
   * blocking, counts down the beat before the held credits fly as one tally.
   */
  private followSurfaces(dt: number): void {
    const state = this.surfaces.read();
    if (state.covered) this.root.dataset.under = '';
    else delete this.root.dataset.under;
    if (state.blocking || this.tally.size === 0) {
      this.releaseIn = null;
      return;
    }
    this.releaseIn = (this.releaseIn ?? TALLY_DELAY_S) - dt;
    if (this.releaseIn > 0) return;
    this.releaseIn = null;
    const lang = this.root.ownerDocument.documentElement.lang;
    const tally = this.tally.take((value) => formatPopNumber(lang, value));
    if (tally) this.launch(tally, true);
  }

  private land(slot: PopSlot): void {
    const { path, tally, credits } = slot;
    const arrivals = slot.arrivals.splice(0);
    slot.path = null;
    slot.tally = false;
    slot.flying = false;
    slot.el.hidden = true;
    if (path && !path.reducedMotion) {
      const color = slot.el.style.getPropertyValue('--pop');
      this.burstAt(path.to, color, 'ring', BURST_S, 1.1);
      if (tally || credits > 1) {
        const sparks = tally ? TALLY_SPARKS : Math.min(TALLY_SPARKS, 2 + credits);
        this.burstAt(path.to, color, 'ring', BURST_S * 1.5, 1.9, 0, -0.07);
        for (let i = 0; i < sparks; i++) {
          const angle = (i / sparks) * Math.PI * 2 + (i % 2) * 0.22;
          this.burstAt(path.to, color, 'spark', SPARK_S, 34 + (i % 3) * 12, angle);
        }
      }
    }
    for (const arrive of arrivals) arrive();
  }

  /** A negative `age` holds the burst back for that many seconds. */
  private burstAt(
    at: ScreenPoint,
    color: string,
    kind: Burst['kind'],
    duration: number,
    size: number,
    angle = 0,
    age = 0,
  ): void {
    const el = this.root.ownerDocument.createElement('span');
    el.className = kind === 'ring' ? 'cp-burst' : 'cp-spark';
    el.style.setProperty('--pop', color);
    el.style.transform = burstTransform(at, kind === 'ring' ? 0.3 : 1);
    if (age < 0) el.style.opacity = '0';
    this.root.append(el);
    this.bursts.push({ el, at, kind, duration, size, angle, age });
  }

  private updateBursts(dt: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      if (!burst) continue;
      burst.age += dt;
      if (burst.age < 0) continue;
      const k = Math.min(1, burst.age / burst.duration);
      if (k >= 1) {
        burst.el.remove();
        this.bursts.splice(i, 1);
        continue;
      }
      const eased = easeOutCubic(k);
      if (burst.kind === 'ring') {
        burst.el.style.transform = burstTransform(burst.at, 0.3 + eased * burst.size);
        burst.el.style.opacity = ((1 - k) * 0.9).toFixed(3);
      } else {
        const reach = eased * burst.size;
        const at = {
          x: burst.at.x + Math.cos(burst.angle) * reach,
          y: burst.at.y + Math.sin(burst.angle) * reach,
        };
        burst.el.style.transform = burstTransform(at, 1 - 0.7 * k);
        burst.el.style.opacity = (1 - k * k).toFixed(3);
      }
    }
  }

  private oldest(): PopSlot {
    return this.slots.reduce((a, b) => (b.age > a.age ? b : a));
  }
}

/** Glow swell as the tally springs in, settling to a warm rest; held steady when reduced. */
function tallyFlare(age: number, path: PopPath): number {
  if (path.reducedMotion) return 0.35;
  const k = Math.min(1, age / TALLY_FLARE_S);
  return 0.25 + Math.sin(Math.min(1, k * 2.2) * Math.PI * 0.5) * (1 - easeOutCubic(k));
}

/**
 * The squash a pop gives each time it takes a credit: a fast swell to 1, a small dip below
 * rest as it settles (the overshoot), then 0.
 */
export function mergePunch(age: number): number {
  const k = Math.min(1, Math.max(0, age) / COALESCE.punchS);
  if (k < 0.45) return Math.sin((k / 0.45) * Math.PI * 0.5);
  if (k < 0.8) return Math.cos(((k - 0.45) / 0.35) * Math.PI * 0.5) * 1.15 - 0.15;
  return -0.15 * Math.sin(((1 - k) / 0.2) * Math.PI * 0.5);
}

function burstTransform(at: ScreenPoint, scale: number): string {
  return `translate(${at.x.toFixed(1)}px,${at.y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
}
