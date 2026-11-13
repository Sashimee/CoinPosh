import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERF_DIR } from './env.ts';
import { median, type HostLoad, type PerfReport } from './perf-report.ts';

/** Turns perf-report/*.json from the perf project into a job-summary table. */

interface FramesRun {
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

interface BootRun {
  readonly statistic?: string;
  readonly playableMs: number;
  readonly firstDropMs: number;
  readonly tapToDropMs: number;
  readonly longestFrameAfterTapMs: number;
  readonly budgetMs: number;
}

function load(name: string): unknown {
  const path = join(PERF_DIR, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
}

const verdict = (ok: boolean): string => (ok ? 'ok' : 'FAIL');
const fixed = (n: number, digits = 1): string => n.toFixed(digits);

function hostLine(host: HostLoad): string {
  return `load ${host.loadAverage.map((n) => fixed(n, 2)).join(' / ')} on ${String(host.cpus)} CPUs`;
}

/** One line per metric across the runs of an invocation, when there was more than one. */
function distribution<Run extends object>(
  title: string,
  report: PerfReport<Run>,
  metrics: readonly (readonly [string, (run: Run) => number, string])[],
): string[] {
  if (report.runs.length < 2) return [];
  return [
    '',
    `${title}, ${String(report.runs.length)} runs (median, then each run):`,
    '',
    ...metrics.map(([label, pick, unit]) => {
      const values = report.runs.map(pick);
      return `- ${label}: median ${fixed(median(values))} ${unit}; ${values.map((n) => fixed(n)).join(', ')}`;
    }),
    `- host: ${report.runs.map((run) => hostLine(run.host)).join('; ')}`,
  ];
}

const lines = ['### Perf (CI chromium, WebGL2 on SwiftShader, 390x844)', ''];
const boot = load('boot.json') as PerfReport<BootRun> | null;
const frames = load('frames.json') as PerfReport<FramesRun> | null;
if (!boot && !frames) lines.push('No perf report was written: the perf project did not get far.');
lines.push('| Metric | Measured | Budget | Status |', '| --- | ---: | ---: | --- |');
if (boot) {
  lines.push(
    `| Navigation to playable | ${fixed(boot.playableMs, 0)} ms | | |`,
    `| Navigation to first drop${boot.statistic ? ` (${boot.statistic})` : ''} | ${fixed(boot.firstDropMs, 0)} ms | < ${String(boot.budgetMs)} ms | ${verdict(boot.firstDropMs < boot.budgetMs)} |`,
    `| Tap to first drop in the sim | ${fixed(boot.tapToDropMs, 0)} ms | | |`,
    `| Longest frame in 1.5 s after the tap | ${fixed(boot.longestFrameAfterTapMs, 0)} ms | | |`,
    `| Boot host | ${hostLine(boot.host)} | | |`,
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
    `| Frames host | ${hostLine(frames.host)} | | |`,
    `| JS heap | ${frames.jsHeapMb === null ? 'n/a' : `${fixed(frames.jsHeapMb)} MB`} | <= ${String(b.maxJsHeapMb)} MB | ${verdict(frames.jsHeapMb !== null && frames.jsHeapMb <= b.maxJsHeapMb)} |`,
    '',
    `Device budget (not measurable without a GPU): ${fixed(b.deviceFrameMs)} ms a frame, 60 fps.`,
  );
}
if (boot) {
  lines.push(
    ...distribution('Boot', boot, [
      ['navigation to first drop', (run) => run.firstDropMs, 'ms'],
      ['navigation to playable', (run) => run.playableMs, 'ms'],
      ['longest frame after the tap', (run) => run.longestFrameAfterTapMs, 'ms'],
    ]),
  );
}
if (frames) {
  lines.push(
    ...distribution('Frames', frames, [
      ['average fps', (run) => run.fps, 'fps'],
      ['frame time p95', (run) => run.frameMs.p95, 'ms'],
      ['main-thread blocking', (run) => run.blockingMsPerSecond, 'ms/s'],
    ]),
  );
}

const report = `${lines.join('\n')}\n`;
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary, report);
process.stdout.write(report);
