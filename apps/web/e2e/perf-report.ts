import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';
import { PERF_DIR } from './env.ts';

/** How busy the machine was while a sample ran: perf numbers on SwiftShader track CPU load. */
export interface HostLoad {
  /** os.loadavg(): the 1, 5 and 15 minute load averages. */
  readonly loadAverage: readonly [number, number, number];
  readonly cpus: number;
}

export function hostLoad(): HostLoad {
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return { loadAverage: [one, five, fifteen], cpus: cpus().length };
}

export type WithHost<Run extends object> = Run & { readonly host: HostLoad };

/**
 * One perf-report file: the numbers the gate judged at the top level, the host load when the
 * report was written, and every run behind them with the load it ran under.
 */
export type PerfReport<Headline extends object, Run extends object = Headline> = Headline & {
  readonly host: HostLoad;
  readonly runs: readonly WithHost<Run>[];
};

/** A run stamped with the load average it finished under. */
export function stampRun<Run extends object>(run: Run): WithHost<Run> {
  return { ...run, host: hostLoad() };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('No values, so there is no median');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? Number.NaN;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? Number.NaN) + upper) / 2;
}

/** Writes perf-report/`name` for perf.yml to upload and perf-summary.ts to print. */
export async function writePerfReport<Headline extends object, Run extends object>(
  name: string,
  headline: Headline,
  runs: readonly WithHost<Run>[],
  testInfo: TestInfo,
): Promise<PerfReport<Headline, Run>> {
  const report: PerfReport<Headline, Run> = { ...headline, host: hostLoad(), runs };
  await mkdir(PERF_DIR, { recursive: true });
  await writeFile(join(PERF_DIR, name), `${JSON.stringify(report, null, 2)}\n`);
  testInfo.annotations.push({ type: name, description: JSON.stringify(report) });
  return report;
}
