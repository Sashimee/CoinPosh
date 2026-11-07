import { describe, expect, it } from 'vitest';
import { paletteCssVariables, rivieraTokens } from '../scene/venues/riviera/palette.ts';
import { hexToRgbChannels, rivieraThemeVariables, themeVariables } from './theme.ts';

describe('theme', () => {
  it('converts hex to space-separated channels', () => {
    expect(hexToRgbChannels('#0a1b2C')).toBe('10 27 44');
    expect(hexToRgbChannels('#ffffff')).toBe('255 255 255');
  });

  it('rejects colors that are not #RRGGBB', () => {
    expect(() => hexToRgbChannels('#fff')).toThrow(RangeError);
    expect(() => hexToRgbChannels('red')).toThrow(RangeError);
    expect(() => hexToRgbChannels('#12345g')).toThrow(RangeError);
  });

  it('emits a hex and an rgb variable for every token', () => {
    expect(themeVariables({ gold: '#c9a227' })).toEqual({
      '--cp-gold': '#c9a227',
      '--cp-gold-rgb': '201 162 39',
    });
  });

  it('tints the Riviera theme from every palette token', () => {
    const variables = rivieraThemeVariables();
    for (const [name, value] of Object.entries(paletteCssVariables())) {
      expect(variables[name]).toBe(value);
    }
    for (const token of Object.keys(rivieraTokens)) {
      expect(variables[`--cp-${token}-rgb`]).toMatch(/^\d+ \d+ \d+$/);
    }
  });
});
