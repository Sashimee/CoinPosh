import {
  ascensionGoldBars,
  bullionFromValue,
  offlineEarnings,
  upgradeCost,
  upgradeStat,
} from '../src/formulas.ts';
import { ODDS_SCALE } from '../src/odds.ts';
import { initialPityState, rollDrop } from '../src/pity.ts';
import type { Rng } from '../src/rng.ts';
import {
  CASCADE_TIER_IDS,
  type AlbumItemDef,
  type DropTableDef,
  type EconomyConfig,
  type PityState,
  type RarityId,
  type UpgradeLineDef,
  type UpgradeStatId,
  type VenueDef,
} from '../src/types.ts';
import type { SimModel } from './model.ts';

export type MilestoneId =
  | 'firstUpgrade'
  | 'firstCrate'
  | 'firstCharm'
  | 'firstAlbumSet'
  | 'ascendVenue1'
  | 'ascendVenue2'
  | 'seasonFreeTrack';

export interface PlayerState {
  activeSeconds: number;
  venueIndex: number;
  coins: number;
  venueWinnings: number;
  goldBars: number;
  pearls: number;
  keys: number;
  tickets: number;
  stars: number;
  drops: number;
  crates: number;
  charms: number;
  albumCards: Set<string>;
  completedSets: Set<string>;
  albumBonus: number;
  levels: Map<string, number>;
  pity: PityState;
  dropCarry: number;
  milestones: Partial<Record<MilestoneId, number>>;
}

export interface PlayerContext {
  readonly config: EconomyConfig;
  readonly model: SimModel;
  readonly rng: Rng;
  readonly crateTable: DropTableDef;
  readonly albumByRarity: ReadonlyMap<string, ReadonlyMap<RarityId, readonly AlbumItemDef[]>>;
  readonly cascadeMean: number;
  readonly seasonStars: number;
}

export function createContext(config: EconomyConfig, model: SimModel, rng: Rng): PlayerContext {
  const crateTable = config.dropTables.find((t) => t.source === 'vaultCrate');
  if (crateTable === undefined) throw new Error('Sim needs a vaultCrate drop table');

  const albumByRarity = new Map<string, Map<RarityId, AlbumItemDef[]>>();
  for (const set of config.album) {
    const byRarity = albumByRarity.get(set.venue) ?? new Map<RarityId, AlbumItemDef[]>();
    for (const item of set.items) {
      const bucket = byRarity.get(item.rarity) ?? [];
      bucket.push(item);
      byRarity.set(item.rarity, bucket);
    }
    albumByRarity.set(set.venue, byRarity);
  }

  let comboShare = 0;
  let cascadeMean = 0;
  for (const tierId of CASCADE_TIER_IDS) {
    const tier = config.cascade.tiers.find((t) => t.id === tierId);
    if (tier === undefined) throw new Error(`Sim needs cascade tier "${tierId}"`);
    const share = model.cascadeShare[tierId];
    comboShare += share;
    cascadeMean += share * tier.multiplier;
  }
  if (comboShare > 1) throw new Error('simModel.cascadeShare must sum to ≤ 1');
  cascadeMean += 1 - comboShare;

  return {
    config,
    model,
    rng,
    crateTable,
    albumByRarity,
    cascadeMean,
    seasonStars: config.season.freeTiers * config.season.starsPerTier,
  };
}

export function createPlayer(ctx: PlayerContext): PlayerState {
  const player: PlayerState = {
    activeSeconds: 0,
    venueIndex: 0,
    coins: 0,
    venueWinnings: 0,
    goldBars: 0,
    pearls: 0,
    keys: 0,
    tickets: 0,
    stars: 0,
    drops: 0,
    crates: 0,
    charms: 0,
    albumCards: new Set(),
    completedSets: new Set(),
    albumBonus: 0,
    levels: new Map(),
    pity: initialPityState(ctx.config.pity),
    dropCarry: 0,
    milestones: {},
  };
  player.coins = stat(ctx, player, 'startingCoins');
  return player;
}

function levelOf(player: PlayerState, line: UpgradeLineDef): number {
  return player.levels.get(line.id) ?? 0;
}

