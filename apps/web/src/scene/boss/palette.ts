import type { BossKind } from '@coinposh/shared';
import { rivieraTokens, rivieraTones } from '../venues/riviera/palette.ts';

/**
 * Each figure's tailoring, as scene-only shades derived from the Riviera tokens (03-ART): the
 * Tax Inspector in navy pinstripe with a cold sea-glass backlight, the rival tycoon in a velvet
 * smoking jacket deepened from coral sunset with a warm one. Both share the ivory porcelain and
 * the brushed gold.
 */
export interface BossLook {
  /** Suit cloth, its velvet sheen, and the pinstripe woven into it (0 for none). */
  readonly cloth: string;
  readonly clothSheen: string;
  readonly pinstripe: number;
  /** Lapels and tie. */
  readonly satin: string;
  readonly shirt: string;
  readonly porcelain: string;
  /** Moustache, brows and sideburns. */
  readonly hair: string;
  readonly hat: string;
  readonly leather: string;
  /** The backlight and rim flare when a cascade lands. */
  readonly halo: string;
}

export const BOSS_LOOKS: Readonly<Record<BossKind, BossLook>> = {
  taxInspector: {
    cloth: '#141B2A',
    clothSheen: '#4A5C7E',
    pinstripe: 0.55,
    satin: rivieraTokens['navy-lacquer'],
    shirt: rivieraTokens.ivory,
    porcelain: '#F4E9D8',
    hair: '#2B2119',
    hat: '#07080C',
    leather: '#1B2F52',
    halo: rivieraTokens['sea-glass'],
  },
  rivalTycoon: {
    cloth: '#5A1A12',
    clothSheen: rivieraTokens['coral-sunset'],
    pinstripe: 0,
    satin: '#08090D',
    shirt: rivieraTokens.ivory,
    porcelain: '#F6E8D4',
    hair: '#ECE6DA',
    hat: '#07080C',
    leather: rivieraTokens['navy-lacquer'],
    halo: rivieraTokens['coral-sunset'],
  },
};

export const BOSS_GOLD = rivieraTokens['gold-brushed'];
export const BOSS_PAPER = rivieraTokens.champagne;
/** The sunset sits astern, behind the figures, so their rims burn warm. */
export const BOSS_RIM = rivieraTones.rimWarm;
export const BOSS_LENS_GLINT = rivieraTones.sun;
