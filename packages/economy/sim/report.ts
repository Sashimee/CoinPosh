import type { PacingMetric } from '../src/types.ts';
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

export function formatSummary(result: SimResult): string {
  const { options } = result;
  const passed = result.targets.filter((t) => t.pass).length;
  const out: string[] = [];

  out.push(
    `CoinPosh balancing sim · ${options.players} players · seed ${options.seed} · ${options.days} casual day${options.days === 1 ? '' : 's'}`,
    '',
    `Pacing targets (02-ECONOMY.md): ${passed}/${result.targets.length} on target`,
    table(
      ['', 'Target', 'Bound', 'At', 'Sim', 'p10 / p50 / p90'],
      result.targets.map((t) => [
        t.pass ? 'PASS' : 'MISS',
        t.target.label,
        formatBound(t.target),
        `p${t.target.percentile}`,
        formatMetric(t.target.metric, t.value),
        [t.distribution.p10, t.distribution.p50, t.distribution.p90]
          .map((v) => formatMetric(t.target.metric, v))
          .join(' / '),
      ]),
    ),
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
