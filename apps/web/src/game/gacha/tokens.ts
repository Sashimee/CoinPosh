import { rivieraTokens } from '../../scene/venues/riviera/palette.ts';

/** The sheet's lacquer: the card and the backdrop behind it are both navy lacquer. */
export const GACHA_CARD_BED = rivieraTokens['navy-lacquer'];

/** Navy lacquer lifted by scaling its channels, which keeps its hue so it follows the venue. */
function liftLacquer(hex: string, gain: number): string {
  const channels = [1, 3, 5].map((at) =>
    Math.min(255, Math.round(Number.parseInt(hex.slice(at, at + 2), 16) * gain)),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

/**
 * The locked Pull plaque. Solid colours, never opacity, so its text holds WCAG AA (4.5:1) on any
 * frame of the scene behind the sheet.
 */
export const LOCKED_PULL = {
  ink: rivieraTokens.champagne,
  bed: liftLacquer(rivieraTokens['navy-lacquer'], 1.6),
  edge: rivieraTokens['gold-brushed'],
} as const;

export const LOCKED_PULL_VARIABLES: Readonly<Record<string, string>> = {
  '--cp-gacha-locked-ink': LOCKED_PULL.ink,
  '--cp-gacha-locked-bed': LOCKED_PULL.bed,
  '--cp-gacha-locked-edge': LOCKED_PULL.edge,
};
