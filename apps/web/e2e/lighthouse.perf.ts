import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import lighthouse, { type Result } from 'lighthouse';
import { GAME_URL, PERF_DIR } from './env.ts';
import { median, stampRun, writePerfReport, type WithHost } from './perf-report.ts';

/**
 * T-1.18 acceptance: Lighthouse performance >= 80 on the mobile preset, against the Demo Mode
 * build at the Pages base path `/`, as a first-time visitor loads it. Never lower this to turn a
 * red run green: report the score and the failing audits to their owners instead.
 */
const MIN_PERFORMANCE_SCORE = 80;

/**
 * Lighthouse's own advice for a stable score is the median of several runs. Simulated throttling
 * models the network and a 4x slower CPU from one unthrottled trace, so three runs suffice.
 */
const RUNS = 3;

/** How many failing audits each report lists, biggest estimated saving first. */
const TOP_AUDITS = 8;

const METRICS = {
  'first-contentful-paint': 'First Contentful Paint',
  'largest-contentful-paint': 'Largest Contentful Paint',
  'total-blocking-time': 'Total Blocking Time',
  'cumulative-layout-shift': 'Cumulative Layout Shift',
  'speed-index': 'Speed Index',
} as const;

type MetricId = keyof typeof METRICS;

interface Metric {
  readonly score: number | null;
  readonly value: number;
  readonly display: string;
}

interface FailingAudit {
  readonly id: string;
  readonly title: string;
  readonly score: number | null;
  readonly display: string;
  /** The audit's estimated saving across LCP, FCP and TBT, in ms; 0 when it names none. */
  readonly savingsMs: number;
}

interface LighthouseRun {
  readonly score: number;
  readonly metrics: Record<MetricId, Metric>;
  readonly failing: readonly FailingAudit[];
  readonly lighthouseVersion: string;
  readonly userAgent: string;
  readonly warnings: readonly string[];
}

function savingsMs(audit: Result['audits'][string]): number {
  const saved = audit.metricSavings;
  const fromMetrics = (saved?.LCP ?? 0) + (saved?.FCP ?? 0) + (saved?.TBT ?? 0);
  const details = audit.details as { overallSavingsMs?: unknown } | undefined;
  const overall = typeof details?.overallSavingsMs === 'number' ? details.overallSavingsMs : 0;
  return Math.max(fromMetrics, overall);
}

function summarize(lhr: Result): LighthouseRun {
  const { formFactor, throttlingMethod, screenEmulation } = lhr.configSettings;
  if (formFactor !== 'mobile' || !screenEmulation.mobile || throttlingMethod !== 'simulate') {
    throw new Error(
      `Lighthouse ran ${formFactor}/${throttlingMethod}, not the mobile preset with simulated throttling`,
    );
  }
  if (lhr.runtimeError) {
    throw new Error(`Lighthouse could not audit ${GAME_URL}: ${lhr.runtimeError.message}`);
  }
  const performance = lhr.categories.performance;
  const rawScore = performance?.score ?? null;
  if (!performance || rawScore === null) {
    throw new Error(
      `Lighthouse returned no performance score for ${GAME_URL}; its warnings: ${lhr.runWarnings.join('; ')}`,
    );
  }

  const metric = (id: MetricId): Metric => {
    const audit = lhr.audits[id];
    if (audit?.numericValue === undefined) throw new Error(`Lighthouse did not measure ${id}`);
    return { score: audit.score, value: audit.numericValue, display: audit.displayValue ?? '' };
  };
  const metrics = Object.fromEntries(
    (Object.keys(METRICS) as MetricId[]).map((id) => [id, metric(id)]),
  ) as Record<MetricId, Metric>;

  const failing = performance.auditRefs
    .filter((ref) => !(ref.id in METRICS))
    .map((ref) => lhr.audits[ref.id])
    .filter((audit) => audit !== undefined)
    .filter((audit) => {
      if (audit.score === null || audit.score >= 0.9) return false;
      if (savingsMs(audit) > 0) return true;
      // An insight that estimates no saving is informational, however Lighthouse scores it.
      if (audit.id.endsWith('-insight') || audit.scoreDisplayMode === 'metricSavings') return false;
      return audit.scoreDisplayMode === 'binary' || audit.scoreDisplayMode === 'numeric';
    })
    .map((audit) => ({
      id: audit.id,
      title: audit.title,
      score: audit.score,
      display: audit.displayValue ?? '',
      savingsMs: savingsMs(audit),
    }))
    .sort((a, b) => b.savingsMs - a.savingsMs || (a.score ?? 1) - (b.score ?? 1))
    .slice(0, TOP_AUDITS);

  return {
    score: Math.round(rawScore * 100),
    metrics,
    failing,
    lighthouseVersion: lhr.lighthouseVersion,
    userAgent: lhr.environment.hostUserAgent,
    warnings: lhr.runWarnings,
  };
}

