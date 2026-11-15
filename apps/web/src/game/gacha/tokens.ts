import { rivieraTokens } from '../../scene/venues/riviera/palette.ts';

/** The sheet's lacquer: the card and the backdrop behind it are both navy lacquer. */
export const GACHA_CARD_BED = rivieraTokens['navy-lacquer'];

/**
 * The locked Pull plaque. Solid colours, never opacity, so its text holds WCAG AA (4.5:1) on any
 * frame of the scene behind the sheet.
 */
export const LOCKED_PULL = {
  ink: rivieraTokens.champagne,
  bed: '#1B3058',
  edge: rivieraTokens['gold-brushed'],
} as const;

export const LOCKED_PULL_VARIABLES: Readonly<Record<string, string>> = {
  '--cp-gacha-locked-ink': LOCKED_PULL.ink,
  '--cp-gacha-locked-bed': LOCKED_PULL.bed,
  '--cp-gacha-locked-edge': LOCKED_PULL.edge,
};
