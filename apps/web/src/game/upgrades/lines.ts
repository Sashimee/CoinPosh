import { upgradeLines, type UpgradeLineDef } from '@coinposh/economy';

/** The slice's upgrade tree; must match `UPGRADE_LINE_IDS_V1` in the server's upgrades route. */
export const UPGRADE_LINE_IDS_V1 = [
  'pusherSpeed',
  'dropRate',
  'coinValue',
  'crateChance',
  'vaultCapacity',
  'offlineHours',
] as const;
export type UpgradeLineIdV1 = (typeof UPGRADE_LINE_IDS_V1)[number];

export function isUpgradeLineV1(lineId: string): lineId is UpgradeLineIdV1 {
  return (UPGRADE_LINE_IDS_V1 as readonly string[]).includes(lineId);
}

/** Global lines: the Family Office, bought with Gold Bars and kept through every ascension. */
export function isFamilyOfficeLine(lineId: string): boolean {
  return upgradeLines.some((line) => line.id === lineId && line.scope === 'global');
}

export const UPGRADE_LINES_V1: readonly UpgradeLineDef[] = UPGRADE_LINE_IDS_V1.map((id) => {
  const line = upgradeLines.find((candidate) => candidate.id === id);
  if (line?.scope !== 'venue') {
    throw new Error(`Upgrade line "${id}" must be a venue line in packages/economy upgradeLines.`);
  }
  return line;
});