/**
 * Chromium writes the port it picked for `--remote-debugging-port=0` here, so parallel worktrees
 * never fight over a fixed one.
 */
async function devtoolsPort(userDataDir: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const port = Number(text.split('\n')[0]);
    if (Number.isInteger(port) && port > 0) return port;
    if (Date.now() > deadline) {
      throw new Error(`Chromium wrote no DevToolsActivePort to ${userDataDir} within 10 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * One cold Lighthouse navigation in a fresh profile, on the same SwiftShader WebGL2 as the rest
 * of the perf project. Lighthouse opens its own tab over CDP and applies the mobile preset itself.
 */
async function audit(run: number): Promise<{ summary: LighthouseRun; html: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'coinposh-lighthouse-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0'],
  });
  try {
    const result = await lighthouse(
      GAME_URL,
      { port: await devtoolsPort(userDataDir), output: 'html', logLevel: 'error' },
      { extends: 'lighthouse:default', settings: { onlyCategories: ['performance'] } },
    );
    if (!result) throw new Error(`Lighthouse run ${String(run)} returned no result`);
    const html = Array.isArray(result.report) ? result.report.join('') : result.report;
    return { summary: summarize(result.lhr), html };
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function stepSummary(headline: LighthouseRun & { readonly scores: readonly number[] }): string {
  const status = headline.score >= MIN_PERFORMANCE_SCORE ? 'ok' : 'FAIL';
  const lines = [
    `### Lighthouse mobile (${headline.lighthouseVersion}, simulated throttling, SwiftShader)`,
    '',
    `Performance **${String(headline.score)}** (median of ${headline.scores.join(', ')}), budget >= ${String(MIN_PERFORMANCE_SCORE)}: ${status}`,
    '',
    '| Metric | Value | Score |',
    '| --- | ---: | ---: |',
    ...(Object.keys(METRICS) as MetricId[]).map((id) => {
      const m = headline.metrics[id];
      return `| ${METRICS[id]} | ${m.display} | ${m.score === null ? 'n/a' : String(Math.round(m.score * 100))} |`;
    }),
    '',
  ];
  if (headline.failing.length > 0) {
    lines.push(
      'Top opportunities (median run):',
      '',
      '| Audit | Result | Est. savings |',
      '| --- | --- | ---: |',
      ...headline.failing.map(
        (a) =>
          `| ${a.title} (\`${a.id}\`) | ${a.display} | ${a.savingsMs > 0 ? `${a.savingsMs.toFixed(0)} ms` : ''} |`,
      ),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

test.describe('Lighthouse mobile', () => {
  test(`the Demo Mode build scores performance >= ${String(MIN_PERFORMANCE_SCORE)} on the mobile preset`, async ({
    browserName,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Lighthouse audits Chromium only');
    test.setTimeout(RUNS * 120_000);

    const runs: WithHost<LighthouseRun>[] = [];
    const reports: string[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const { summary, html } = await audit(i + 1);
      runs.push(stampRun(summary));
      reports.push(html);
    }

    const score = median(runs.map((run) => run.score));
    const medianIndex = runs.findIndex((run) => run.score === score);
    const representative = runs[medianIndex === -1 ? 0 : medianIndex];
    if (!representative) throw new Error('Lighthouse produced no runs');
    const headline = {
      ...representative,
      statistic: `median of ${String(runs.length)}`,
      score,
      scores: runs.map((run) => run.score),
      budget: MIN_PERFORMANCE_SCORE,
    };

    await mkdir(PERF_DIR, { recursive: true });
    await writeFile(join(PERF_DIR, 'lighthouse.html'), reports[medianIndex] ?? reports[0] ?? '');
    await writePerfReport('lighthouse.json', headline, runs, testInfo);
    const summary = stepSummary(headline);
    process.stdout.write(summary);
    const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummaryPath) await appendFile(stepSummaryPath, summary);

    expect(
      score,
      `median Lighthouse mobile performance of runs ${headline.scores.join(', ')}; top audits: ${headline.failing
        .map((a) => `${a.id} ${a.display}`.trim())
        .join('; ')}`,
    ).toBeGreaterThanOrEqual(MIN_PERFORMANCE_SCORE);
  });
});
