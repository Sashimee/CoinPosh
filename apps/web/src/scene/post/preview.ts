import { WebGPURenderer } from 'three/webgpu';
import { detectBackend } from '../../backend.ts';
import { BENCH_LOOK, createBenchScene } from '../quality/benchScene.ts';
import { createAdaptiveRendering, qualityOverrideFrom } from '../quality/index.ts';

// Dev-only harness served by `vite` at /src/scene/post/preview.html; not part of the build.
// Query: quality=low|medium|high (skips the benchmark), webgl=1, raw=1 (no post),
// still=1 (reduced motion), cpu=<ms> (busy main thread per frame), cap=<n> (render every
// n-th rAF, like a 60/n Hz power cap), timestamps=0 (no GPU timer).
const params = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#preview');
if (!canvas) throw new Error('preview.html is missing <canvas id="preview">');

const renderer = new WebGPURenderer({
  canvas,
  antialias: false,
  trackTimestamp: params.get('timestamps') !== '0',
  forceWebGL: params.get('webgl') === '1',
});
await renderer.init();
const backend = detectBackend(renderer.backend);
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

const bench = createBenchScene(renderer);
const override = qualityOverrideFrom(location.search);
const adaptive = await createAdaptiveRendering({
  renderer,
  scene: bench.scene,
  camera: bench.camera,
  backend,
  store: null,
  look: BENCH_LOOK,
  ...(override === undefined ? {} : { override }),
  ...(params.get('still') === '1' ? { reducedMotion: true } : {}),
});
const report: Record<string, string> = {
  backend,
  source: adaptive.resolved.source,
  benchMs: adaptive.resolved.benchmarkMs?.toFixed(2) ?? '',
  gpuTimed: String(adaptive.gpuTimed),
  samples: String(renderer.samples),
};
const raw = params.get('raw') === '1';
const cpuMs = Number(params.get('cpu') ?? 0);
const cap = Math.max(1, Math.floor(Number(params.get('cap') ?? 1)));
let ticks = 0;
let frames = 0;

await renderer.setAnimationLoop((now) => {
  ticks++;
  if (ticks % cap !== 0) return;
  while (performance.now() - now < cpuMs) {
    // Simulated game logic: a fixed main-thread cost that resolution cannot reduce.
  }
  if (raw) renderer.render(bench.scene, bench.camera);
  else adaptive.render(now);
  frames++;
  if (frames % 30 === 0) {
    const { governor, post } = adaptive;
    Object.assign(document.body.dataset, report, {
      frames: String(frames),
      tier: governor.profile.tier,
      scale: governor.scale.toFixed(2),
      pixelRatio: String(renderer.getPixelRatio()),
      scenePixelRatio: post.scenePixelRatio.toFixed(2),
      frameMs: governor.smoothedFrameMs?.toFixed(2) ?? '',
      attribution: governor.controller.lastAttribution ?? '',
    });
  }
});
document.body.dataset.ready = '1';
