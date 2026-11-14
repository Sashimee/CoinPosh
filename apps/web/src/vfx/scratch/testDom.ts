import { vi } from 'vitest';
import type { Rarity } from '@coinposh/shared';
import type { ScratchAnswer, ScratchCardLabels } from './card.ts';
import type { ParticleSpawn } from '../particles/layout.ts';
import type { ScratchPoint } from './mask.ts';
import type { ScratchSurface } from './surface.ts';

type Handler = (event: unknown) => void;

class Listeners {
  private readonly byType = new Map<string, Set<Handler>>();

  addEventListener(type: string, handler: Handler): void {
    let set = this.byType.get(type);
    if (set === undefined) {
      set = new Set();
      this.byType.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: Handler): void {
    this.byType.get(type)?.delete(handler);
  }

  dispatch(type: string, event: unknown): void {
    for (const handler of [...(this.byType.get(type) ?? [])]) handler(event);
  }
}

class FakeClassList {
  private readonly names = new Set<string>();

  set(value: string): void {
    this.names.clear();
    for (const name of value.split(/\s+/).filter(Boolean)) this.names.add(name);
  }
  add(...names: string[]): void {
    for (const name of names) this.names.add(name);
  }
  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
  toString(): string {
    return [...this.names].join(' ');
  }
}

/** Just enough DOM for the scratch card: the suites run in node. */
export class FakeElement extends Listeners {
  parentNode: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  disabled = false;
  width = 0;
  height = 0;
  readonly clientWidth = 300;
  private text = '';

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {
    super();
    const properties: Record<string, string> = {};
    this.style = Object.assign(properties, {
      setProperty: (name: string, value: string) => {
        properties[name] = value;
      },
    });
  }

  set className(value: string) {
    this.classList.set(value);
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    for (const child of this.children.splice(0)) child.parentNode = null;
    this.text = value;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.text += node;
        continue;
      }
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  remove(): void {
    const parent = this.parentNode;
    if (parent === null) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
  }
  find(testId: string): FakeElement {
    const found = this.all().find((el) => el.getAttribute('data-testid') === testId);
    if (found === undefined) throw new Error(`no element with data-testid ${testId}`);
    return found;
  }
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  click(): void {
    this.dispatch('click', { detail: 1, currentTarget: this });
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 300, height: 300 } as DOMRect;
  }
  readonly setPointerCapture = (): void => undefined;
  hasPointerCapture(): boolean {
    return false;
  }
  readonly releasePointerCapture = (): void => undefined;
}

export class FakeDocument extends Listeners {
  readonly body: FakeElement = new FakeElement('body', this);
  activeElement: FakeElement | null = this.body;

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

const frames: FrameRequestCallback[] = [];
let clock = 0;

/** Installs the fake document, window events and a hand-driven animation frame. */
export function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  vi.stubGlobal('devicePixelRatio', 2);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  return doc;
}

/** Runs `count` animation frames `ms` apart. */
export function runFrames(count: number, ms = 1000 / 60): void {
  for (let i = 0; i < count; i++) {
    clock += ms;
    for (const callback of frames.splice(0)) callback(clock);
  }
}

/** Lets pending promise callbacks (the surface factory, the reveal) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

export class FakeSurface implements ScratchSurface {
  readonly kind = 'webgl2' as const;
  readonly canvas: HTMLCanvasElement;
  stamps = 0;
  framesDrawn = 0;
  disposed = false;
  clear = 0;
  flakesThrown = 0;

  constructor(doc: FakeDocument) {
    this.canvas = doc.createElement('canvas') as unknown as HTMLCanvasElement;
  }

  stamp(_point: ScratchPoint, _radius: number): void {
    this.stamps += 1;
  }
  flakes(spawns: readonly ParticleSpawn[]): void {
    this.flakesThrown += spawns.length;
  }
  readonly glints = (): void => undefined;
  readonly setPointer = (): void => undefined;
  setClear(amount: number): void {
    this.clear = amount;
  }
  setFade(amount: number): void {
    this.clear = amount;
  }
  readonly setTimeScale = (): void => undefined;
  frame(): void {
    this.framesDrawn += 1;
  }
  readonly resize = (): void => undefined;
  dispose(): void {
    this.disposed = true;
  }
}

export const LABELS: ScratchCardLabels = {
  title: 'Scratch card',
  rule: 'Match three',
  count: '',
  scratch: 'Scratch it',
  sealing: 'Sealing',
  revealAll: 'Reveal all',
  collect: 'Collect',
  close: 'Close',
  hint: 'Scratch the foil',
  odds: 'Odds',
  coveredCell: (position) => `Covered cell ${String(position)}`,
};

export const GRID: readonly Rarity[] = [
  'fine',
  'rare',
  'common',
  'rare',
  'fine',
  'common',
  'rare',
  'common',
  'fine',
];

export function answer(grid: readonly Rarity[] = GRID): ScratchAnswer {
  return {
    grid,
    rarity: 'rare',
    lines: [
      {
        kind: 'currency',
        name: '+1,200 Coins',
        detail: null,
        rarity: null,
        chip: null,
        count: (share) => `+${String(Math.round(1200 * share))} Coins`,
      },
    ],
    gemName: (rarity) => rarity,
    uncoveredCell: (position, gem) => `Cell ${String(position)}: ${gem}`,
    announce: 'Three Rare gems: +1,200 Coins',
    rarityName: 'Rare',
    fair: 'Certified Fair #1',
    fairLabel: 'Certified Fair proof #1',
  };
}
