import { readFileSync } from 'node:fs';
import { upgradeLines } from '@coinposh/economy';
import { describe, expect, it } from 'vitest';
import { upgradeRow } from '../../app/model.ts';
import { BUNDLED_RESOURCES, createI18n, LANGUAGES } from '../../i18n/index.ts';
import { fitScale, upgradeRowCopy, type UpgradeRowCopy } from './upgradesPanel.ts';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function declarations(selector: string): Record<string, string> {
  const merged: Record<string, string> = {};
  let found = false;
  for (const [, selectors = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((part) => part.trim() === selector)) continue;
    found = true;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      merged[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  if (!found) throw new Error(`styles.css has no rule for "${selector}"`);
  return merged;
}

function px(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value ?? '');
  if (!match) throw new Error(`expected a fixed px length, got "${value}"`);
  return Number(match[1]);
}

/** Tracks at the top level of a grid template, so `minmax(0, 1fr)` stays one track. */
function tracks(template: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of template) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ' ' && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Measured in Chromium: the widest stat line, "10 Std. → 11 Std.", sets 17 glyphs in 115 px. */
const PX_PER_CHAR_12PX_SEMIBOLD = 7;
/** The text column of a row on a 360 px phone, the narrowest supported viewport, as measured. */
const TEXT_COLUMN_AT_360_PX = 132;

function everyRowCopy(): { where: string; copy: UpgradeRowCopy; maxed: boolean }[] {
  const out: { where: string; copy: UpgradeRowCopy; maxed: boolean }[] = [];
  for (const language of LANGUAGES) {
    const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
    const t = i18n.t.bind(i18n);
    for (const line of upgradeLines) {
      for (let level = 0; level <= line.maxLevel; level++) {
        const view = upgradeRow(line, level, { coins: 0, goldBars: 0 });
        for (const pending of [false, true]) {
          out.push({
            where: `${language} ${line.id} level ${level}${pending ? ' pending' : ''}`,
            copy: upgradeRowCopy(t, view, language, pending),
            maxed: view.maxed,
          });
        }
      }
    }
  }
  return out;
}

describe('upgrade row layout', () => {
  it('gives the text column a width no purchase can change', () => {
    const row = declarations('.cp-upgrade');
    const columns = tracks(row['grid-template-columns'] ?? '');
    expect(columns).toEqual(['40px', 'minmax(0, 1fr)', 'var(--cp-upgrade-buy-width)']);
    expect(px(row['--cp-upgrade-buy-width'])).toBeGreaterThanOrEqual(86);
    const buy = declarations('.cp-upgrade > .cp-buy');
    expect(buy.width).toBe('100%');
    expect(buy['min-width']).toBe('0');
  });

  it('lays the stat line and the level meter on two fixed rows that never wrap', () => {
    const meta = declarations('.cp-upgrade-meta');
    expect(meta.display).toBe('grid');
    expect(meta['flex-wrap']).toBeUndefined();
    expect(tracks(meta['grid-template-columns'] ?? '')).toEqual(['minmax(0, 1fr)']);
    const [statRow, meterRow, ...extra] = tracks(meta['grid-template-rows'] ?? '').map(px);
    expect(extra).toEqual([]);

    const effect = declarations('.cp-upgrade-effect');
    expect(effect['white-space']).toBe('nowrap');
    expect(effect.overflow).toBe('hidden');
    expect(px(effect['line-height'])).toBe(statRow);

    const meter = declarations('.cp-upgrade-progress');
    expect(meter['white-space']).toBe('nowrap');
    expect(meter.overflow).toBe('hidden');
    expect(px(meter.height)).toBe(meterRow);
    expect(px(meter['line-height'])).toBe(meterRow);
    expect(declarations('.cp-upgrade-level').flex).toBe('none');
    expect(declarations('.cp-level-bar').flex).toBe('none');
  });

  it('keeps the buy label and price on one line inside the fixed column', () => {
    expect(declarations('.cp-upgrade .cp-buy-label')['white-space']).toBe('nowrap');
    expect(declarations('.cp-upgrade .cp-buy-cost')['white-space']).toBe('nowrap');
  });

  it('sizes the level text for three-digit levels so the meter never slides', () => {
    const longest = Math.max(...everyRowCopy().map(({ copy }) => copy.level.length));
    const reserved = Number(
      /^(\d+(?:\.\d+)?)ch$/.exec(declarations('.cp-upgrade-level')['min-width'] ?? '')?.[1],
    );
    expect(reserved).toBeGreaterThanOrEqual(longest - 0.5);
  });
});

describe('fitScale', () => {
  it('leaves a part that fits at full size', () => {
    expect(fitScale(64, 92)).toBe(1);
    expect(fitScale(92, 92)).toBe(1);
  });

  it('shrinks a part that outgrows the column to exactly fill it', () => {
    expect(fitScale(113, 92)).toBeCloseTo(92 / 113, 10);
    expect(fitScale(113, 92) * 113).toBeCloseTo(92, 10);
  });

  it('leaves a part alone while it or its button is not laid out', () => {
    expect(fitScale(0, 92)).toBe(1);
    expect(fitScale(113, 0)).toBe(1);
    expect(fitScale(113, -12)).toBe(1);
    expect(fitScale(113, Number.NaN)).toBe(1);
  });
});

describe('upgradeRowCopy', () => {
  const rows = everyRowCopy();

  it('covers every level from 0 to max of every line in EN, FR and DE', () => {
    const levels = upgradeLines.reduce((sum, line) => sum + line.maxLevel + 1, 0);
    expect(rows).toHaveLength(levels * LANGUAGES.length * 2);
  });

  it('writes single-line copy that fits the fixed stat column at every level', () => {
    for (const { where, copy } of rows) {
      for (const text of [copy.effect, copy.level, copy.buyLabel, copy.price]) {
        expect(text, where).not.toMatch(/[\n\r]/);
      }
      expect(copy.effect, where).not.toBe('');
      expect(copy.effect.length * PX_PER_CHAR_12PX_SEMIBOLD, where).toBeLessThanOrEqual(
        TEXT_COLUMN_AT_360_PX,
      );
    }
  });

  it('always has a buy label', () => {
    for (const { where, copy } of rows) expect(copy.buyLabel, where).not.toBe('');
  });

  it('shows a price until the line is maxed, then none', () => {
    for (const { where, copy, maxed } of rows) {
      if (maxed) expect(copy.price, where).toBe('');
      else expect(copy.price, where).toMatch(/\d/);
    }
  });

  it('formats the stat line with the next level, and the final value once maxed', () => {
    const i18n = createI18n({ language: 'en', resources: BUNDLED_RESOURCES });
    const t = i18n.t.bind(i18n);
    const line = upgradeLines.find((candidate) => candidate.id === 'pusherSpeed');
    if (!line) throw new Error('economy has no pusherSpeed line');
    const first = upgradeRow(line, 1, { coins: 0, goldBars: 0 });
    expect(upgradeRowCopy(t, first, 'en', false)).toEqual({
      effect: '×1.06 → ×1.12',
      level: 'Lv 1',
      buyLabel: 'Buy',
      price: String(first.cost),
    });
    expect(upgradeRowCopy(t, first, 'en', true).buyLabel).toBe('Confirming…');
    const maxed = upgradeRow(line, line.maxLevel, { coins: 0, goldBars: 0 });
    expect(upgradeRowCopy(t, maxed, 'en', true)).toEqual({
      effect: '×4',
      level: `Lv ${line.maxLevel}`,
      buyLabel: 'Maxed',
      price: '',
    });
  });
});
