import { CASCADE_TIERS } from '@coinposh/shared';
import i18next, { type i18n as I18n } from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, Vector3, type Mesh, type WebGPURenderer } from 'three/webgpu';
import { HAPTIC_PATTERNS } from './haptics.ts';
import {
  CONTACT_ACCENT,
  createVfx,
  EFFECT_JUICE,
  FUSION_TIMING,
  type JuiceItem,
  type Vfx,
  type VfxEffect,
  type VfxOptions,
} from './index.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS, tierMetal } from './palette.ts';

const FRAME = 1 / 60;

/** Just enough DOM for NumberPopLayer: the test runs in node, where there is none. */
class FakeStyle {
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

class FakeElement {
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  hidden = false;
  className = '';
  id = '';
  textContent = '';
  readonly clientWidth = 360;
  readonly clientHeight = 640;

  constructor(readonly ownerDocument: FakeDocument) {}

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

  setAttribute(): void {
    return undefined;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }

  find(predicate: (el: FakeElement) => boolean): FakeElement[] {
    return this.children.flatMap((c) => [...(predicate(c) ? [c] : []), ...c.find(predicate)]);
  }
}

class FakeDocument {
  readonly head: FakeElement = new FakeElement(this);
  readonly body: FakeElement = new FakeElement(this);

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  getElementById(id: string): FakeElement | null {
    return [this.head, this.body].flatMap((root) => root.find((el) => el.id === id))[0] ?? null;
  }
}

interface Rig {
  readonly vfx: Vfx;
  readonly camera: PerspectiveCamera;
  readonly vibrate: ReturnType<typeof vi.fn<(pattern: number[]) => boolean>>;
  readonly post: { uniforms: { bloomBoost: { value: number }; exposureBoost: { value: number } } };
  readonly overlay: FakeElement;
  readonly clock: { ms: number };
}

let i18n: I18n;

beforeAll(async () => {
  i18n = i18next.createInstance();
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: {} });
});

function rig(
  options: { reducedMotion?: boolean; seed?: number; pops?: 'both' | 'overlay' | 'i18n' } = {},
): Rig {
  const camera = new PerspectiveCamera(40, 9 / 16, 0.01, 50);
  camera.position.set(0, 0.6, 0.9);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const vibrate = vi.fn<(pattern: number[]) => boolean>(() => true);
  const post = { uniforms: { bloomBoost: { value: 1 }, exposureBoost: { value: 1 } } };
  const overlay = new FakeDocument().body;
  const clock = { ms: 0 };
  const pops = options.pops ?? 'both';
  const vfxOptions: VfxOptions = {
    scene: new Scene(),
    camera,
    // The WebGL2 path simulates on the CPU and never touches the renderer while stepping.
    renderer: {} as WebGPURenderer,
    backend: 'webgl2',
    reducedMotion: options.reducedMotion ?? false,
    post,
    seed: options.seed ?? 7,
    navigator: { vibrate },
    now: () => clock.ms,
    ...(pops === 'i18n' ? {} : { overlay: overlay as unknown as HTMLElement }),
    ...(pops === 'overlay' ? {} : { i18n }),
  };
  return { vfx: createVfx(vfxOptions), camera, vibrate, post, overlay, clock };
}

function frame(r: Rig): number {
  r.clock.ms += FRAME * 1000;
  return r.vfx.update(FRAME);
}

function run(r: Rig, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) frame(r);
}

interface Trace {
  readonly items: Set<JuiceItem>;
  readonly cameraMoved: boolean;
  /** Real seconds spent at a time scale strictly between a freeze and full speed. */
  readonly slowSeconds: number;
  readonly vibrations: number[][];
}

