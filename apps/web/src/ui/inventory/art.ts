import type { Rarity } from '@coinposh/shared';
import {
  Color,
  DirectionalLight,
  FloatType,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import type { RenderBackend } from '../../backend.ts';
import {
  createHeroMaterial,
  heroGeometry,
  type UnboxHero,
} from '../../vfx/cinematics/unbox/hero.ts';
import { RARITY_COLORS } from '../../vfx/palette.ts';
import type { ItemKind } from './model.ts';

/** The shared stage renderer: the cards borrow it between frames instead of opening a device. */
export interface CardArtSource {
  readonly renderer: Pick<
    WebGPURenderer,
    | 'render'
    | 'getRenderTarget'
    | 'setRenderTarget'
    | 'getClearColor'
    | 'getClearAlpha'
    | 'setClearColor'
    | 'readRenderTargetPixelsAsync'
    | 'compileAsync'
  >;
  readonly backend: RenderBackend;
  /** The venue's environment map, so the cards are lit like the table. */
  readonly environment?: () => Texture | null;
}

export interface CardArtSpec {
  readonly kind: ItemKind;
  readonly rarity: Rarity | null;
}

export interface CardArt {
  /** A vertical sprite sheet, `frames` square frames tall. */
  readonly url: string;
  readonly frames: number;
}

/** Output edge in px; rendered at twice this and box-filtered down for clean edges. */
export const ART_SIZE = 192;
const SUPERSAMPLE = 2;
const SWAY_FRAMES = 12;
const SWAY_YAW = 0.42;
const REST_PITCH = -0.18;
const FOV = 28;
const EXPOSURE = 1.15;

const HEROES: Readonly<Record<ItemKind, UnboxHero>> = {
  charm: 'charm',
  safe: 'safe',
  scratchCard: 'card',
};

export function artKey(spec: CardArtSpec): string {
  return `${spec.kind}:${spec.rarity ?? 'none'}`;
}

/**
 * WebGPU gets the slow sway loop; WebGL2 (and anything headless) gets one still frame, since
 * each frame costs a full float readback through a context that may be software-rendered.
 */
export function swayFrames(backend: RenderBackend): number {
  return backend === 'webgpu' ? SWAY_FRAMES : 1;
}

/** Yaw for frame `index` of a seamless loop: a sine, so the CSS steps() loop has no seam. */
export function frameYaw(index: number, frames: number): number {
  return frames <= 1 ? 0.32 : Math.sin((index / frames) * Math.PI * 2) * SWAY_YAW;
}

function acesFilmic(x: number): number {
  const v = Math.max(x, 0) * EXPOSURE * 0.6;
  return Math.min(Math.max((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0), 1);
}

function srgbEncode(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

/** Linear HDR to display sRGB in 0..255, the curve the canvas output pass would apply. */
export function displayByte(linear: number): number {
  return Math.round(srgbEncode(acesFilmic(linear)) * 255);
}

/**
 * Turns one supersampled float frame into 8-bit RGBA at `out`'s row `rowOffset`. Colour is
 * averaged premultiplied so the transparent background does not bleed dark fringes in.
 */
export function encodeFrame(
  pixels: ArrayLike<number>,
  size: number,
  factor: number,
  bottomUp: boolean,
  out: Uint8ClampedArray,
  rowOffset: number,
): void {
  const source = size * factor;
  const samples = factor * factor;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        const row = y * factor + sy;
        const sourceRow = bottomUp ? source - 1 - row : row;
        for (let sx = 0; sx < factor; sx++) {
          const i = (sourceRow * source + x * factor + sx) * 4;
          const alpha = Math.min(Math.max(pixels[i + 3] ?? 0, 0), 1);
          r += (pixels[i] ?? 0) * alpha;
          g += (pixels[i + 1] ?? 0) * alpha;
          b += (pixels[i + 2] ?? 0) * alpha;
          a += alpha;
        }
      }
      const o = ((rowOffset + y) * size + x) * 4;
      out[o] = a > 0 ? displayByte(r / a) : 0;
      out[o + 1] = a > 0 ? displayByte(g / a) : 0;
      out[o + 2] = a > 0 ? displayByte(b / a) : 0;
      out[o + 3] = Math.round((a / samples) * 255);
    }
  }
}

