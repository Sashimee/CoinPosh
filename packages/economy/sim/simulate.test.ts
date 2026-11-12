import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { economyConfig, ladderTargets } from '../src/config/index.ts';
import { runCli } from './cli.ts';
import { evaluateLadder, fusionShareFor } from './ladder.ts';
import { dropsBeforeFirstFall, simModel, type TablePile } from './model.ts';
import { formatMetric, formatSummary } from './report.ts';
import { percentile, runSimulation } from './simulate.ts';

function cli(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function misses(targets: ReturnType<typeof runSimulation>['targets']): string[] {
  return targets
    .filter((t) => !t.pass)
    .map((t) => `${t.target.label}: ${formatMetric(t.target.metric, t.value)}`);
}

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
  // packages/sim measured 0.87 to 0.94 coins off the front per coin dropped (balance
  // report T-1.16); the shipped tuning must hold across that whole range, not only at 1.25.
  const measured = { ...simModel, baseReturnRatio: 0.9 };
  const measuredResult = runSimulation(economyConfig, measured, options);
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

  it('hits every pacing and FTUE target with the shipped numbers', () => {
    expect(misses(result.targets)).toEqual([]);
    expect(misses(result.ftue)).toEqual([]);
  });

  it('still hits every pacing target at the front-edge return measured on the physics table', () => {
    expect(misses(measuredResult.targets)).toEqual([]);
  });

  it('never reaches the first upgrade from an empty table on 20 starting coins', () => {
    const empty = { ...economyConfig, openingHeap: { ...economyConfig.openingHeap, coins: 0 } };
    const run = runSimulation(empty, simModel, { days: 1, players: 2, seed: 5 });
    expect(run.active.firstUpgrade.p50).toBe(Number.POSITIVE_INFINITY);
    expect(run.targets.find((t) => t.target.id === 'firstUpgrade')?.pass).toBe(false);
  });

  it('pays the whole opening heap out to every player, at no less than its face value', () => {
    const { coins, tier } = economyConfig.openingHeap;
    const face = economyConfig.coinTiers.find((t) => t.id === tier)?.value ?? Number.NaN;
    expect(result.openingHeap).toMatchObject({ coins, tier, dropsBeforeFirstFall: 10 });
    expect(result.openingHeap.paid.p10).toBeGreaterThanOrEqual(coins * face);
    expect(result.active.heapCleared.unreached).toBe(0);
    expect(result.active.heapCleared.p90).toBeLessThan(5 * 60);
  });

  it('starts paying before the trust fund runs out', () => {
    const trustFund = economyConfig.upgradeLines.find((l) => l.effect.stat === 'startingCoins');
    expect(dropsBeforeFirstFall(simModel.pile, economyConfig.openingHeap.coins)).toBeLessThan(
      trustFund?.effect.base ?? 0,
    );
  });

  it('needs a silver heap to make the first upgrade at the measured return', () => {
    // A copper heap pays no more than the pile it stands in for: at 0.9 coins per drop the
    // trust fund barely grows (balance evidence for P-193). Aimed fusion bonus can carry a
    // copper start, so the heap is judged for the player who fuses least (whole chute).
    const firstUpgrade = (run: ReturnType<typeof runSimulation>) =>
      run.targets.find((t) => t.target.id === 'firstUpgrade');
    const wholeChute = {
      ...measured,
      fusionShare: fusionShareFor('casual', measured, economyConfig.fusion.bonusMultiplier),
    };
    const copper = runSimulation(
      { ...economyConfig, openingHeap: { ...economyConfig.openingHeap, tier: 'copper' } },
      wholeChute,
      options,
    );
    expect(firstUpgrade(copper)?.pass).toBe(false);
    expect(economyConfig.openingHeap.tier).toBe('silver');
    expect(firstUpgrade(runSimulation(economyConfig, wholeChute, options))?.pass).toBe(true);
    expect(firstUpgrade(measuredResult)?.pass).toBe(true);
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
    expect(summary).toMatch(
      /Opening heap: 100 silver coins on the house · first fall after 10 drops · paid \d+ \/ \d+ \/ \d+ coins/,
    );
    expect(summary).toMatch(/Opening heap cleared {2}/);
    expect(summary).toContain('Pacing targets (02-ECONOMY.md): 7/7 on target');
    expect(summary).toContain('FTUE targets (00-VISION.md): 1/1 on target');
    expect(summary).toMatch(/PASS {2}Ascend Venue 1 \(active\)/);
    expect(summary).toContain('Casual player, median at end of each day');
  });
});