/** Fires one effect and records which checklist items it visibly delivers. */
function observe(r: Rig, fire: (vfx: Vfx) => void, seconds = 2): Trace {
  const { camera } = r;
  const position = camera.position.clone();
  const quaternion = camera.quaternion.clone();
  const fov = camera.fov;
  const calls = r.vibrate.mock.calls.length;
  const items = new Set<JuiceItem>();
  let cameraMoved = false;
  let shaken = false;
  let slowSeconds = 0;
  fire(r.vfx);
  for (let t = 0; t < seconds; t += FRAME) {
    frame(r);
    const s = r.vfx.stats;
    if (s.particles + s.confetti > 0) items.add('particles');
    if (s.flashStretch > 1) items.add('squashOvershoot');
    if (s.glow > 0) items.add('lightResponse');
    if (s.pops > 0) items.add('numberPop');
    if (s.timeScale < 1) items.add('timeManipulation');
    if (s.timeScale > 0 && s.timeScale < 1) slowSeconds += FRAME;
    if (!camera.position.equals(position) || camera.fov !== fov) cameraMoved = true;
    if (!camera.quaternion.equals(quaternion)) shaken = true;
  }
  const vibrations = r.vibrate.mock.calls.slice(calls).map(([pattern]) => pattern);
  if (cameraMoved) items.add('camera');
  if (shaken || vibrations.length > 0) items.add('hapticOrShake');
  return { items, cameraMoved: cameraMoved || shaken, slowSeconds, vibrations };
}

const at = new Vector3(0.02, 0.01, -0.05);
const sources = [
  new Vector3(-0.05, 0.01, 0),
  new Vector3(0.05, 0.01, 0),
  new Vector3(0, 0.01, 0.06),
];

const EFFECTS: Readonly<Record<VfxEffect, (vfx: Vfx) => void>> = {
  dropTrail: (vfx) => {
    const trail = vfx.dropTrail(new Vector3(0, 0.3, 0.1), { tier: 'gold' });
    trail.moveTo(new Vector3(0, 0.15, 0.08));
  },
  contactSparks: (vfx) => {
    vfx.contactSparks(at, { strength: 0.6, surface: 'coin' });
  },
  fusion: (vfx) => {
    vfx.fusion({ sources, center: at, tier: 'gold' });
  },
  fusionCompact: (vfx) => {
    vfx.fusion({ sources, center: at, tier: 'silver' });
  },
  cascade: (vfx) => {
    vfx.cascade('opulent');
  },
  obscene: (vfx) => {
    vfx.obscene();
  },
  numberPop: (vfx) => {
    vfx.numberPop(250, at, { x: 300, y: 40 }, { tier: 'gold' });
  },
};

describe('juice checklist, measured on the facade', () => {
  it.each(Object.keys(EFFECTS) as VfxEffect[])(
    '%s delivers every item it claims, and at least 4 without sound',
    (effect) => {
      const { items } = observe(rig(), EFFECTS[effect]);
      const claimed = EFFECT_JUICE[effect].items;
      expect([...items].sort()).toEqual(expect.arrayContaining([...claimed].sort()));
      expect(items.has('sound')).toBe(false);
      expect(items.size).toBeGreaterThanOrEqual(4);
      expect(EFFECT_JUICE[effect].reduced.length).toBeGreaterThan(10);
    },
  );

  it.each(CASCADE_TIERS)('cascade %s reaches 4 items, with the camera from OPULENT up', (tier) => {
    const { items } = observe(rig(), (vfx) => {
      vfx.cascade(tier);
    });
    expect(items.size).toBeGreaterThanOrEqual(4);
    expect(items.has('camera')).toBe(CASCADE_TIERS.indexOf(tier) >= 2);
  });

  it.each([CONTACT_ACCENT + 0.01, 0.75, 1])('a contact at strength %s reaches 4 items', (s) => {
    const { items } = observe(rig(), (vfx) => {
      vfx.contactSparks(at, { strength: s, surface: 'metal' });
    });
    expect(items.size).toBeGreaterThanOrEqual(4);
  });

  it('a soft contact is particles only, the sub-interaction its scope documents', () => {
    const { items, vibrations } = observe(rig(), (vfx) => {
      vfx.contactSparks(at, { strength: CONTACT_ACCENT, surface: 'wood' });
    });
    expect([...items]).toEqual(['particles']);
    expect(vibrations).toEqual([]);
    expect(EFFECT_JUICE.contactSparks.scope).toMatch(/0\.45/);
  });
});

