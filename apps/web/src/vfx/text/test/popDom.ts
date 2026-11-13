import { NumberPopLayer, type PopRequest } from '../numberPopLayer.ts';
import { NO_SURFACE, readSurfaces, type SurfaceState } from '../surfaces.ts';

export const FRAME = 1 / 60;

/** Just enough DOM for NumberPopLayer: the suite runs in node. */
export class FakeStyle {
  transform = '';
  opacity = '';
  fontSize = '';
  private readonly props = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }
}

export class FakeElement {
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly classList: { contains(name: string): boolean };
  parent: FakeElement | null = null;
  hidden = false;
  className = '';
  id = '';
  textContent = '';
  lang = '';
  readonly attrs = new Map<string, string>();
  readonly clientWidth = 390;
  readonly clientHeight = 844;

  constructor(readonly ownerDocument: FakeDocument) {
    this.classList = { contains: (name) => this.className.split(' ').includes(name) };
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  remove(): void {
    const siblings = this.parent?.children;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  /** Supports exactly the selectors `readSurfaces` uses. */
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const s = part.trim();
      if (s === '[hidden]') return this.hidden;
      if (s === '[inert]') return this.attrs.has('inert');
      if (s === '[aria-hidden="true"]') return this.attrs.get('aria-hidden') === 'true';
      if (s === '[aria-modal="true"]') return this.attrs.get('aria-modal') === 'true';
      if (s.startsWith('.')) return this.classList.contains(s.slice(1));
      throw new Error(`FakeElement cannot match ${s}`);
    });
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }

  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

export class FakeDocument {
  readonly documentElement: FakeElement = new FakeElement(this);
  readonly head: FakeElement = new FakeElement(this);
  readonly body: FakeElement = new FakeElement(this);

  constructor() {
    this.documentElement.append(this.head, this.body);
  }

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  getElementById(id: string): FakeElement | null {
    return this.documentElement.all().find((el) => el.id === id) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.all().filter((el) => el.matches(selector));
  }
}

export function sheet(doc: FakeDocument, host: FakeElement) {
  const layer = doc.createElement();
  layer.className = 'cp-sheet-layer';
  layer.hidden = true;
  const panel = doc.createElement();
  panel.className = 'cp-sheet cp-panel';
  panel.setAttribute('aria-modal', 'true');
  layer.append(panel);
  host.append(layer);
  return {
    layer,
    open() {
      layer.hidden = false;
      layer.className = 'cp-sheet-layer is-open';
    },
    startClosing() {
      layer.className = 'cp-sheet-layer';
    },
    finishClosing() {
      layer.hidden = true;
    },
  };
}

export function setup(lang = 'en') {
  const doc = new FakeDocument();
  doc.documentElement.lang = lang;
  const host = doc.createElement();
  host.className = 'cp-ui-host';
  doc.body.append(host);
  const settings = sheet(doc, host);
  let state: SurfaceState = NO_SURFACE;
  const layer = new NumberPopLayer(host as unknown as HTMLElement, () => ({
    read: () => state,
    dispose: () => undefined,
  }));
  const pops = () => layer.root.children as unknown as FakeElement[];
  const shown = () => pops().filter((el) => el.className === 'cp-pop' && !el.hidden);
  const sync = () => {
    state = readSurfaces(doc as unknown as Document);
  };
  return { doc, host, settings, layer, shown, pops, sync };
}

export function credit(magnitude: number, overrides: Partial<PopRequest> = {}): PopRequest {
  return {
    text: `+${magnitude}`,
    magnitude,
    color: '#f5b942',
    prism: false,
    from: { x: 195, y: 640 },
    to: { x: 60, y: 48 },
    ...overrides,
  };
}

export function run(layer: NumberPopLayer, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += FRAME) {
    layer.update(FRAME);
    each?.();
  }
}