function stat(ctx: PlayerContext, player: PlayerState, id: UpgradeStatId): number {
  const line = ctx.config.upgradeLines.find((l) => l.effect.stat === id);
  if (line === undefined) return 1;
  return upgradeStat(line, levelOf(player, line));
}

export function currentVenue(ctx: PlayerContext, player: PlayerState): VenueDef {
  const venue = ctx.config.venues[player.venueIndex];
  if (venue === undefined) throw new Error(`No venue at index ${player.venueIndex}`);
  return venue;
}

/** Expected value pushed off the ledge for one dropped coin of face value 1. */
export function grossPerDrop(ctx: PlayerContext, player: PlayerState): number {
  const { model, config } = ctx;
  const venue = currentVenue(ctx, player);
  const slotted = Math.min(player.charms, venue.charmSockets);
  const fusionLift =
    1 + model.fusionShare * stat(ctx, player, 'fusionWindow') * (config.fusion.bonusMultiplier - 1);
  return (
    model.baseReturnRatio *
    stat(ctx, player, 'pusherSpeed') *
    stat(ctx, player, 'coinValue') *
    ctx.cascadeMean *
    fusionLift *
    venue.coinValueMultiplier *
    stat(ctx, player, 'globalCoinValue') *
    (1 + slotted * model.charmIncomeBonus) *
    (1 + player.albumBonus)
  );
}

export function dropsPerSecond(ctx: PlayerContext, player: PlayerState): number {
  return ctx.model.baseDropsPerSecond * stat(ctx, player, 'dropRate');
}

/** Net coins per active second: what the server would measure as the player's active rate. */
export function netRatePerSecond(ctx: PlayerContext, player: PlayerState): number {
  return Math.max(0, dropsPerSecond(ctx, player) * (grossPerDrop(ctx, player) - 1));
}

function mark(player: PlayerState, id: MilestoneId): void {
  player.milestones[id] ??= player.activeSeconds;
}

function earn(player: PlayerState, value: number): void {
  player.coins += value;
  player.venueWinnings += value;
}

function grantAlbumCard(ctx: PlayerContext, player: PlayerState, rarity: RarityId): void {
  const venue = currentVenue(ctx, player);
  const pool = ctx.albumByRarity.get(venue.id)?.get(rarity);
  if (pool === undefined || pool.length === 0) return;
  const item = pool[ctx.rng.nextInt(pool.length)];
  if (item === undefined) return;
  player.albumCards.add(item.id);
  for (const set of ctx.config.album) {
    if (player.completedSets.has(set.id)) continue;
    if (set.items.every((i) => player.albumCards.has(i.id))) {
      player.completedSets.add(set.id);
      player.albumBonus += set.globalBonus;
      player.stars += ctx.config.season.starsPerAlbumSet;
      mark(player, 'firstAlbumSet');
    }
  }
}

function openCrate(ctx: PlayerContext, player: PlayerState, scripted: boolean): void {
  const { config, rng } = ctx;
  let rarity: RarityId;
  let forceCharm = false;
  if (scripted) {
    rarity = config.crateSpawn.ftueScriptedRarity;
    forceCharm = config.crateSpawn.ftueScriptedCharm;
  } else {
    const roll = rollDrop(ctx.crateTable, config.pity, player.pity, rng);
    rarity = roll.rarity;
    player.pity = roll.state;
  }
  const reward = config.crateRewards[rarity];
  player.crates += 1;
  mark(player, 'firstCrate');
  earn(player, reward.incomeSeconds * netRatePerSecond(ctx, player));
  player.pearls += reward.pearls;
  player.keys += reward.keys;
  player.tickets += reward.tickets;
  player.stars += config.season.starsPerCrate;
  if (forceCharm || rng.nextInt(ODDS_SCALE) < reward.charmChance) {
    player.charms += 1;
    mark(player, 'firstCharm');
  }
  if (reward.albumCard) grantAlbumCard(ctx, player, rarity);
}

function crateChancePerDrop(ctx: PlayerContext, player: PlayerState): number {
  return (
    (stat(ctx, player, 'crateChance') * stat(ctx, player, 'globalCrateChance')) /
    ctx.config.crateSpawn.dropsPerCrate
  );
}

