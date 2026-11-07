import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { economyConfig } from '../src/config/index.ts';
import { simModel } from './model.ts';
import { formatMetric, formatSummary } from './report.ts';
import { percentile, runSimulation } from './simulate.ts';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

describe('percentile', () => {
  it('uses nearest rank and treats missing values as never reached', () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
    expect(percentile([1, 2, 3, 4], 10)).toBe(1);
    expect(percentile([1, Number.POSITIVE_INFINITY], 90)).toBe(Number.POSITIVE_INFINITY);
    expect(percentile([], 50)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('runSimulation', () => {
  const options = { days: 3, players: 12, seed: 5 };
  const result = runSimulation(economyConfig, simModel, options);
  // Seed handling is per player, so determinism and seed variance need only one player;
  // the full 12-player cohort above is reserved for the pacing assertions.
  const small = { days: 2, players: 1, seed: 5 };

  it('is deterministic for a seed', () => {
    fc.assert(
      fc.property(fc.nat(), (seed) => {
        const run = { ...small, seed };
        expect(runSimulation(economyConfig, simModel, run)).toEqual(
          runSimulation(economyConfig, simModel, run),
        );
      }),
      { numRuns: 5 },
    );
  });

  it('varies with the seed', () => {
    const a = runSimulation(economyConfig, simModel, small);
    const b = runSimulation(economyConfig, simModel, { ...small, seed: 6 });
    expect(b.active.firstAlbumSet).not.toEqual(a.active.firstAlbumSet);
    expect(b.casualDays).not.toEqual(a.casualDays);
  });

  it('evaluates every pacing target in 02-ECONOMY.md', () => {
    expect(result.targets.map((t) => t.target.id)).toEqual(economyConfig.pacing.map((t) => t.id));
  });

  it('hits every pacing target with the shipped numbers', () => {
    const misses = result.targets
      .filter((t) => !t.pass)
      .map((t) => `${t.target.label}: ${formatMetric(t.target.metric, t.value)}`);
    expect(misses).toEqual([]);
  });

  it('reports one median snapshot per casual day with steady progress', () => {
    expect(result.casualDays.map((d) => d.day)).toEqual([1, 2, 3]);
    const [d1, d2, d3] = result.casualDays;
    expect(d1?.venue).toBe(1);
    expect(d3?.activeMinutes).toBeGreaterThan(d2?.activeMinutes ?? Number.POSITIVE_INFINITY);
    expect(d3?.seasonTier).toBeGreaterThanOrEqual(d1?.seasonTier ?? Number.POSITIVE_INFINITY);
  });

  it('rejects nonsense options', () => {
    expect(() => runSimulation(economyConfig, simModel, { ...options, days: 0 })).toThrow(/--days/);
    expect(() => runSimulation(economyConfig, simModel, { ...options, players: 1.5 })).toThrow(
      /--players/,
    );
  });

  it('formats a readable summary', () => {
    const summary = formatSummary(result);
    expect(summary).toContain('Pacing targets (02-ECONOMY.md): 7/7 on target');
    expect(summary).toMatch(/PASS {2}Ascend Venue 1 \(active\)/);
    expect(summary).toContain('Casual player, median at end of each day');
  });
});

describe('formatMetric', () => {
  it('formats each metric for humans', () => {
    expect(formatMetric('activeSeconds', 42)).toBe('42 s');
    expect(formatMetric('activeSeconds', 125)).toBe('2 min 05 s');
    expect(formatMetric('activeSeconds', 4 * 3_600 + 60)).toBe('4 h 01 min');
    expect(formatMetric('activeHours', 28.46)).toBe('28.5 h');
    expect(formatMetric('casualDays', 2)).toBe('day 2.00');
    expect(formatMetric('ratio', 1.6)).toBe('×1.60');
    expect(formatMetric('ratio', Number.POSITIVE_INFINITY)).toBe('not reached');
  });
});

describe('sim CLI', () => {
  it('prints a pacing summary', () => {
    const out = execFileSync(process.execPath, [cli, '--days', '2', '--players', '3'], {
      encoding: 'utf8',
    });
    expect(out).toContain('CoinPosh balancing sim · 3 players · seed 1 · 2 casual days');
    expect(out).toContain('Pacing targets (02-ECONOMY.md)');
  });

  it('prints JSON on request', () => {
    const out = execFileSync(process.execPath, [cli, '--days', '1', '--players', '2', '--json'], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out) as { options: unknown; targets: unknown[] };
    expect(parsed.options).toEqual({ days: 1, players: 2, seed: 1 });
    expect(parsed.targets).toHaveLength(economyConfig.pacing.length);
  });

  it('fails loudly with usage on bad arguments', () => {
    const run = spawnSync(process.execPath, [cli, '--days', 'seven'], { encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--days expects an integer, got "seven"');
    expect(run.stderr).toContain('Usage: pnpm --filter economy sim');
  });
});
