import { WebGPURenderer } from 'three/webgpu';
import { detectBackend } from '../../backend.ts';
import { createQualityGovernor } from '../quality/adaptiveQuality.ts';
import { runBenchmark } from '../quality/benchmark.ts';
import { createBenchScene } from '../quality/benchScene.ts';
import { isQualityTier, QUALITY_PROFILES } from '../quality/tiers.ts';
import { createPostPipeline } from './postPipeline.ts';

// Dev-only harness served by `vite` at /src/scene/post/preview.html; not part of the build.
// Query: tier=low|medium|high, webgl=1, bench=1, raw=1 (no post), still=1 (reduced motion).
const params = new URLSearchParams(location.search);
const canvas = document.querySelector<HTMLCanvasElement>('#preview');
if (!canvas) throw new Error('preview.html is missing <canvas id="preview">');

const renderer = new WebGPURenderer({
  canvas,
  antialias: true,
  forceWebGL: params.get('webgl') === '1',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
await renderer.init();
const backend = detectBackend(renderer.backend);
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

const report: Record<string, string> = { backend };
if (params.get('bench') === '1') {
  const result = await runBenchmark(renderer);
  report.benchTier = result.tier;
  report.benchMs = result.msPerFrame.toFixed(2);
  report.benchSamples = result.samples.map((ms) => ms.toFixed(2)).join(',');
}

const requested = params.get('tier');
const profile = QUALITY_PROFILES[isQualityTier(requested) ? requested : 'high'];
const bench = createBenchScene(renderer);
const post = createPostPipeline(renderer, bench.scene, bench.camera, profile, {
  reducedMotion: params.get('still') === '1',
});
const governor = createQualityGovernor(post, { backend, store: null });
const raw = params.get('raw') === '1';
let frames = 0;

await renderer.setAnimationLoop((now) => {
  if (raw) {
    renderer.render(bench.scene, bench.camera);
  } else {
    governor.frame(now);
    post.render(now);
  }
  frames++;
  if (frames % 30 === 0) {
    Object.assign(document.body.dataset, report, {
      frames: String(frames),
      tier: governor.profile.tier,
      scale: governor.scale.toFixed(2),
      frameMs: governor.smoothedFrameMs?.toFixed(2) ?? '',
    });
  }
});
document.body.dataset.ready = '1';
