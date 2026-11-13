// Tier ids mirror 02-ECONOMY.md. They belong in packages/shared once T-0.05 publishes the
// coin tier type; until then this list is the render-side source and carries no economy data.
export const COIN_TIER_IDS = [
  'copper',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'heirloom',
] as const;

export type CoinTierId = (typeof COIN_TIER_IDS)[number];

export interface CoinFaceDesign {
  readonly laurelLeaves: number;
  readonly berries: boolean;
  readonly beads: number;
  readonly stars: number;
  readonly gem: boolean;
  readonly guilloche: number;
}

export interface CoinLook {
  readonly metal: string;
  readonly recess: string;
  readonly roughness: number;
  readonly reliefRoughness: number;
  readonly edgeRoughness: number;
  readonly anisotropy: number;
  readonly turningRings: number;
  readonly clearcoat: number;
  readonly clearcoatRoughness: number;
  readonly iridescence: number;
  readonly sparkle: number;
  readonly prismatic: boolean;
  /** Scene-linear luminance a highlight eases towards; see `compressHighlight` in materials.ts. */
  readonly highlightCeiling: number;
  readonly face: CoinFaceDesign;
}

export const COIN_LOOKS: Readonly<Record<CoinTierId, CoinLook>> = {
  copper: {
    metal: '#D9825B',
    recess: '#3A1A10',
    roughness: 0.26,
    reliefRoughness: 0.48,
    edgeRoughness: 0.3,
    anisotropy: 0.55,
    turningRings: 0.06,
    clearcoat: 0,
    clearcoatRoughness: 0.2,
    iridescence: 0,
    sparkle: 0,
    prismatic: false,
    highlightCeiling: 1.6,
    face: { laurelLeaves: 6, berries: false, beads: 0, stars: 1, gem: false, guilloche: 0 },
  },
  silver: {
    metal: '#D9D9DA',
    recess: '#1C1F26',
    roughness: 0.2,
    reliefRoughness: 0.42,
    edgeRoughness: 0.24,
    anisotropy: 0.65,
    turningRings: 0.05,
    clearcoat: 0,
    clearcoatRoughness: 0.2,
    iridescence: 0,
    sparkle: 0,
    prismatic: false,
    highlightCeiling: 1.4,
    face: { laurelLeaves: 7, berries: false, beads: 60, stars: 2, gem: false, guilloche: 0 },
  },
  gold: {
    metal: '#D4AF37',
    recess: '#4A2C08',
    roughness: 0.17,
    reliefRoughness: 0.4,
    edgeRoughness: 0.2,
    anisotropy: 0.7,
    turningRings: 0.05,
    clearcoat: 0.35,
    clearcoatRoughness: 0.08,
    iridescence: 0,
    sparkle: 0,
    prismatic: false,
    highlightCeiling: 1.8,
    face: { laurelLeaves: 8, berries: true, beads: 64, stars: 3, gem: false, guilloche: 0 },
  },
  platinum: {
    metal: '#D6D8DC',
    recess: '#1C1F26',
    roughness: 0.22,
    reliefRoughness: 0.36,
    edgeRoughness: 0.26,
    anisotropy: 0.85,
    turningRings: 0.07,
    clearcoat: 0.2,
    clearcoatRoughness: 0.1,
    iridescence: 0,
    sparkle: 0,
    prismatic: false,
    highlightCeiling: 1.8,
    face: { laurelLeaves: 9, berries: true, beads: 72, stars: 4, gem: false, guilloche: 0.6 },
  },
  diamond: {
    metal: '#CCE3F6',
    recess: '#1A2A44',
    roughness: 0.12,
    reliefRoughness: 0.3,
    edgeRoughness: 0.16,
    anisotropy: 0.5,
    turningRings: 0.03,
    clearcoat: 0.6,
    clearcoatRoughness: 0.04,
    iridescence: 0.35,
    sparkle: 1,
    prismatic: false,
    highlightCeiling: 3.2,
    face: { laurelLeaves: 9, berries: true, beads: 80, stars: 5, gem: false, guilloche: 1 },
  },
  heirloom: {
    metal: '#F3E5C0',
    recess: '#2A1840',
    roughness: 0.16,
    reliefRoughness: 0.3,
    edgeRoughness: 0.16,
    anisotropy: 0.3,
    turningRings: 0.02,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    iridescence: 0.55,
    sparkle: 0.6,
    prismatic: true,
    highlightCeiling: 3.2,
    face: { laurelLeaves: 10, berries: true, beads: 80, stars: 0, gem: true, guilloche: 1 },
  },
};

export function isCoinTierId(value: string): value is CoinTierId {
  return (COIN_TIER_IDS as readonly string[]).includes(value);
}