describe('fusion choreography', () => {
  it('fires onImpact on the frame the implosion ends, then freezes time for the hit-stop', () => {
    const r = rig();
    const onImpact = vi.fn();
    r.vfx.fusion({ sources, center: at, tier: 'gold', onImpact });
    const impactFrame = Math.ceil(FUSION_TIMING.implode / FRAME - 1e-9);
    for (let i = 1; i < impactFrame; i++) {
      frame(r);
      expect(onImpact).not.toHaveBeenCalled();
      expect(r.vfx.stats.flashes).toBe(0);
    }
    frame(r);
    expect(onImpact).toHaveBeenCalledTimes(1);
    expect(r.vfx.stats.shockwaves).toBe(2);
    expect(frame(r)).toBe(0);
    expect(r.vfx.timeScale).toBe(0);
    expect(r.vfx.stats.flashes).toBeGreaterThan(0);
    run(r, 0.2);
    expect(r.vfx.timeScale).toBe(1);
    expect(onImpact).toHaveBeenCalledTimes(1);
  });

  it('stalls the implosion while time is frozen, so the flash still lands on its beat', () => {
    const r = rig();
    const onImpact = vi.fn();
    r.vfx.fusion({ sources, center: at, tier: 'gold', onImpact });
    r.vfx.hitStop(100);
    run(r, FUSION_TIMING.implode + 0.02);
    expect(onImpact).not.toHaveBeenCalled();
    run(r, 0.2);
    expect(onImpact).toHaveBeenCalledTimes(1);
  });

  it('rejects a fusion with no source coins', () => {
    expect(() => {
      rig().vfx.fusion({ sources: [], center: at, tier: 'copper' });
    }).toThrow(RangeError);
  });
});

describe('fusion tiers on the facade', () => {
  const routine = (vfx: Vfx): void => {
    vfx.fusion({ sources, center: at, tier: 'silver' });
  };
  const peakFlashes = (r: Rig, seconds = 1): { flashes: number; rings: number } => {
    let flashes = 0;
    let rings = 0;
    for (let t = 0; t < seconds; t += FRAME) {
      frame(r);
      flashes = Math.max(flashes, r.vfx.stats.flashes);
      rings = Math.max(rings, r.vfx.stats.shockwaves);
    }
    return { flashes, rings };
  };

  it('plays a gold fusion in full: hit-stop, camera and the double ring', () => {
    const trace = observe(rig(), (vfx) => {
      vfx.fusion({ sources, center: at, tier: 'gold' });
    });
    expect(trace.items.has('timeManipulation')).toBe(true);
    expect(trace.cameraMoved).toBe(true);
    const again = rig();
    again.vfx.fusion({ sources, center: at, tier: 'gold' });
    expect(peakFlashes(again).rings).toBe(2);
  });

  it.each(['copper', 'silver'] as const)(
    'keeps even the first %s fusion of the session compact',
    (tier) => {
      const r = rig();
      const trace = observe(r, (vfx) => {
        vfx.fusion({ sources, center: at, tier });
      });
      expect(trace.cameraMoved).toBe(false);
      expect(trace.items.has('timeManipulation')).toBe(false);
      const next = rig();
      next.vfx.fusion({ sources, center: at, tier });
      expect(peakFlashes(next).rings).toBe(1);
    },
  );

  it('keeps a routine fusion compact: no hit-stop, no camera, one small ring', () => {
    const r = rig();
    const onImpact = vi.fn();
    const trace = observe(r, (vfx) => {
      vfx.fusion({ sources, center: at, tier: 'silver', onImpact });
    });
    expect(onImpact).toHaveBeenCalledTimes(1);
    expect(trace.cameraMoved).toBe(false);
    expect(trace.items.has('timeManipulation')).toBe(false);
    expect(trace.items.size).toBeGreaterThanOrEqual(4);
    const next = rig();
    routine(next.vfx);
    expect(peakFlashes(next).rings).toBe(1);
  });

  it('lands a routine fusion on the same beat, without freezing the world', () => {
    const r = rig();
    const onImpact = vi.fn();
    r.vfx.fusion({ sources, center: at, tier: 'silver', onImpact });
    const impactFrame = Math.ceil(FUSION_TIMING.implode / FRAME - 1e-9);
    for (let i = 0; i < impactFrame; i++) frame(r);
    expect(onImpact).toHaveBeenCalledTimes(1);
    expect(frame(r)).toBeCloseTo(FRAME, 9);
    expect(r.vfx.timeScale).toBe(1);
  });

  it('blooms far less for a routine fusion than for a gold one', () => {
    const peakGlow = (r: Rig): number => {
      let glow = 0;
      for (let t = 0; t < 1; t += FRAME) {
        frame(r);
        glow = Math.max(glow, r.vfx.glow);
      }
      return glow;
    };
    const gold = rig();
    gold.vfx.fusion({ sources, center: at, tier: 'gold' });
    const routineRig = rig();
    routine(routineRig.vfx);
    expect(peakGlow(routineRig)).toBeLessThan(peakGlow(gold) * 0.3);
  });

  it('plays gold and up in full after routine fusions', () => {
    for (const tier of ['gold', 'platinum', 'diamond', 'heirloom'] as const) {
      const r = rig();
      routine(r.vfx);
      run(r, 1);
      const trace = observe(r, (vfx) => {
        vfx.fusion({ sources, center: at, tier });
      });
      expect(trace.items.has('timeManipulation')).toBe(true);
      expect(trace.cameraMoved).toBe(true);
    }
  });

  it('plays one gold fusion per 3 s in full; the others go compact, no kick or freeze', () => {
    const r = rig();
    const rest = r.camera.fov;
    const gold = (seconds: number): { swing: number; froze: boolean } => {
      r.vfx.fusion({ sources, center: at, tier: 'gold' });
      let swing = 0;
      let froze = false;
      for (let t = 0; t < seconds; t += FRAME) {
        frame(r);
        swing = Math.max(swing, Math.abs(r.camera.fov - rest));
        froze ||= r.vfx.timeScale === 0;
      }
      return { swing, froze };
    };
    const kicked = gold(1.5);
    expect(kicked.swing).toBeGreaterThan(1);
    expect(kicked.froze).toBe(true);
    const muted = gold(1.6);
    expect(muted.swing).toBeLessThan(0.01);
    expect(muted.froze).toBe(false);
    const rested = gold(1);
    expect(rested.swing).toBeGreaterThan(1);
    expect(rested.froze).toBe(true);
  });

  it('keeps reduced motion in spirit: bloom in place, no shake, no hit-stop on routine ones', () => {
    const r = rig({ reducedMotion: true });
    const trace = observe(r, routine);
    expect(trace.cameraMoved).toBe(false);
    expect(trace.items.has('timeManipulation')).toBe(false);
    expect(trace.items.has('squashOvershoot')).toBe(false);
    expect([...trace.items]).toEqual(
      expect.arrayContaining(['particles', 'lightResponse', 'hapticOrShake']),
    );
  });
});