describe('dropsBeforeFirstFall', () => {
  const pile: TablePile = {
    steadyCoins: 195,
    firstFallAfterDrops: 145,
    firstFallOnHeap: [
      [25, 56],
      [100, 10],
    ],
  };

  it('reads the measured points and the empty table exactly', () => {
    expect(dropsBeforeFirstFall(pile, 0)).toBe(145);
    expect(dropsBeforeFirstFall(pile, 25)).toBe(56);
    expect(dropsBeforeFirstFall(pile, 100)).toBe(10);
  });

  it('interpolates between points and holds the last one past the curve', () => {
    expect(dropsBeforeFirstFall(pile, 62.5)).toBe(33);
    expect(dropsBeforeFirstFall(pile, 110)).toBe(10);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(dropsBeforeFirstFall(pile, hi)).toBeLessThanOrEqual(dropsBeforeFirstFall(pile, lo));
      }),
    );
  });

  it('rejects a negative heap and a curve that is not ascending', () => {
    expect(() => dropsBeforeFirstFall(pile, -1)).toThrow(/heapCoins must be a finite number ≥ 0/);
    const unsorted: TablePile = {
      ...pile,
      firstFallOnHeap: [
        [100, 10],
        [25, 56],
      ],
    };
    expect(() => dropsBeforeFirstFall(unsorted, 200)).toThrow(/ascending/);
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
    const run = cli('--days', '2', '--players', '3');
    expect(run.code).toBe(0);
    expect(run.out).toContain('CoinPosh balancing sim · 3 players · seed 1 · 2 casual days');
    expect(run.out).toContain('Pacing targets (02-ECONOMY.md)');
    expect(run.err).toBe('');
  });

  it('prints usage on --help', () => {
    const run = cli('--help');
    expect(run.code).toBe(0);
    expect(run.out).toContain('Usage: pnpm --filter economy sim');
  });

  it('prints JSON on request, ignoring a pnpm "--" separator', () => {
    const run = cli('--', '--days', '1', '--players', '2', '--json');
    const parsed = JSON.parse(run.out) as { options: unknown; targets: unknown[]; ftue: unknown[] };
    expect(parsed.options).toEqual({ days: 1, players: 2, seed: 1 });
    expect(parsed.targets).toHaveLength(economyConfig.pacing.length);
    expect(parsed.ftue).toHaveLength(1);
  });

  it('exits 1 under --strict only when a target misses', () => {
    expect(cli('--days', '1', '--players', '2', '--empty-table', '--strict').code).toBe(1);
    expect(cli('--days', '1', '--players', '2', '--empty-table').code).toBe(0);
  });

  it('applies the --heap-coins and --heap-tier what-ifs', () => {
    const heap = (...argv: string[]) =>
      (
        JSON.parse(cli('--days', '1', '--players', '1', '--json', ...argv).out) as {
          openingHeap: { coins: number; tier: string; dropsBeforeFirstFall: number };
        }
      ).openingHeap;
    expect(heap()).toMatchObject({ coins: 100, tier: 'silver', dropsBeforeFirstFall: 10 });
    expect(heap('--heap-coins', '50', '--heap-tier', 'copper')).toMatchObject({
      coins: 50,
      tier: 'copper',
      dropsBeforeFirstFall: 33,
    });
    expect(heap('--empty-table')).toMatchObject({ coins: 0, dropsBeforeFirstFall: 145 });
  });

  it('applies the --return-ratio what-if', () => {
    const run = cli('--days', '1', '--players', '1', '--return-ratio', '0.9', '--json');
    const shipped = cli('--days', '1', '--players', '1', '--json');
    expect(run.out).not.toEqual(shipped.out);
  });

  it('applies the --fusion-share what-if', () => {
    const run = cli('--days', '1', '--players', '1', '--fusion-share', '0.77', '--json');
    const shipped = cli('--days', '1', '--players', '1', '--json');
    expect(run.out).not.toEqual(shipped.out);
    expect(
      cli('--days', '1', '--players', '1', '--fusion-share', '0.77', '--ladder').out,
    ).toContain('model fusion bonus per drop 0.241');
  });

  it('adds the fusion ladder under --ladder, in text and JSON', () => {
    const run = cli('--days', '1', '--players', '1', '--ladder');
    expect(run.code).toBe(0);
    expect(run.out).toContain('Fusion ladder (packages/sim');
    expect(run.out).toContain('First Diamond, 2 pinpoint taps/s');
    expect(run.out).toContain("Pacing per play style at the model's cadence");
    const json = JSON.parse(cli('--days', '1', '--players', '1', '--ladder', '--json').out) as {
      ladder: { targets: unknown[]; styles: unknown[] };
      pacing: { style: string; targets: unknown[] }[];
    };
    expect(json.ladder.targets).toHaveLength(ladderTargets.length);
    expect(json.ladder.styles).toHaveLength(12);
    expect(json.pacing.map((p) => p.style)).toEqual(['casual', 'steady', 'aimed', 'aimedPinpoint']);
    const plain = cli('--days', '1', '--players', '1').out;
    expect(plain).not.toContain('Fusion ladder');
    expect(plain).not.toContain('Pacing per play style');
  });

  it('counts ladder misses under --strict only with --ladder', () => {
    const ladderMissed = evaluateLadder(
      simModel,
      economyConfig.fusion.bonusMultiplier,
    ).targets.some((t) => !t.pass);
    expect(ladderMissed).toBe(true);
    expect(cli('--days', '1', '--players', '1', '--ladder', '--strict').code).toBe(1);
  });

  it('prints the rate-envelope table', () => {
    const run = cli('--envelope', '--seed', '3');
    const table = JSON.parse(run.out) as { seed: number; rows: { label: string }[] };
    expect(table.seed).toBe(3);
    expect(table.rows[0]?.label).toBe('Fresh table');
  });

  it.each([
    [['--days', 'seven'], '--days expects an integer, got "seven"'],
    [['--return-ratio', '0'], '--return-ratio expects a positive number, got "0"'],
    [['--fusion-share', '1.5'], '--fusion-share expects a share in [0, 1], got "1.5"'],
    [['--fusion-share', ''], '--fusion-share expects a share in [0, 1], got ""'],
    [['--heap-coins=-1'], '--heap-coins expects a whole number ≥ 0, got "-1"'],
    [['--heap-coins', '2.5'], '--heap-coins expects a whole number ≥ 0, got "2.5"'],
    [['--heap-tier', 'bronze'], '--heap-tier expects one of copper, silver, gold'],
    [['--bogus'], "Unknown option '--bogus'"],
  ])('fails loudly with usage on %j', (argv, message) => {
    const run = cli(...argv);
    expect(run.code).toBe(2);
    expect(run.out).toBe('');
    expect(run.err).toContain(message);
    expect(run.err).toContain('Usage: pnpm --filter economy sim');
  });
});
