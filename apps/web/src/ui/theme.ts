import { paletteCssVariables, rivieraTokens } from '../scene/venues/riviera/palette.ts';

const HEX = /^#([0-9a-f]{6})$/i;

export function hexToRgbChannels(hex: string): string {
  const match = HEX.exec(hex);
  if (!match?.[1]) throw new RangeError(`Palette colors must be #RRGGBB, got "${hex}"`);
  const value = Number.parseInt(match[1], 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

/**
 * CSS custom properties for a venue palette: `--cp-<token>` holds the hex and
 * `--cp-<token>-rgb` the channels, so panels can write `rgb(var(--cp-navy-lacquer-rgb) / 0.7)`.
 */
export function themeVariables(
  tokens: Readonly<Record<string, string>>,
  prefix = '--cp',
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [token, hex] of Object.entries(tokens)) {
    variables[`${prefix}-${token}`] = hex;
    variables[`${prefix}-${token}-rgb`] = hexToRgbChannels(hex);
  }
  return variables;
}

export function rivieraThemeVariables(): Record<string, string> {
  return { ...paletteCssVariables(), ...themeVariables(rivieraTokens) };
}

export function applyTheme(el: HTMLElement, variables: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(variables)) el.style.setProperty(name, value);
}
