import {
  InstancedMesh,
  Matrix4,
  type MeshBasicNodeMaterial,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RenderTarget,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { detectBackend, type RenderBackend } from '../../backend.ts';
import { createAttractors, type ParticleEnvironment } from '../particles/physics.ts';
import type { ParticleSpawn } from '../particles/layout.ts';
import { ParticleSystem } from '../particles/system.ts';
import { createBrushMaterial, createFoilMaterial, createFoilUniforms } from './foil.ts';
import type { ScratchPoint } from './mask.ts';

/** The canvas overhangs the window by this share of its width on every side, so flakes can fly. */
export const SURFACE_MARGIN = 0.45;
export const MASK_SIZE = 512;
/** A second GPU context sits over the stage, so the foil's backing store stops short of DPR 2. */
export const MAX_SURFACE_PIXEL_RATIO = 1.5;
/** With nothing moving but the slow sheen, the foil redraws at this rate instead of every frame. */
export const IDLE_FRAME_SECONDS = 1 / 15;
const MAX_STAMPS_PER_FRAME = 256;
const FLAKE_CAPACITY = 768;
const GLINT_CAPACITY = 256;
const FOV = 30;

export type ScratchSurfaceKind = RenderBackend | 'canvas2d';

/** What draws the foil: the GPU mask on WebGPU or WebGL2, or a 2D canvas when neither starts. */
export interface ScratchSurface {
  readonly kind: ScratchSurfaceKind;
  readonly canvas: HTMLCanvasElement;
  /** Scratches the foil at `point` (window-normalised); drawn on the next frame. */
  stamp(point: ScratchPoint, radius: number): void;
  flakes(spawns: readonly ParticleSpawn[]): void;
  glints(spawns: readonly ParticleSpawn[]): void;
  setPointer(point: ScratchPoint | null): void;
  /** 0..1 dissolve of the foil left. */
  setClear(amount: number): void;
  /** 0..1 plain fade of the foil left (reduced motion). */
  setFade(amount: number): void;
  /** Particles run at this share of real time: 0 is the hit-stop freeze. */
  setTimeScale(scale: number): void;
  frame(dt: number): void;
  /** `width` is the window's side in css px; the canvas is that plus the margins. */
  resize(width: number, pixelRatio: number): void;
  dispose(): void;
}

/** A surface that can go back into the pool: `reset` makes it a whole, unscratched card again. */
export interface ReusableSurface extends ScratchSurface {
  reset(): void;
}

/**
 * Whether the foil must redraw this frame. Scratches, live particles, the dissolve and the
 * pointer spotlight all draw every frame; the ambient sheen alone redraws at `IDLE_FRAME_SECONDS`.
 */
export function foilNeedsFrame(work: {
  readonly stamps: number;
  readonly particles: number;
  readonly animating: boolean;
  readonly sinceDraw: number;
}): boolean {
  return (
    work.stamps > 0 || work.particles > 0 || work.animating || work.sinceDraw >= IDLE_FRAME_SECONDS
  );
}

/** Frees a renderer and, on WebGL2, its context: three only loses contexts on canvases it made. */
export async function releaseRenderer(
  renderer: Pick<WebGPURenderer, 'backend' | 'dispose'>,
  canvas: Pick<HTMLCanvasElement, 'width' | 'height'>,
): Promise<void> {
  const { backend } = renderer;
  try {
    await renderer.dispose();
  } finally {
    if (detectBackend(backend) === 'webgl2' && 'gl' in backend) {
      const gl = backend.gl as WebGL2RenderingContext | null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
    canvas.width = 0;
    canvas.height = 0;
  }
}

const NO_FLOOR: ParticleEnvironment['floor'] = { y: -100, minX: 1, maxX: 0, minZ: 1, maxZ: 0 };

class GpuScratchSurface implements ReusableSurface {
  readonly kind: RenderBackend;
  private readonly mask = new RenderTarget(MASK_SIZE, MASK_SIZE, { depthBuffer: false });
  private readonly brushScene = new Scene();
  private readonly brushCamera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  private readonly brushes: InstancedMesh<PlaneGeometry, MeshBasicNodeMaterial>;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.1, 20);
  private readonly uniforms = createFoilUniforms();
  private readonly foil: Mesh<PlaneGeometry, MeshBasicNodeMaterial>;
  private readonly flakeSystem: ParticleSystem;
  private readonly glintSystem: ParticleSystem;
  private readonly env: ParticleEnvironment = { floor: NO_FLOOR, attractors: createAttractors() };
  private readonly queue: { x: number; y: number; r: number }[] = [];
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly turn = new Quaternion();
  private timeScale = 1;
  private elapsed = 0;
  private sinceDraw = Infinity;
  private animating = false;
  private pointerOn = false;
  private maskReady = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly renderer: WebGPURenderer,
  ) {
    this.kind = detectBackend(renderer.backend);
    this.brushes = new InstancedMesh(
      new PlaneGeometry(1, 1),
      createBrushMaterial(),
      MAX_STAMPS_PER_FRAME,
    );
    this.brushes.count = 0;
    this.brushes.frustumCulled = false;
    this.brushScene.add(this.brushes);
    this.foil = new Mesh(
      new PlaneGeometry(1, 1),
      createFoilMaterial(this.mask.texture, this.uniforms),
    );
    this.foil.renderOrder = 10;
    this.scene.add(this.foil);
    this.flakeSystem = new ParticleSystem({
      capacity: FLAKE_CAPACITY,
      layer: 'confetti',
      backend: this.kind,
    });
    this.glintSystem = new ParticleSystem({
      capacity: GLINT_CAPACITY,
      layer: 'glow',
      backend: this.kind,
    });
    this.scene.add(this.flakeSystem.mesh, this.glintSystem.mesh);
    this.camera.position.set(0, 0, 3);
    this.renderer.setClearColor(0x000000, 0);
  }

  stamp(point: ScratchPoint, radius: number): void {
    this.queue.push({ x: point.x, y: point.y, r: radius });
  }

  flakes(spawns: readonly ParticleSpawn[]): void {
    for (const spawn of spawns) this.flakeSystem.emit(spawn);
  }

  glints(spawns: readonly ParticleSpawn[]): void {
    for (const spawn of spawns) this.glintSystem.emit(spawn);
  }

  setPointer(point: ScratchPoint | null): void {
    this.pointerOn = point !== null;
    if (point === null) this.uniforms.pointer.value.set(-10, -10);
    else this.uniforms.pointer.value.set(point.x, 1 - point.y);
    this.sinceDraw = Infinity;
  }

  setClear(amount: number): void {
    if (amount !== this.uniforms.clear.value) this.animating = true;
    this.uniforms.clear.value = amount;
  }

  setFade(amount: number): void {
    if (amount !== this.uniforms.fade.value) this.animating = true;
    this.uniforms.fade.value = amount;
  }

  setTimeScale(scale: number): void {
    this.timeScale = scale;
  }

  resize(width: number, pixelRatio: number): void {
    const side = Math.max(1, width * (1 + 2 * SURFACE_MARGIN));
    this.renderer.setPixelRatio(Math.min(pixelRatio, MAX_SURFACE_PIXEL_RATIO));
    this.renderer.setSize(side, side, false);
    this.sinceDraw = Infinity;
    const half = 0.5 + SURFACE_MARGIN;
    this.camera.aspect = 1;
    this.camera.position.z = half / Math.tan((FOV * Math.PI) / 360);
    this.camera.updateProjectionMatrix();
  }

  private drawStamps(): void {
    if (!this.maskReady) {
      this.renderer.setRenderTarget(this.mask);
      this.renderer.clear();
      this.maskReady = true;
    }
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_STAMPS_PER_FRAME);
      batch.forEach((stamp, index) => {
        this.position.set(stamp.x, 1 - stamp.y, 0);
        this.scale.set(stamp.r * 2, stamp.r * 2, 1);
        this.matrix.compose(this.position, this.turn, this.scale);
        this.brushes.setMatrixAt(index, this.matrix);
      });
      this.brushes.count = batch.length;
      this.brushes.instanceMatrix.needsUpdate = true;
      this.renderer.setRenderTarget(this.mask);
      this.renderer.render(this.brushScene, this.brushCamera);
    }
  }

  frame(dt: number): void {
    const step = dt * this.timeScale;
    this.elapsed += step;
    this.sinceDraw += dt;
    const particles =
      this.flakeSystem.simulation.liveEstimate +
      this.glintSystem.simulation.liveEstimate +
      this.flakeSystem.stats.emitted +
      this.glintSystem.stats.emitted;
    const draw = foilNeedsFrame({
      stamps: this.queue.length + (this.maskReady ? 0 : 1),
      particles,
      animating: this.animating || this.pointerOn,
      sinceDraw: this.sinceDraw,
    });
    this.animating = false;
    if (!draw) return;
    this.sinceDraw = 0;
    this.uniforms.time.value = this.elapsed;
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      this.drawStamps();
    } finally {
      this.renderer.autoClear = autoClear;
      this.renderer.setRenderTarget(null);
    }
    this.flakeSystem.update(step, this.env, this.renderer);
    this.glintSystem.update(step, this.env, this.renderer);
    this.renderer.render(this.scene, this.camera);
  }

  reset(): void {
    this.queue.length = 0;
    this.maskReady = false;
    this.timeScale = 1;
    this.uniforms.clear.value = 0;
    this.uniforms.fade.value = 0;
    this.setPointer(null);
    this.flakeSystem.clear();
    this.glintSystem.clear();
    this.canvas.remove();
  }

  dispose(): void {
    this.flakeSystem.dispose();
    this.glintSystem.dispose();
    this.brushes.geometry.dispose();
    this.brushes.material.dispose();
    this.brushes.dispose();
    this.foil.geometry.dispose();
    this.foil.material.dispose();
    this.mask.dispose();
    void releaseRenderer(this.renderer, this.canvas);
  }
}