function buyUpgrades(ctx: PlayerContext, player: PlayerState): void {
  const venueLines = ctx.config.upgradeLines.filter((l) => l.scope === 'venue');
  for (;;) {
    let best: { line: UpgradeLineDef; cost: number } | null = null;
    for (const line of venueLines) {
      const level = levelOf(player, line);
      if (level >= line.maxLevel) continue;
      const cost = upgradeCost(line, level);
      if (best === null || cost < best.cost) best = { line, cost };
    }
    if (best === null || player.coins - best.cost < ctx.model.dropReserve) return;
    player.coins -= best.cost;
    player.levels.set(best.line.id, levelOf(player, best.line) + 1);
    mark(player, 'firstUpgrade');
  }
}

function buyFamilyOffice(ctx: PlayerContext, player: PlayerState): void {
  const globalLines = ctx.config.upgradeLines.filter((l) => l.scope === 'global');
  for (;;) {
    let best: { line: UpgradeLineDef; cost: number } | null = null;
    for (const line of globalLines) {
      const level = levelOf(player, line);
      if (level >= line.maxLevel) continue;
      const cost = upgradeCost(line, level);
      if (best === null || cost < best.cost) best = { line, cost };
    }
    if (best === null || best.cost > player.goldBars) return;
    player.goldBars -= best.cost;
    player.levels.set(best.line.id, levelOf(player, best.line) + 1);
  }
}

export function venueBullion(ctx: PlayerContext, player: PlayerState): number {
  return bullionFromValue(player.venueWinnings, ctx.config.bullion);
}

function tryAscend(ctx: PlayerContext, player: PlayerState): void {
  const venue = currentVenue(ctx, player);
  const bullion = venueBullion(ctx, player);
  if (bullion < venue.bullionThreshold) return;
  if (player.venueIndex >= ctx.config.venues.length - 1) return;
  player.goldBars += ascensionGoldBars(bullion, venue.bullionThreshold, ctx.config.ascension);
  if (venue.order === 1) mark(player, 'ascendVenue1');
  if (venue.order === 2) mark(player, 'ascendVenue2');
  player.venueIndex += 1;
  for (const line of ctx.config.upgradeLines) {
    if (line.scope === 'venue') player.levels.delete(line.id);
  }
  buyFamilyOffice(ctx, player);
  player.venueWinnings = 0;
  player.coins = stat(ctx, player, 'startingCoins');
}

/** Advance one active tick: drops, returns, crates, purchases, ascension. */
export function activeTick(ctx: PlayerContext, player: PlayerState): void {
  const { model, config } = ctx;
  const dt = model.tickSeconds;
  player.dropCarry += dropsPerSecond(ctx, player) * dt;
  const gross = grossPerDrop(ctx, player);
  const crateChance = crateChancePerDrop(ctx, player);
  while (player.dropCarry >= 1 && player.coins >= 1) {
    player.dropCarry -= 1;
    player.coins -= 1;
    earn(player, gross);
    player.drops += 1;
    if (player.drops % config.season.dropsPerStar === 0) player.stars += 1;
    if (player.drops === config.crateSpawn.ftueScriptedDrop) {
      openCrate(ctx, player, true);
    } else if (ctx.rng.nextFloat() < crateChance) {
      openCrate(ctx, player, false);
    }
  }
  player.dropCarry = Math.min(player.dropCarry, 1);
  player.activeSeconds += dt;
  buyUpgrades(ctx, player);
  tryAscend(ctx, player);
  if (player.stars >= ctx.seasonStars) mark(player, 'seasonFreeTrack');
}

/** Claim the offline vault after `hoursAway`, as the server would on session start. */
export function claimOffline(ctx: PlayerContext, player: PlayerState, hoursAway: number): number {
  const ratePerHour = netRatePerSecond(ctx, player) * 3_600;
  const coins = offlineEarnings(
    hoursAway,
    stat(ctx, player, 'offlineHours'),
    ratePerHour,
    ctx.config.offline,
  );
  earn(player, coins);
  buyUpgrades(ctx, player);
  tryAscend(ctx, player);
  return coins;
}
