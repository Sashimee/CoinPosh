import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERF_DIR } from './env.ts';

/** Turns perf-report/*.json from the perf project into a job-summary table. */

interface FramesReport {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly frameMs: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly blockingMsPerSecond: number;
  readonly jsHeapMb: number | null;
  readonly budgets: {
    readonly deviceFrameMs: number;
    readonly minFps: number;
    readonly maxP95FrameMs: number;
    readonly maxBlockingMsPerSecond: number;
    readonly maxJsHeapMb: number;
  };
}

interface BootReport {
  readonly playableMs: number;
  readonly firstDropMs: number;
  readonly budgetMs: number;
}

function load(name: string): unknown {
  const path = join(PERF_DIR, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
}

const verdict = (ok: boolean): string => (ok ? 'ok' : 'FAIL');
const fixed = (n: number, digits = 1): string => n.toFixed(digits);

const lines = ['### Perf (CI chromium, WebGL2 on SwiftShader, 390x844)', ''];
const boot = load('boot.json') as BootReport | null;
const frames = load('frames.json') as FramesReport | null;
if (!boot && !frames) lines.push('No perf report was written: the perf project did not get far.');
lines.push('| Metric | Measured | Budget | Status |', '| --- | ---: | ---: | --- |');
if (boot) {
  lines.push(
    `| Navigation to playable | ${fixed(boot.playableMs, 0)} ms | | |`,
    `| Navigation to first drop | ${fixed(boot.firstDropMs, 0)} ms | < ${String(boot.budgetMs)} ms | ${verdict(boot.firstDropMs < boot.budgetMs)} |`,
  );
}
if (frames) {
  const b = frames.budgets;
  lines.push(
    `| Average fps (${String(frames.frames)} frames in ${fixed(frames.seconds)} s) | ${fixed(frames.fps, 2)} | >= ${String(b.minFps)} | ${verdict(frames.fps >= b.minFps)} |`,
    `| Frame time p50 | ${fixed(frames.frameMs.p50)} ms | | |`,
    `| Frame time p95 | ${fixed(frames.frameMs.p95)} ms | <= ${String(b.maxP95FrameMs)} ms | ${verdict(frames.frameMs.p95 <= b.maxP95FrameMs)} |`,
    `| Frame time p99 | ${fixed(frames.frameMs.p99)} ms | | |`,
    `| Main-thread blocking | ${fixed(frames.blockingMsPerSecond)} ms/s | <= ${String(b.maxBlockingMsPerSecond)} ms/s | ${verdict(frames.blockingMsPerSecond <= b.maxBlockingMsPerSecond)} |`,
    `| JS heap | ${frames.jsHeapMb === null ? 'n/a' : `${fixed(frames.jsHeapMb)} MB`} | <= ${String(b.maxJsHeapMb)} MB | ${verdict(frames.jsHeapMb !== null && frames.jsHeapMb <= b.maxJsHeapMb)} |`,
    '',
    `Device budget (not measurable without a GPU): ${fixed(b.deviceFrameMs)} ms a frame, 60 fps.`,
  );
}

const report = `${lines.join('\n')}\n`;
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary, report);
process.stdout.write(report);
