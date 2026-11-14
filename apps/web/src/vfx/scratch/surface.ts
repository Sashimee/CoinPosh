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

const NO_FLOOR: ParticleEnvironment['floor'] = { y: -100, minX: 1, maxX: 0, minZ: 1, maxZ: 0 };

class GpuScratchSurface implements ScratchSurface {
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
    if (point === null) this.uniforms.pointer.value.set(-10, -10);
    else this.uniforms.pointer.value.set(point.x, 1 - point.y);
  }

  setClear(amount: number): void {
    this.uniforms.clear.value = amount;
  }

  setFade(amount: number): void {
    this.uniforms.fade.value = amount;
  }

  setTimeScale(scale: number): void {
    this.timeScale = scale;
  }

  resize(width: number, pixelRatio: number): void {
    const side = Math.max(1, width * (1 + 2 * SURFACE_MARGIN));
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2));
    this.renderer.setSize(side, side, false);
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

  dispose(): void {
    this.flakeSystem.dispose();
    this.glintSystem.dispose();
    this.brushes.geometry.dispose();
    this.brushes.material.dispose();
    this.brushes.dispose();
    this.foil.geometry.dispose();
    this.foil.material.dispose();
    this.mask.dispose();
    void this.renderer.dispose();
  }
}

/**
 * The last resort when no GPU backend starts: the foil is painted once and each stamp erases
 * with `destination-out`. No flakes, no dissolve, but the card stays playable.
 */
class CanvasScratchSurface implements ScratchSurface {
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
    const ratio = Math.min(pixelRatio, 2);
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

  dispose(): void {
    this.stamps.length = 0;
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
    await renderer.dispose();
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
export async function createScratchSurface(options: SurfaceOptions = {}): Promise<ScratchSurface> {
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
