import type { PacingMetric } from '../src/types.ts';
import {
  FUSED_TIERS,
  ladderMeasurement,
  playStyles,
  type LadderResult,
  type StylePacing,
} from './ladder.ts';
import type { MilestoneId } from './player.ts';
import type { Distribution, SimResult, TargetResult } from './simulate.ts';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3_600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s === 0 ? `${m} min` : `${m} min ${String(s).padStart(2, '0')} s`;
  }
  const h = Math.floor(seconds / 3_600);
  const m = Math.round((seconds % 3_600) / 60);
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

export function formatMetric(metric: PacingMetric, value: number): string {
  if (!Number.isFinite(value)) return 'not reached';
  switch (metric) {
    case 'activeSeconds':
      return formatDuration(value);
    case 'activeHours':
      return `${value.toFixed(1)} h`;
    case 'casualDays':
      return `day ${value.toFixed(2)}`;
    case 'ratio':
      return `×${value.toFixed(2)}`;
  }
}

function formatBound(t: TargetResult['target']): string {
  const f = (v: number): string => formatMetric(t.metric, v);
  if (t.min !== undefined && t.max !== undefined) return `${f(t.min)} – ${f(t.max)}`;
  if (t.max !== undefined) return `≤ ${f(t.max)}`;
  if (t.min !== undefined) return `≥ ${f(t.min)}`;
  return 'any';
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '─'.repeat(w))), ...rows.map(line)].join('\n');
}

const MILESTONE_LABELS: Readonly<Record<MilestoneId, string>> = {
  heapCleared: 'Opening heap cleared',
  firstUpgrade: 'First upgrade',
  firstCrate: 'First Vault Crate',
  firstCharm: 'First Charm',
  firstAlbumSet: 'First album set',
  ascendVenue1: 'Ascend Riviera Yacht',
  ascendVenue2: 'Ascend Salon de Paris',
  seasonFreeTrack: 'Free season track',
};

function milestoneRow(id: MilestoneId, d: Distribution, players: number): readonly string[] {
  return [
    MILESTONE_LABELS[id],
    formatDuration(d.p10),
    formatDuration(d.p50),
    formatDuration(d.p90),
    d.unreached === 0 ? '' : `${d.unreached}/${players} unreached`,
  ];
}

function targetTable(targets: readonly TargetResult[]): string {
  return table(
    ['', 'Target', 'Bound', 'At', 'Sim', 'p10 / p50 / p90'],
    targets.map((t) => [
      t.pass ? 'PASS' : 'MISS',
      t.target.label,
      formatBound(t.target),
      `p${t.target.percentile}`,
      formatMetric(t.target.metric, t.value),
      [t.distribution.p10, t.distribution.p50, t.distribution.p90]
        .map((v) => formatMetric(t.target.metric, v))
        .join(' / '),
    ]),
  );
}

function onTarget(targets: readonly TargetResult[]): string {
  return `${targets.filter((t) => t.pass).length}/${targets.length} on target`;
}

function openingHeapLine({ openingHeap: heap }: SimResult): string {
  const paid = [heap.paid.p10, heap.paid.p50, heap.paid.p90].map((v) => v.toFixed(0)).join(' / ');
  return (
    `Opening heap: ${heap.coins} ${heap.tier} coins on the house · first fall after ` +
    `${heap.dropsBeforeFirstFall} drop${heap.dropsBeforeFirstFall === 1 ? '' : 's'} · ` +
    `paid ${paid} coins (p10 / p50 / p90)`
  );
}

export function formatSummary(result: SimResult): string {
  const { options } = result;
  const out: string[] = [];

  out.push(
    `CoinPosh balancing sim · ${options.players} players · seed ${options.seed} · ${options.days} casual day${options.days === 1 ? '' : 's'}`,
    '',
    `Pacing targets (02-ECONOMY.md): ${onTarget(result.targets)}`,
    targetTable(result.targets),
    '',
    `FTUE targets (00-VISION.md): ${onTarget(result.ftue)}`,
    targetTable(result.ftue),
    '',
    openingHeapLine(result),
    '',
    `Active-play milestones (continuous play, capped at ${result.activeCapHours} h)`,
    table(
      ['Milestone', 'p10', 'p50', 'p90', ''],
      (Object.keys(result.active) as MilestoneId[]).map((id) =>
        milestoneRow(id, result.active[id], options.players),
      ),
    ),
    '',
    'Casual player, median at end of each day',
    table(
      [
        'Day',
        'Active',
        'Venue',
        'Bullion',
        'Gold Bars',
        'Crates',
        'Charms',
        'Sets',
        'Pearls',
        'Keys',
        'Season',
      ],
      result.casualDays.map((d) => [
        String(d.day),
        `${Math.round(d.activeMinutes)} min`,
        String(d.venue),
        `${Math.round(d.bullionProgress * 100)} %`,
        String(d.goldBars),
        String(d.crates),
        String(d.charms),
        String(d.albumSets),
        String(d.pearls),
        String(d.keys),
        `tier ${d.seasonTier}`,
      ]),
    ),
  );
  return out.join('\n');
}

export function formatLadder(result: LadderResult): string {
  const { simCommit, simVersion, seconds, seeds } = ladderMeasurement;
  const firsts = (d: { p10: number; p50: number; p90: number }): string =>
    [d.p10, d.p50, d.p90].map(formatDuration).join(' / ');
  return [
    `Fusion ladder (packages/sim ${simCommit}, SIM_VERSION ${simVersion}, ${seeds.length} seeds × ${seconds} s): ${onTarget(result.targets)}`,
    targetTable(result.targets),
    '',
    'First fusion into each tier, p10 / p50 / p90 (— = not inside the run), and seeds inside 60 s',
    table(
      ['Style', ...FUSED_TIERS, '≤ 60 s (S/G/P/D/H)'],
      result.styles.map((s) => [
        playStyles[s.style].label,
        ...FUSED_TIERS.map((tier) => firsts(s.firsts[tier])),
        FUSED_TIERS.map((tier) => String(s.withinMinute[tier])).join('/'),
      ]),
    ),
    '',
    `Rates per style (envelope windows: fusions 60 s, fallValue 30 s); model fusion bonus per drop ${result.modelFusionBonusPerDrop.toFixed(3)}, calibrated on ${playStyles[result.calibration.style].label} (${result.calibration.fusionBonusPerDrop.toFixed(3)})`,
    table(
      ['Style', 'Fusions/min', 'Busiest 60 s', 'Busiest fallValue 30 s', 'Fusion bonus/drop'],
      result.styles.map((s) => [
        playStyles[s.style].label,
        s.fusionsPerMinute.toFixed(1),
        String(s.busiestFusions),
        String(s.busiestFallValue),
        s.fusionBonusPerDrop.toFixed(3),
      ]),
    ),
  ].join('\n');
}

export function formatStylePacing(pacing: readonly StylePacing[]): string {
  const targets = pacing[0]?.targets ?? [];
  return [
    `Pacing per play style at the model's cadence (fusionShare from each style's ladder runs): ${onTarget(pacing.flatMap((p) => p.targets))}`,
    table(
      ['Style', 'fusionShare', ...targets.map((t) => t.target.label)],
      pacing.map((p) => [
        playStyles[p.style].label,
        p.fusionShare.toFixed(3),
        ...p.targets.map(
          (t) => `${formatMetric(t.target.metric, t.value)}${t.pass ? '' : ' MISS'}`,
        ),
      ]),
    ),
  ].join('\n');
}