function accentFor(rarity: Rarity | null): Color {
  return new Color(RARITY_COLORS[rarity ?? 'common']);
}

async function toObjectUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Card art needs a 2D canvas to pack its sprite sheet');
  context.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (!blob) throw new Error('Card art could not encode its sprite sheet as PNG');
  return URL.createObjectURL(blob);
}

/**
 * Renders each card's hero prop (the unbox cinematic's geometry and material) offscreen with
 * the stage's renderer, one spec at a time, and caches the sprite sheet per kind and rarity.
 */
export class CardArtStudio {
  private readonly cache = new Map<string, Promise<CardArt | null>>();
  private readonly urls: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly hero = createHeroMaterial();
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.001, 1);
  private disposed = false;

  constructor(private readonly source: CardArtSource) {
    const key = new DirectionalLight(0xfff4d6, 3.2);
    key.position.set(0.4, 0.8, 1);
    const rim = new DirectionalLight(0xbfd4ff, 1.6);
    rim.position.set(-0.8, 0.3, -0.6);
    this.scene.add(new HemisphereLight(0xfaf3e3, 0x0b1630, 0.9), key, rim);
  }

  /** Resolves to `null` when the studio is disposed before the art is ready. */
  art(spec: CardArtSpec): Promise<CardArt | null> {
    if (this.disposed) return Promise.resolve(null);
    const key = artKey(spec);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const job = this.queue.then(() => this.render(spec));
    this.queue = job.catch(() => undefined);
    this.cache.set(key, job);
    return job;
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.length = 0;
    this.cache.clear();
    this.hero.material.dispose();
  }

  /** Read through a call: TypeScript would keep the pre-`await` narrowing of the field. */
  private stopped(): boolean {
    return this.disposed;
  }

  private async render(spec: CardArtSpec): Promise<CardArt | null> {
    if (this.disposed) return null;
    const { renderer, backend } = this.source;
    const frames = swayFrames(backend);
    const size = ART_SIZE * SUPERSAMPLE;
    const geometry = heroGeometry(HEROES[spec.kind]);
    const mesh = new Mesh(geometry, this.hero.material);
    this.hero.tint(accentFor(spec.rarity));
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere) throw new Error(`Hero ${spec.kind} has no bounding sphere`);
    const distance = (sphere.radius * 1.08) / Math.sin(((FOV / 2) * Math.PI) / 180);
    this.camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + distance);
    this.camera.lookAt(sphere.center);
    this.camera.updateProjectionMatrix();
    this.scene.environment = this.source.environment?.() ?? null;
    this.scene.add(mesh);

    const target = new RenderTarget(size, size, { type: FloatType, depthBuffer: true });
    const sheet = new Uint8ClampedArray(ART_SIZE * ART_SIZE * frames * 4);
    const previousTarget = renderer.getRenderTarget();
    const previousColor = renderer.getClearColor(new Color());
    const previousAlpha = renderer.getClearAlpha();
    try {
      // Pipelines compile before the first draw, or that draw could come back empty.
      await renderer.compileAsync(this.scene, this.camera);
      if (this.stopped()) return null;
      for (let frame = 0; frame < frames; frame++) {
        mesh.rotation.set(REST_PITCH, frameYaw(frame, frames), 0);
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.render(this.scene, this.camera);
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(previousColor, previousAlpha);
        const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
        // WebGL reads rows bottom-up; WebGPU copies them top-down.
        encodeFrame(pixels, ART_SIZE, SUPERSAMPLE, backend === 'webgl2', sheet, frame * ART_SIZE);
      }
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousColor, previousAlpha);
      this.scene.remove(mesh);
      geometry.dispose();
      target.dispose();
    }
    const url = await toObjectUrl(sheet, ART_SIZE, ART_SIZE * frames);
    if (this.stopped()) {
      URL.revokeObjectURL(url);
      return null;
    }
    this.urls.push(url);
    return { url, frames };
  }
}
