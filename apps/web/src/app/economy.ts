// apps/web does not list @coinposh/economy as a dependency yet (lead-architect owns
// package.json), so the package source is imported by path. Swap to '@coinposh/economy'
// once the workspace dependency exists.
export {
  cascade,
  cascadeTierFor,
  upgradeCost,
  upgradeLines,
  upgradeStat,
} from '../../../../packages/economy/src/index.ts';
export type {
  CascadeConfig,
  CascadeTierDef,
  CascadeTierId,
  UpgradeLineDef,
  UpgradeStatId,
} from '../../../../packages/economy/src/index.ts';