describe('attractor leasing', () => {
  const centre = (i: number): Vector3 => new Vector3(0.1 * (i + 1), 0.01, -0.1);
  const fuse = (r: Rig, i: number): void => {
    r.vfx.fusion({ sources, center: centre(i), tier: 'copper' });
  };

  it('keeps a stolen slot held until its newest fusion releases it', () => {
    const r = rig();
    for (let i = 0; i < 4; i++) fuse(r, i);
    expect(r.vfx.stats.attractors).toBe(4);
    run(r, 0.1);
    fuse(r, 4);
    fuse(r, 5);
    expect(r.vfx.stats.attractors).toBe(4);
    let frames = 0;
    while (r.vfx.stats.attractors === 4 && frames++ < 120) frame(r);
    // The first four release together; the two that stole their slots are still imploding.
    expect(r.vfx.stats.attractors).toBe(2);
    run(r, 1);
    expect(r.vfx.stats.attractors).toBe(0);
  });
});

describe('contact throttle', () => {
  const sparksFrom = (contacts: number, strength = 0.5): number => {
    const r = rig({ seed: 3 });
    for (let i = 0; i < contacts; i++) r.vfx.contactSparks(at, { strength, surface: 'coin' });
    frame(r);
    return r.vfx.stats.particles;
  };

  it('drops the 11th contact in one frame', () => {
    expect(sparksFrom(10)).toBeGreaterThan(sparksFrom(9));
    expect(sparksFrom(11)).toBe(sparksFrom(10));
  });

  it('accepts contacts again on the next frame', () => {
    const r = rig({ seed: 3 });
    for (let i = 0; i < 11; i++) r.vfx.contactSparks(at, { strength: 0.5, surface: 'coin' });
    frame(r);
    const before = r.vfx.stats.particles;
    r.vfx.contactSparks(at, { strength: 0.5, surface: 'coin' });
    expect(r.vfx.stats.particles).toBeGreaterThan(before);
  });

  it('ignores contacts below the minimum strength', () => {
    expect(sparksFrom(5, 0.05)).toBe(0);
  });
});

