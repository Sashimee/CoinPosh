import { easeOutCubic } from '../easing.ts';
import { HEIRLOOM_PRISM } from '../palette.ts';
import { createPopPath, popFontSize, popFrame, type PopPath, type ScreenPoint } from './arc.ts';
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
  path: PopPath | null;
  age: number;
  tally: boolean;
  onArrive: (() => void) | undefined;
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
const STYLE_ID = 'coinposh-vfx-pops';

const CSS = `
.cp-pops{position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;z-index:30}
.cp-pops[data-under]{z-index:-1}
.cp-pop{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform,opacity;
  font-family:"Playfair Display","Cormorant Garamond",Georgia,serif;font-weight:700;
  font-variant-numeric:tabular-nums lining-nums;letter-spacing:.01em;color:var(--pop);
  text-shadow:0 0 .35em color-mix(in srgb,var(--pop) 70%,transparent),0 .06em 0 rgba(20,12,4,.55),0 .12em .4em rgba(0,0,0,.35)}
.cp-pop[data-tally]{--flare:0;
  text-shadow:0 0 calc(.4em + var(--flare) * .9em) color-mix(in srgb,var(--pop) 80%,transparent),
    0 0 calc(var(--flare) * .3em) #fff8e7,0 .06em 0 rgba(20,12,4,.55),0 .12em .4em rgba(0,0,0,.35)}
.cp-pop[data-prism]{background:linear-gradient(100deg,${HEIRLOOM_PRISM.join(',')},${HEIRLOOM_PRISM[0]});
  background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:cp-prism 1.1s linear infinite;filter:drop-shadow(0 0 .3em rgba(245,185,66,.6))}
.cp-pop[data-prism][data-tally]{filter:drop-shadow(0 0 calc(.35em + var(--flare) * .8em) rgba(245,185,66,.75))}
.cp-burst{position:absolute;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
  border:2px solid var(--pop);box-shadow:0 0 14px var(--pop),inset 0 0 10px var(--pop);will-change:transform,opacity}
.cp-spark{position:absolute;left:0;top:0;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;
  background:#fff8e7;box-shadow:0 0 6px 1px var(--pop),0 0 12px var(--pop);will-change:transform,opacity}
@keyframes cp-prism{to{background-position:300% 0}}
.cp-pops[data-reduced] .cp-pop[data-prism]{animation:none;background-position:30% 0}
`;

/**
 * Floating value text over the canvas. Each pop springs in with overshoot, hangs a beat,
 * then arcs into the HUD target and lands with a small ring burst there; `onArrive` lets
 * the HUD tick its odometer at the exact moment of contact.
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
 */
export class NumberPopLayer {
  readonly root: HTMLDivElement;
  private reduced = false;
  private readonly slots: PopSlot[] = [];
  private readonly bursts: Burst[] = [];
  private readonly tally = new PopTally();
  private readonly surfaces: SurfaceProbe;
  private releaseIn: number | null = null;

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
      this.slots.push({ el, path: null, age: 0, tally: false, onArrive: undefined });
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
    this.followSurfaces(dt);
    for (const slot of this.slots) {
      const { path } = slot;
      if (!path) continue;
      slot.age += dt;
      if (slot.age >= path.duration) {
        this.land(slot);
        continue;
      }
      const f = popFrame(path, slot.age);
      const scale = slot.tally ? f.scale * TALLY_SCALE : f.scale;
      slot.el.style.transform = `translate(${f.x.toFixed(1)}px,${f.y.toFixed(1)}px) translate(-50%,-50%) scale(${scale.toFixed(3)})`;
      slot.el.style.opacity = f.opacity.toFixed(3);
      if (slot.tally) slot.el.style.setProperty('--flare', tallyFlare(slot.age, path).toFixed(3));
    }
    this.updateBursts(dt);
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.path = null;
      slot.onArrive = undefined;
      slot.el.hidden = true;
    }
    for (const burst of this.bursts) burst.el.remove();
    this.bursts.length = 0;
    this.tally.clear();
    this.releaseIn = null;
  }

  dispose(): void {
    this.clear();
    this.surfaces.dispose();
    this.root.remove();
  }

  private launch(request: PopRequest, tally: boolean): void {
    const slot = this.slots.find((s) => !s.path) ?? this.oldest();
    if (slot.path) this.land(slot);
    slot.path = createPopPath(request.from, request.to, this.reducedMotion);
    slot.age = 0;
    slot.tally = tally;
    slot.onArrive = request.onArrive;
    const { el } = slot;
    el.textContent = request.text;
    if (request.prism) el.dataset.prism = '';
    else delete el.dataset.prism;
    if (tally) el.dataset.tally = '';
    else delete el.dataset.tally;
    el.style.setProperty('--pop', request.color);
    el.style.fontSize = `${popFontSize(request.magnitude)}px`;
    el.style.opacity = '0';
    el.hidden = false;
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
    const { path, onArrive, tally } = slot;
    slot.path = null;
    slot.onArrive = undefined;
    slot.tally = false;
    slot.el.hidden = true;
    if (path && !path.reducedMotion) {
      const color = slot.el.style.getPropertyValue('--pop');
      this.burstAt(path.to, color, 'ring', BURST_S, 1.1);
      if (tally) {
        this.burstAt(path.to, color, 'ring', BURST_S * 1.5, 1.9, 0, -0.07);
        for (let i = 0; i < TALLY_SPARKS; i++) {
          const angle = (i / TALLY_SPARKS) * Math.PI * 2 + (i % 2) * 0.22;
          this.burstAt(path.to, color, 'spark', SPARK_S, 34 + (i % 3) * 12, angle);
        }
      }
    }
    onArrive?.();
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

function burstTransform(at: ScreenPoint, scale: number): string {
  return `translate(${at.x.toFixed(1)}px,${at.y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
}