/**
 * The last resort when no GPU backend starts: the foil is painted once and each stamp erases
 * with `destination-out`. No flakes, no dissolve, but the card stays playable.
 */
class CanvasScratchSurface implements ReusableSurface {
  readonly kind = 'canvas2d' as const;
  private readonly context: CanvasRenderingContext2D;
  private side = 1;
  private origin = 0;
  private window = 1;
  private readonly stamps: { x: number; y: number; r: number }[] = [];
  private fade = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('The scratch card could not get a 2D canvas context; no foil can be drawn');
    }
    this.context = context;
  }

  stamp(point: ScratchPoint, radius: number): void {
    this.stamps.push({ x: point.x, y: point.y, r: radius });
    this.erase(point.x, point.y, radius);
  }

  readonly flakes = (): void => undefined;

  readonly glints = (): void => undefined;

  readonly setPointer = (): void => undefined;

  setClear(amount: number): void {
    this.setFade(amount);
  }

  setFade(amount: number): void {
    this.fade = amount;
    this.canvas.style.opacity = String(1 - amount);
  }

  readonly setTimeScale = (): void => undefined;

  readonly frame = (): void => undefined;

  resize(width: number, pixelRatio: number): void {
    const ratio = Math.min(pixelRatio, MAX_SURFACE_PIXEL_RATIO);
    this.side = Math.max(1, Math.round(width * (1 + 2 * SURFACE_MARGIN) * ratio));
    this.window = this.side / (1 + 2 * SURFACE_MARGIN);
    this.origin = SURFACE_MARGIN * this.window;
    this.canvas.width = this.side;
    this.canvas.height = this.side;
    this.paint();
    for (const stamp of this.stamps) this.erase(stamp.x, stamp.y, stamp.r);
    this.setFade(this.fade);
  }

  private paint(): void {
    const { context: c, origin, window: w } = this;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, this.side, this.side);
    const gradient = c.createLinearGradient(origin, origin, origin + w, origin + w);
    gradient.addColorStop(0, '#9da2ab');
    gradient.addColorStop(0.45, '#dfe2e8');
    gradient.addColorStop(0.55, '#c9ccd3');
    gradient.addColorStop(1, '#8e939c');
    c.fillStyle = gradient;
    c.fillRect(origin, origin, w, w);
  }

  private erase(x: number, y: number, r: number): void {
    const { context: c, origin, window: w } = this;
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.arc(origin + x * w, origin + y * w, r * w, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
  }

  reset(): void {
    this.stamps.length = 0;
    this.paint();
    this.setFade(0);
    this.canvas.remove();
  }

  dispose(): void {
    this.stamps.length = 0;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

/** A card's hold on a pooled surface; its `dispose` hands the surface back instead of freeing it. */
class LeasedSurface implements ScratchSurface {
  private held: ReusableSurface | null;

  constructor(
    surface: ReusableSurface,
    private readonly giveBack: (surface: ReusableSurface) => void,
  ) {
    this.held = surface;
    this.kind = surface.kind;
    this.canvas = surface.canvas;
  }

  readonly kind: ScratchSurfaceKind;
  readonly canvas: HTMLCanvasElement;

  stamp(point: ScratchPoint, radius: number): void {
    this.held?.stamp(point, radius);
  }

  flakes(spawns: readonly ParticleSpawn[]): void {
    this.held?.flakes(spawns);
  }

  glints(spawns: readonly ParticleSpawn[]): void {
    this.held?.glints(spawns);
  }

  setPointer(point: ScratchPoint | null): void {
    this.held?.setPointer(point);
  }

  setClear(amount: number): void {
    this.held?.setClear(amount);
  }

  setFade(amount: number): void {
    this.held?.setFade(amount);
  }

  setTimeScale(scale: number): void {
    this.held?.setTimeScale(scale);
  }

  frame(dt: number): void {
    this.held?.frame(dt);
  }

  resize(width: number, pixelRatio: number): void {
    this.held?.resize(width, pixelRatio);
  }

  dispose(): void {
    const surface = this.held;
    this.held = null;
    if (surface !== null) this.giveBack(surface);
  }
}

/**
 * Keeps one started surface between cards. Collecting a card opens the next one at once, and a
 * fresh renderer per card would pile up GPU contexts until the browser force-loses the oldest,
 * which can be the stage's. A second card open at the same time gets its own surface, freed
 * when it closes, so no more than one idle surface is ever kept.
 */
export class SurfacePool {
  private idle: ReusableSurface | null = null;

  constructor(private readonly start: () => Promise<ReusableSurface>) {}

  async acquire(): Promise<ScratchSurface> {
    const surface = this.idle ?? (await this.start());
    if (this.idle === surface) this.idle = null;
    surface.reset();
    return new LeasedSurface(surface, (back) => {
      back.reset();
      if (this.idle === null) this.idle = back;
      else back.dispose();
    });
  }

  /** Frees the idle surface, if any; leased ones go when their card closes. */
  drain(): void {
    this.idle?.dispose();
    this.idle = null;
  }
}

async function startRenderer(
  canvas: HTMLCanvasElement,
  forceWebGL: boolean,
): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({ canvas, alpha: true, antialias: true, forceWebGL });
  try {
    await renderer.init();
  } catch (error) {
    await releaseRenderer(renderer, canvas);
    throw error;
  }
  return renderer;
}

export interface SurfaceOptions {
  /** Skip WebGPU and go straight to WebGL2 (`?gpu=webgl2` in the preview). */
  readonly forceWebGL?: boolean;
  /** Skip the GPU altogether. */
  readonly forceCanvas?: boolean;
}

/**
 * Starts the best surface the device has: WebGPU, else WebGL2, else a 2D canvas. Each failed
 * attempt gets a fresh canvas, since a canvas that handed out one context cannot give another.
 */
async function startScratchSurface(options: SurfaceOptions): Promise<ReusableSurface> {
  const attempts = options.forceCanvas ? [] : options.forceWebGL ? [true] : [false, true];
  for (const forceWebGL of attempts) {
    const canvas = document.createElement('canvas');
    try {
      return new GpuScratchSurface(canvas, await startRenderer(canvas, forceWebGL));
    } catch (error) {
      console.warn(
        `[CoinPosh] The scratch foil could not start on ${forceWebGL ? 'WebGL2' : 'WebGPU'}; trying the next backend`,
        error,
      );
    }
  }
  return new CanvasScratchSurface(document.createElement('canvas'));
}

const pools = new Map<string, SurfacePool>();

/** A started surface for one card, reused from the last card when it has closed. */
export function createScratchSurface(options: SurfaceOptions = {}): Promise<ScratchSurface> {
  const key = `${String(options.forceCanvas ?? false)}:${String(options.forceWebGL ?? false)}`;
  let pool = pools.get(key);
  if (pool === undefined) {
    pool = new SurfacePool(() => startScratchSurface(options));
    pools.set(key, pool);
  }
  return pool.acquire();
}