describe('reduced motion', () => {
  it.each(Object.keys(EFFECTS) as VfxEffect[])(
    '%s leaves the camera alone and never slows time',
    (effect) => {
      const trace = observe(rig({ reducedMotion: true }), EFFECTS[effect]);
      expect(trace.cameraMoved).toBe(false);
      // Only the 60 ms ease out of a kept hit-stop may sit between frozen and full speed.
      expect(trace.slowSeconds).toBeLessThanOrEqual(0.07);
      expect(trace.items.has('particles') || trace.items.has('numberPop')).toBe(true);
    },
  );

  it('keeps the obscene slow-mo out (the full-motion run shows the probe would see it)', () => {
    expect(observe(rig(), EFFECTS.obscene).slowSeconds).toBeGreaterThan(0.5);
    expect(observe(rig({ reducedMotion: true }), EFFECTS.obscene).slowSeconds).toBeLessThan(0.07);
  });

  it('turns a hard contact into a haptic tick, keeping the flash but not its pop', () => {
    const r = rig({ reducedMotion: true });
    const trace = observe(r, (vfx) => {
      vfx.contactSparks(at, { strength: 1, surface: 'metal' });
      vfx.update(FRAME);
      expect(vfx.stats.flashes).toBe(1);
      expect(vfx.stats.flashStretch).toBe(1);
    });
    expect(trace.vibrations).toEqual([[...HAPTIC_PATTERNS.tick]]);
    expect(trace.items.has('lightResponse')).toBe(true);
    expect(trace.items.has('squashOvershoot')).toBe(false);
    expect(trace.cameraMoved).toBe(false);
  });

  it.each(Object.keys(EFFECTS) as VfxEffect[])(
    '%s keeps every flash at its rest size (the full-motion run overshoots)',
    (effect) => {
      expect(observe(rig(), EFFECTS[effect]).items.has('squashOvershoot')).toBe(true);
      expect(
        observe(rig({ reducedMotion: true }), EFFECTS[effect]).items.has('squashOvershoot'),
      ).toBe(false);
    },
  );

  it('holds the heirloom prism still from the facade setting, not the OS media query', () => {
    const layer = (r: Rig): FakeElement => {
      const [root] = r.overlay.find((el) => el.className === 'cp-pops');
      if (!root) throw new Error('no pop layer');
      return root;
    };
    const css = (r: Rig): string =>
      r.overlay.ownerDocument.getElementById('coinposh-vfx-pops')?.textContent ?? '';
    const r = rig();
    r.vfx.numberPop(40, at, { x: 300, y: 40 }, { rarity: 'heirloom' });
    expect('reduced' in layer(r).dataset).toBe(false);
    expect(css(r)).toMatch(/\.cp-pops\[data-reduced\] \.cp-pop\[data-prism\]\{animation:none[;}]/);
    expect(css(r)).not.toMatch(/prefers-reduced-motion/);
    r.vfx.setReducedMotion(true);
    expect('reduced' in layer(r).dataset).toBe(true);
    r.vfx.setReducedMotion(false);
    expect('reduced' in layer(r).dataset).toBe(false);
    expect('reduced' in layer(rig({ reducedMotion: true })).dataset).toBe(true);
  });

  it('fades a number pop in place instead of flying it to the HUD', () => {
    const positions = (reducedMotion: boolean): Set<string> => {
      const r = rig({ reducedMotion });
      r.vfx.numberPop(25, at, { x: 300, y: 40 });
      const seen = new Set<string>();
      for (let t = 0; t < 1.2 && r.vfx.stats.pops > 0; t += FRAME) {
        frame(r);
        const el = r.overlay.find((e) => e.className === 'cp-pop' && !e.hidden)[0];
        const translate = /^translate\([^)]*\)/.exec(el?.style.transform ?? '')?.[0];
        if (translate) seen.add(translate);
      }
      return seen;
    };
    expect(positions(false).size).toBeGreaterThan(10);
    expect(positions(true).size).toBe(1);
  });

  it('drops kicks already in flight when toggled live and restores the camera', () => {
    const r = rig();
    const position = r.camera.position.clone();
    const quaternion = r.camera.quaternion.clone();
    const fov = r.camera.fov;
    r.vfx.obscene();
    run(r, 0.05);
    expect(r.camera.quaternion.equals(quaternion)).toBe(false);
    r.vfx.setReducedMotion(true);
    expect(r.vfx.reducedMotion).toBe(true);
    frame(r);
    expect(r.vfx.timeScale).toBe(1);
    run(r, 0.3);
    expect(r.camera.position.distanceTo(position)).toBeLessThan(1e-9);
    expect(r.camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-9);
    expect(r.camera.fov).toBeCloseTo(fov, 9);
  });
});

