import type { Rarity } from '@coinposh/shared';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../palette.ts';
import { createPopPath, popFontSize, popFrame, type PopPath, type ScreenPoint } from './arc.ts';

export interface PopRequest {
  readonly text: string;
  readonly magnitude: number;
  readonly rarity: Rarity;
  readonly from: ScreenPoint;
  readonly to: ScreenPoint;
  readonly onArrive?: () => void;
}

interface PopSlot {
  readonly el: HTMLSpanElement;
  path: PopPath | null;
  age: number;
  onArrive: (() => void) | undefined;
}

interface Burst {
  readonly el: HTMLSpanElement;
  readonly at: ScreenPoint;
  age: number;
}

const POOL = 24;
const BURST_S = 0.34;
const STYLE_ID = 'coinposh-vfx-pops';

const CSS = `
.cp-pops{position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;z-index:30}
.cp-pop{position:absolute;left:0;top:0;white-space:nowrap;will-change:transform,opacity;
  font-family:"Playfair Display","Cormorant Garamond",Georgia,serif;font-weight:700;
  font-variant-numeric:tabular-nums lining-nums;letter-spacing:.01em;color:var(--pop);
  text-shadow:0 0 .35em color-mix(in srgb,var(--pop) 70%,transparent),0 .06em 0 rgba(20,12,4,.55),0 .12em .4em rgba(0,0,0,.35)}
.cp-pop[data-rarity=heirloom]{background:linear-gradient(100deg,${HEIRLOOM_PRISM.join(',')},${HEIRLOOM_PRISM[0]});
  background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;
  animation:cp-prism 1.1s linear infinite;filter:drop-shadow(0 0 .3em rgba(245,185,66,.6))}
.cp-burst{position:absolute;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
  border:2px solid var(--pop);box-shadow:0 0 14px var(--pop),inset 0 0 10px var(--pop);will-change:transform,opacity}
@keyframes cp-prism{to{background-position:300% 0}}
@media (prefers-reduced-motion:reduce){.cp-pop[data-rarity=heirloom]{animation:none;background-position:30% 0}}
`;

/**
 * Floating value text over the canvas. Each pop springs in with overshoot, hangs a beat,
 * then arcs into the HUD target and lands with a small ring burst there; `onArrive` lets
 * the HUD tick its odometer at the exact moment of contact.
 *
 * DOM rather than in-scene text keeps the serif crisp at any DPR and costs no draw calls.
 * Reduced motion: the value fades in where it was earned and fades out, with no flight,
 * and the heirloom prism is held still; `onArrive` still fires at the end.
 */
export class NumberPopLayer {
  readonly root: HTMLDivElement;
  reducedMotion = false;
  private readonly slots: PopSlot[] = [];
  private readonly bursts: Burst[] = [];

  constructor(private readonly overlay: HTMLElement) {
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
      this.slots.push({ el, path: null, age: 0, onArrive: undefined });
    }
  }

  get active(): number {
    return this.slots.filter((s) => s.path).length;
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
    const slot = this.slots.find((s) => !s.path) ?? this.oldest();
    if (slot.path) this.land(slot);
    slot.path = createPopPath(request.from, request.to, this.reducedMotion);
    slot.age = 0;
    slot.onArrive = request.onArrive;
    const { el } = slot;
    el.textContent = request.text;
    el.dataset.rarity = request.rarity;
    el.style.setProperty('--pop', RARITY_COLORS[request.rarity]);
    el.style.fontSize = `${popFontSize(request.magnitude)}px`;
    el.style.opacity = '0';
    el.hidden = false;
  }

  update(realDt: number): void {
    const dt = Math.max(0, realDt);
    for (const slot of this.slots) {
      const { path } = slot;
      if (!path) continue;
      slot.age += dt;
      if (slot.age >= path.duration) {
        this.land(slot);
        continue;
      }
      const f = popFrame(path, slot.age);
      slot.el.style.transform = `translate(${f.x.toFixed(1)}px,${f.y.toFixed(1)}px) translate(-50%,-50%) scale(${f.scale.toFixed(3)})`;
      slot.el.style.opacity = f.opacity.toFixed(3);
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      if (!burst) continue;
      burst.age += dt;
      const k = Math.min(1, burst.age / BURST_S);
      if (k >= 1) {
        burst.el.remove();
        this.bursts.splice(i, 1);
        continue;
      }
      const eased = 1 - (1 - k) ** 3;
      burst.el.style.transform = burstTransform(burst.at, 0.3 + eased * 1.1);
      burst.el.style.opacity = ((1 - k) * 0.9).toFixed(3);
    }
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.path = null;
      slot.onArrive = undefined;
      slot.el.hidden = true;
    }
    for (const burst of this.bursts) burst.el.remove();
    this.bursts.length = 0;
  }

  dispose(): void {
    this.clear();
    this.root.remove();
  }

  private land(slot: PopSlot): void {
    const { path, onArrive } = slot;
    slot.path = null;
    slot.onArrive = undefined;
    slot.el.hidden = true;
    if (path && !path.reducedMotion) this.burstAt(path.to, slot.el.style.getPropertyValue('--pop'));
    onArrive?.();
  }

  private burstAt(at: ScreenPoint, color: string): void {
    const el = this.root.ownerDocument.createElement('span');
    el.className = 'cp-burst';
    el.style.setProperty('--pop', color);
    el.style.transform = burstTransform(at, 0.3);
    this.root.append(el);
    this.bursts.push({ el, at, age: 0 });
  }

  private oldest(): PopSlot {
    return this.slots.reduce((a, b) => (b.age > a.age ? b : a));
  }
}

function burstTransform(at: ScreenPoint, scale: number): string {
  return `translate(${at.x.toFixed(1)}px,${at.y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
}
