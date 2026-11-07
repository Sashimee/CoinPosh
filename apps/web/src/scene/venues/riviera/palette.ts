/**
 * Riviera Yacht palette. `tokens` are the art bible's table (03-ART-AUDIO-JUICE.md) verbatim;
 * the HUD reads them through `paletteCssVariables`. `tones` are scene-only shades derived from
 * the tokens for materials, sky and sea, and never appear in UI.
 */
export const rivieraTokens = {
  'navy-lacquer': '#0E1F3A',
  teak: '#C9A27A',
  'gold-brushed': '#D4AF37',
  champagne: '#F3E5C0',
  'coral-sunset': '#FF7A59',
  'sea-glass': '#7FD1C7',
  ivory: '#FFF8EC',
} as const;

export type RivieraToken = keyof typeof rivieraTokens;

export const rivieraTones = {
  teakDark: '#7E4A22',
  teakLight: '#E0BC8A',
  holly: '#CDB88E',
  caulk: '#16130F',
  velvet: '#0A1730',
  chrome: '#E9EAEE',
  skyZenith: '#141C44',
  skyUpper: '#3B3770',
  skyRose: '#B65F7E',
  skyHorizon: '#FF8F62',
  skyHaze: '#FFD7A3',
  sun: '#FFF1D2',
  cloudShadow: '#4A3A63',
  seaDeep: '#06182A',
  seaShallow: '#1D5F68',
  keyLight: '#FFF1E0',
  rimWarm: '#FFC48E',
  rimCool: '#9FE3DA',
} as const;

export type RivieraTone = keyof typeof rivieraTones;

export function paletteCssVariables(prefix = '--cp'): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rivieraTokens).map(([token, hex]) => [`${prefix}-${token}`, hex]),
  );
}