describe('drop trail', () => {
  const trailSparks = (idleSeconds: number): number => {
    const r = rig();
    const trail = r.vfx.dropTrail(new Vector3(0, 0.3, 0.1), { tier: 'silver' });
    run(r, idleSeconds);
    const before = r.vfx.stats.particles;
    trail.moveTo(new Vector3(0, 0.1, 0.05));
    return r.vfx.stats.particles - before;
  };

  it('keeps emitting while fed and closes once abandoned past the timeout', () => {
    expect(trailSparks(0.5)).toBeGreaterThan(0);
    expect(trailSparks(1.2)).toBe(0);
  });

  it('stops emitting after end() and after clear()', () => {
    const r = rig();
    const ended = r.vfx.dropTrail(new Vector3(0, 0.3, 0.1), { tier: 'gold' });
    const cleared = r.vfx.dropTrail(new Vector3(0.05, 0.3, 0.1), { tier: 'gold' });
    ended.end();
    r.vfx.clear();
    ended.moveTo(new Vector3(0, 0.1, 0.05));
    cleared.moveTo(new Vector3(0.05, 0.1, 0.05));
    expect(r.vfx.stats.particles).toBe(0);
  });
});

describe('number pops', () => {
  const popEl = (r: Rig): FakeElement => {
    const visible = r.overlay.find((el) => el.className === 'cp-pop' && !el.hidden);
    expect(visible).toHaveLength(1);
    const [el] = visible;
    if (!el) throw new Error('no visible pop');
    return el;
  };

  it('need an overlay and an i18n instance', () => {
    for (const pops of ['overlay', 'i18n'] as const) {
      expect(() => {
        rig({ pops }).vfx.numberPop(5, at, { x: 0, y: 0 });
      }).toThrow(/overlay, i18n/);
    }
  });

  it('take a coin tier its own metal, not a rarity colour', () => {
    const r = rig();
    r.vfx.numberPop(1234, at, { x: 300, y: 40 }, { tier: 'gold' });
    const el = popEl(r);
    expect(el.textContent).toBe('+1,234');
    expect(el.style.getPropertyValue('--pop')).toBe(tierMetal('gold'));
    expect(el.style.getPropertyValue('--pop')).not.toBe(RARITY_COLORS.rare);
    expect('prism' in el.dataset).toBe(false);
  });

  it('take a loot rarity the rarity palette, and heirloom either way the prism', () => {
    const rare = rig();
    rare.vfx.numberPop(40, at, { x: 300, y: 40 }, { rarity: 'rare' });
    expect(popEl(rare).style.getPropertyValue('--pop')).toBe(RARITY_COLORS.rare);
    for (const options of [{ rarity: 'heirloom' }, { tier: 'heirloom' }] as const) {
      const r = rig();
      r.vfx.numberPop(40, at, { x: 300, y: 40 }, options);
      expect('prism' in popEl(r).dataset).toBe(true);
    }
    expect(HEIRLOOM_PRISM.length).toBeGreaterThan(1);
  });

  it('refuse a rarity and a tier together', () => {
    expect(() => {
      rig().vfx.numberPop(1, at, { x: 0, y: 0 }, { rarity: 'fine', tier: 'silver' });
    }).toThrow(RangeError);
  });

  it('call onArrive once when the value lands in the HUD', () => {
    const r = rig();
    const onArrive = vi.fn();
    r.vfx.numberPop(9, at, { x: 300, y: 40 }, { onArrive });
    run(r, 3);
    expect(onArrive).toHaveBeenCalledTimes(1);
    expect(r.vfx.stats.pops).toBe(0);
  });
});

