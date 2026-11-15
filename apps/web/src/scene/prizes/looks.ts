import {
  PRIZE_FAMILIES,
  PRIZE_RARITIES,
  type PrizeFamily,
  type PrizeRarity,
} from '@coinposh/shared';
import { RARITY_COLORS } from '../../vfx/palette.ts';

/**
 * The colours a prize is made of at one rarity, sRGB hex. The metal climbs from steel to rose
 * and yellow gold, and the enamel, dial and lacquer take a deep shade of the rarity's colour,
 * so a prize reads its rarity from across the table before any label shows.
 */
export interface PrizeLook {
  /** Case, collar and blade metal (the main body). */
  readonly metal: string;
  /** Polished trims: bezels, indices, hands, rims. */
  readonly trim: string;
  /**
   * Cufflink gold (03-ART: enamel and gold): a pale yellow gold at common that warms and
   * deepens up the ladder, rose at exquisite, the legendary tone at the top.
   */
  readonly gold: string;
  /** Dial, enamel inlay, lacquered cap and fob badge. */
  readonly enamel: string;
  readonly leather: string;
  readonly thread: string;
  /** Glass and crystal tint, nearly white. */
  readonly glass: string;
  readonly scent: string;
  /** The seconds hand and other small rarity flashes. */
  readonly accent: string;
  /** Brushing strength of the main metal; gold is polished smoother than steel. */
  readonly brush: number;
}

const STEEL = '#C9CDD2';
const STEEL_POLISHED = '#E3E6EA';

export const PRIZE_LOOKS: Readonly<Record<PrizeRarity, PrizeLook>> = {
  common: {
    metal: STEEL,
    trim: STEEL_POLISHED,
    gold: '#CDB27F',
    enamel: '#ECE6D6',
    leather: '#1C1915',
    thread: '#4A4237',
    glass: '#F4F8FA',
    scent: '#D9A441',
    accent: '#22262E',
    brush: 1,
  },
  fine: {
    metal: STEEL,
    trim: STEEL_POLISHED,
    gold: '#D6B46E',
    enamel: '#14563B',
    leather: '#3A2617',
    thread: '#D6C29A',
    glass: '#F0FAF4',
    scent: '#3FA36B',
    accent: RARITY_COLORS.fine,
    brush: 1,
  },
  rare: {
    metal: STEEL,
    trim: STEEL_POLISHED,
    gold: '#DDB862',
    enamel: '#14295A',
    leather: '#131C33',
    thread: '#C8D3E8',
    glass: '#F0F5FF',
    scent: '#3D7FD9',
    accent: '#F2EEE4',
    brush: 0.85,
  },
  exquisite: {
    metal: '#DFA98C',
    trim: '#F0C3A8',
    gold: '#DFA98C',
    enamel: '#3E1650',
    leather: '#2A1330',
    thread: '#E8B48A',
    glass: '#FBF2FF',
    scent: '#9B5FD9',
    accent: '#F0C3A8',
    brush: 0.6,
  },
  legendary: {
    metal: '#E1BC55',
    trim: '#F2D17A',
    gold: '#E1BC55',
    enamel: '#0C0C10',
    leather: '#0E0C0B',
    thread: '#E1BC55',
    glass: '#FFF9EC',
    scent: '#E8892C',
    accent: RARITY_COLORS.legendary,
    brush: 0.35,
  },
};

/**
 * The size of each family as modelled, in metres (x across the table, y up off it, z along
 * it), lying in its rest pose: the watch dial up with its strap stretched along z, the flacon
 * on its broad face with the neck towards -z, the cufflinks on their velvet pad and the keys
 * flat. The sim's prize bodies should match these boxes.
 */
export const PRIZE_DIMENSIONS: Readonly<Record<PrizeFamily, readonly [number, number, number]>> = {
  watch: [0.0382, 0.0105, 0.0868],
  perfume: [0.034, 0.0215, 0.065],
  cufflinks: [0.052, 0.0119, 0.034],
  carKeys: [0.033, 0.0099, 0.0938],
};

export function isPrizeFamily(value: string): value is PrizeFamily {
  return (PRIZE_FAMILIES as readonly string[]).includes(value);
}

export function isPrizeRarity(value: string): value is PrizeRarity {
  return (PRIZE_RARITIES as readonly string[]).includes(value);
}
