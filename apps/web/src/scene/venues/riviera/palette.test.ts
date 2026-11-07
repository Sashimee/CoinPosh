import { describe, expect, it } from 'vitest';
import artBible from '../../../../../../docs/plan/03-ART-AUDIO-JUICE.md?raw';
import { paletteCssVariables, rivieraTokens, rivieraTones } from './palette.ts';

function biblePalette(): Record<string, string> {
  const section = artBible.split('### Riviera Yacht palette')[1]?.split('###')[0];
  if (!section) throw new Error('03-ART-AUDIO-JUICE.md has no "Riviera Yacht palette" section');
  const rows = [...section.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|/gm)];
  return Object.fromEntries(rows.map(([, token = '', hex = '']) => [token, hex.toUpperCase()]));
}

describe('Riviera palette', () => {
  it('matches the art bible token table exactly', () => {
    const bible = biblePalette();
    expect(Object.keys(bible)).toHaveLength(7);
    expect(rivieraTokens).toEqual(bible);
  });

  it('uses six-digit hex colours for every token and tone', () => {
    for (const hex of [...Object.values(rivieraTokens), ...Object.values(rivieraTones)]) {
      expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('exposes every token as a CSS custom property for the HUD', () => {
    expect(paletteCssVariables()).toEqual({
      '--cp-navy-lacquer': '#0E1F3A',
      '--cp-teak': '#C9A27A',
      '--cp-gold-brushed': '#D4AF37',
      '--cp-champagne': '#F3E5C0',
      '--cp-coral-sunset': '#FF7A59',
      '--cp-sea-glass': '#7FD1C7',
      '--cp-ivory': '#FFF8EC',
    });
    expect(Object.keys(paletteCssVariables('--venue'))).toContain('--venue-teak');
  });
});