describe('clear and dispose', () => {
  it('clear() cancels pending beats and restores time, light and the camera', () => {
    const r = rig();
    const onImpact = vi.fn();
    const fov = r.camera.fov;
    r.vfx.fusion({ sources, center: at, tier: 'gold', onImpact });
    r.vfx.obscene();
    run(r, 0.1);
    expect(r.post.uniforms.bloomBoost.value).toBeGreaterThan(1);
    r.vfx.clear();
    expect(r.post.uniforms.bloomBoost.value).toBe(1);
    expect(r.post.uniforms.exposureBoost.value).toBe(1);
    expect(r.vfx.timeScale).toBe(1);
    expect(r.vfx.stats).toMatchObject({ particles: 0, confetti: 0, flashes: 0, shockwaves: 0 });
    run(r, 1);
    expect(onImpact).not.toHaveBeenCalled();
    expect(r.camera.fov).toBeCloseTo(fov, 6);
    expect(r.vfx.stats.attractors).toBe(0);
  });

  it('clear() resets particles in place, keeping their meshes and materials', () => {
    const r = rig();
    const meshes = r.vfx.root.children.filter((c) => c.name.startsWith('vfx-particles'));
    expect(meshes).toHaveLength(2);
    r.vfx.obscene();
    run(r, 0.1);
    r.vfx.clear();
    expect(r.vfx.root.children.filter((c) => c.name.startsWith('vfx-particles'))).toEqual(meshes);
    expect(meshes.every((m) => !m.visible)).toBe(true);
    frame(r);
    expect(r.vfx.stats).toMatchObject({ particles: 0, confetti: 0 });
    expect(r.vfx.confetti()).toBeGreaterThan(0);
    frame(r);
    expect(r.vfx.stats.confetti).toBeGreaterThan(0);
  });

  it('dispose() restores the post uniforms, detaches, and refuses further calls', () => {
    const r = rig();
    const parent = r.vfx.root.parent;
    r.vfx.obscene();
    run(r, 0.2);
    expect(r.post.uniforms.bloomBoost.value).toBeGreaterThan(1);
    expect(r.post.uniforms.exposureBoost.value).toBeGreaterThan(1);
    r.vfx.dispose();
    expect(r.post.uniforms.bloomBoost.value).toBe(1);
    expect(r.post.uniforms.exposureBoost.value).toBe(1);
    expect(parent).not.toBeNull();
    expect(r.vfx.root.parent).toBeNull();
    expect(r.overlay.find((el) => el.className === 'cp-pops')).toHaveLength(0);
    expect(() => r.vfx.update(FRAME)).toThrow(/disposed/);
    expect(() => {
      r.vfx.confetti();
    }).toThrow(/disposed/);
    expect(() => {
      r.vfx.clear();
    }).toThrow(/disposed/);
    expect(r.vfx.root.children.some((c) => c.name.startsWith('vfx-particles'))).toBe(false);
    r.vfx.dispose();
  });
});

describe('warmup', () => {
  const poolObjects = (r: Rig, name: string): Mesh[] =>
    (r.vfx.root.getObjectByName(name)?.children ?? []) as Mesh[];

  it('draws each pool through one shared material', () => {
    const r = rig();
    for (const name of ['vfx-flashes', 'vfx-shockwaves']) {
      const objects = poolObjects(r, name);
      expect(objects.length).toBeGreaterThan(1);
      expect(new Set(objects.map((o) => o.material)).size).toBe(1);
    }
  });

  it('shows one dark flash, one dark ring and both particle meshes while the frame draws', async () => {
    const r = rig();
    const particles = r.vfx.root.children.filter((c) => c.name.startsWith('vfx-particles'));
    let seen: { flashes: number; rings: number; particles: number } | null = null;
    await r.vfx.warmup(() => {
      seen = {
        flashes: poolObjects(r, 'vfx-flashes').filter((o) => o.visible).length,
        rings: poolObjects(r, 'vfx-shockwaves').filter((o) => o.visible).length,
        particles: particles.filter((o) => o.visible).length,
      };
    });
    expect(seen).toEqual({ flashes: 1, rings: 1, particles: 2 });
    const visible = r.vfx.root.children.flatMap((c) => [c, ...c.children]).filter((o) => o.visible);
    expect(visible.map((o) => o.name).sort()).toEqual(['vfx-flashes', 'vfx-shockwaves']);
    expect(r.vfx.stats).toMatchObject({ flashes: 0, shockwaves: 0, flashStretch: 0 });
  });

  it('hides the probes again when the frame throws', async () => {
    const r = rig();
    await expect(
      r.vfx.warmup(() => {
        throw new Error('device lost');
      }),
    ).rejects.toThrow('device lost');
    expect(poolObjects(r, 'vfx-flashes').some((o) => o.visible)).toBe(false);
    expect(poolObjects(r, 'vfx-shockwaves').some((o) => o.visible)).toBe(false);
  });
});
