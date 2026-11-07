import type { CoinTier } from '@coinposh/shared';
import i18next from 'i18next';
import {
  CylinderGeometry,
  Mesh,
  MeshPhysicalNodeMaterial,
  PerspectiveCamera,
  Scene,
  Timer,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { detectBackend } from '../backend.ts';
import { createPostPipeline } from '../scene/post/postPipeline.ts';
import { QUALITY_PROFILES, QUALITY_TIERS, type QualityTier } from '../scene/quality/tiers.ts';
import { applyCameraPreset, createRivieraVenue } from '../scene/venues/riviera/index.ts';
import { easeInCubic, easeOutBack, lerp } from './easing.ts';
import { createVfx, type DropTrail, type VfxStats } from './index.ts';
import { tierMetal } from './palette.ts';

/**
 * Dev-only show reel for the juice effects, served by Vite at /src/vfx/preview.html.
 * Flags: `webgl` forces WebGL2, `reduced` forces reduced motion, `quality=low|medium|high`,
 * `lang=en|fr|de`, `effect=drop|fusion|cascade|obscene|reel` (default reel, which loops
 * every effect), and `manual` to only play effects triggered via `window.__vfxPlay(name)`.
 */
const EFFECTS = ['drop', 'fusion', 'cascade', 'obscene'] as const;
type PreviewEffect = (typeof EFFECTS)[number];

interface PreviewState {
  ready: boolean;
  backend: string;
  reduced: boolean;
  frames: number;
  played: string[];
  arrivals: number;
  stats: VfxStats | null;
  error?: string;
}

declare global {
  interface Window {
    __vfx?: PreviewState;
    __vfxPlay?: (effect: PreviewEffect) => void;
  }
}

const params = new URLSearchParams(location.search);
const quality: QualityTier = QUALITY_TIERS.find((t) => t === params.get('quality')) ?? 'high';
const reduced = params.has('reduced');
const effectParam = params.get('effect') ?? 'reel';
const state: PreviewState = {
  ready: false,
  backend: '',
  reduced,
  frames: 0,
  played: [],
  arrivals: 0,
  stats: null,
};
window.__vfx = state;

function coinMesh(tier: CoinTier): Mesh {
  const material = new MeshPhysicalNodeMaterial({
    color: tierMetal(tier),
    metalness: 1,
    roughness: 0.24,
  });
  const coin = new Mesh(new CylinderGeometry(0.0195, 0.0195, 0.0036, 40), material);
  coin.castShadow = true;
  return coin;
}

interface Animation {
  update(dt: number): boolean;
}

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  const stage = document.querySelector<HTMLElement>('#stage');
  const hud = document.querySelector<HTMLElement>('#hud');
  const balanceEl = document.querySelector<HTMLElement>('#balance');
  if (!canvas || !stage || !hud || !balanceEl)
    throw new Error('preview.html is missing #preview, #stage or #hud');

  await i18next.init({ lng: params.get('lang') ?? 'en', fallbackLng: 'en', resources: {} });
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    forceWebGL: params.has('webgl'),
  });
  await renderer.init();
  const backend = detectBackend(renderer.backend);
  state.backend = backend;

  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.05, 120);
  const venue = await createRivieraVenue(scene, renderer, {
    reducedMotion: reduced,
    quality: quality === 'low' ? 'low' : 'high',
  });
  venue.setPusherStroke(0.35);
  const post = createPostPipeline(renderer, scene, camera, QUALITY_PROFILES[quality], {
    reducedMotion: reduced,
  });

  const resize = (): void => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    applyCameraPreset(camera, venue.cameraPreset(camera.aspect));
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const vfx = createVfx({
    scene,
    camera,
    renderer,
    backend,
    overlay: stage,
    i18n: i18next,
    quality,
    reducedMotion: reduced,
    post,
    seed: 42,
  });

  let balance = 0;
  const credit =
    (value: number): (() => void) =>
    () => {
      balance += value;
      balanceEl.textContent =
        i18next.services.formatter?.format(balance, 'number', i18next.language, {}) ??
        String(balance);
      hud.dataset.bump = '1';
      setTimeout(() => (hud.dataset.bump = '0'), 120);
      state.arrivals++;
    };

  const animations = new Set<Animation>();

  const drop = (): void => {
    const coin = coinMesh('gold');
    const x = 0.06;
    const z = 0.12;
    const start = new Vector3(x, 0.32, z);
    coin.position.copy(start);
    scene.add(coin);
    const trail: DropTrail = vfx.dropTrail(start, { tier: 'gold' });
    let t = 0;
    let vy = 0;
    animations.add({
      update(dt) {
        t += dt;
        if (t < 0.18) {
          coin.scale.setScalar(easeOutBack(2)(t / 0.18));
          coin.rotation.y += dt * 30;
          return true;
        }
        vy -= 9.81 * 0.6 * dt;
        coin.position.y = Math.max(0.0018, coin.position.y + vy * dt);
        coin.rotation.x += dt * 9;
        trail.moveTo(coin.position);
        if (coin.position.y > 0.0018) return true;
        trail.end();
        coin.rotation.x = 0;
        vfx.contactSparks(coin.position, { strength: 0.9, surface: 'wood' });
        vfx.numberPop(25, coin.position, hud, { tier: 'gold', onArrive: credit(25) });
        setTimeout(() => coin.removeFromParent(), 1500);
        return false;
      },
    });
  };

  const fusion = (): void => {
    const center = new Vector3(-0.05, 0.0018, 0.05);
    const offsets = [
      new Vector3(0.05, 0, 0.01),
      new Vector3(-0.04, 0, 0.035),
      new Vector3(0.0, 0, -0.05),
    ];
    const coins = offsets.map((o) => {
      const c = coinMesh('silver');
      c.position.copy(center).add(o);
      scene.add(c);
      return c;
    });
    const result = coinMesh('gold');
    result.position.copy(center);
    result.visible = false;
    scene.add(result);
    const starts = coins.map((c) => c.position.clone());
    let t = 0;
    let hop = -1;
    vfx.fusion({
      sources: starts,
      center,
      tier: 'gold',
      onImpact: () => {
        for (const c of coins) c.removeFromParent();
        result.visible = true;
        hop = 0;
        vfx.numberPop(1234, center, hud, { tier: 'gold', onArrive: credit(1234) });
      },
    });
    animations.add({
      update(dt) {
        const scaled = dt * vfx.timeScale;
        t += scaled;
        coins.forEach((c, i) => {
          const from = starts[i];
          if (!from) return;
          const k = easeInCubic(Math.min(1, t / 0.32));
          c.position.lerpVectors(from, center, k);
          c.position.y = 0.0018 + Math.sin(k * Math.PI) * 0.02;
          c.rotation.y += scaled * 25 * k;
        });
        if (hop >= 0) {
          hop += scaled;
          const k = Math.min(1, hop / 0.42);
          result.position.y = 0.0018 + Math.sin(k * Math.PI) * 0.035;
          result.scale.setScalar(lerp(0.4, 1, easeOutBack(2.6)(Math.min(1, hop / 0.3))));
          if (k >= 1) {
            setTimeout(() => result.removeFromParent(), 1200);
            return false;
          }
        }
        return true;
      },
    });
  };

  const cascade = (): void => {
    vfx.cascade('chic');
    setTimeout(() => {
      vfx.cascade('lavish');
    }, 350);
    setTimeout(() => {
      vfx.cascade('opulent');
    }, 700);
    setTimeout(() => {
      vfx.cascade('decadent');
    }, 1050);
  };

  const obscene = (): void => {
    vfx.cascade('obscene');
    vfx.numberPop(2_500_000, new Vector3(0, 0.03, -0.02), hud, {
      rarity: 'heirloom',
      onArrive: credit(2_500_000),
    });
  };

  const play = (effect: PreviewEffect): void => {
    state.played.push(effect);
    ({ drop, fusion, cascade, obscene })[effect]();
  };
  window.__vfxPlay = play;

  const reel: [number, PreviewEffect][] =
    effectParam === 'reel'
      ? [
          [0.4, 'drop'],
          [2.2, 'fusion'],
          [4.2, 'cascade'],
          [6.2, 'obscene'],
        ]
      : EFFECTS.includes(effectParam as PreviewEffect)
        ? [[0.4, effectParam as PreviewEffect]]
        : [];
  const loop = effectParam === 'reel' ? 11 : 3.5;
  let clock = 0;
  let cursor = 0;

  const timer = new Timer();
  await renderer.setAnimationLoop((now: number) => {
    timer.update(now);
    const realDt = Math.min(timer.getDelta(), 0.1);
    if (!params.has('manual')) {
      clock += realDt;
      while (cursor < reel.length && (reel[cursor]?.[0] ?? Infinity) <= clock) {
        const entry = reel[cursor];
        if (entry) play(entry[1]);
        cursor++;
      }
      if (clock >= loop) {
        clock = 0;
        cursor = 0;
      }
    }
    const dt = vfx.update(realDt);
    for (const a of animations) if (!a.update(realDt)) animations.delete(a);
    venue.update(dt);
    post.render(now);
    state.frames++;
    state.stats = vfx.stats;
    state.ready = true;
  });
}

boot().catch((error: unknown) => {
  state.error = error instanceof Error ? error.message : String(error);
  console.error('[vfx preview] boot failed', error);
});
