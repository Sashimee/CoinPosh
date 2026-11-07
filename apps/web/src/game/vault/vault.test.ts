import { OfflineSettlementSchema } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createI18n, LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import { Avalanche, avalancheHash, type AvalancheImpact } from './avalanche.ts';
import { countUpValue, TickThrottle } from './countUp.ts';
import { registerVaultStrings, VAULT_STRINGS, vaultKey } from './i18n.ts';
import {
  AVALANCHE_MAX_COINS,
  AVALANCHE_MIN_COINS,
  avalancheCoinCount,
  FULL_TIMELINE,
  REDUCED_TIMELINE,
  vaultReturnFrom,
  vaultTimeline,
} from './plan.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function settlement(awayMs: number, creditedMs: number, coins: number) {
  return OfflineSettlementSchema.parse({ awayMs, creditedMs, coins });
}

function pour(seed: number, count = 40): Avalanche {
  return new Avalanche({ width: 300, height: 168, count, seed });
}

describe('vaultReturnFrom', () => {
  it('skips the screen when the server settled nothing', () => {
    expect(vaultReturnFrom(null)).toBeNull();
    expect(vaultReturnFrom(settlement(3 * HOUR, 3 * HOUR, 0))).toBeNull();
  });

  it('reads away and credited time straight off the settlement', () => {
    const view = vaultReturnFrom(settlement(9 * HOUR + 41 * MINUTE + 59_000, 2 * HOUR, 840));
    expect(view).toEqual({
      awayMs: 9 * HOUR + 41 * MINUTE + 59_000,
      creditedMs: 2 * HOUR,
      coins: 840,
      capped: true,
      away: { hours: 9, minutes: 41 },
      credited: { hours: 2, minutes: 0 },
    });
  });

  it('is not capped when every minute away was credited', () => {
    expect(vaultReturnFrom(settlement(47 * MINUTE, 47 * MINUTE, 12))?.capped).toBe(false);
  });

  it('refuses a settlement that credits more time than the player was away', () => {
    expect(() => vaultReturnFrom(settlement(HOUR, 2 * HOUR, 5))).toThrow(/clamp/);
  });
});

describe('vault timeline', () => {
  it('opens, pours, counts and offers Collect within about two seconds', () => {
    const t = vaultTimeline(false);
    expect(t).toBe(FULL_TIMELINE);
    expect(t.avalancheAtMs).toBeLessThan(t.doorMs);
    expect(t.countAtMs).toBeLessThanOrEqual(t.doorMs);
    expect(t.countAtMs + t.countMs).toBeLessThanOrEqual(t.collectAtMs);
    expect(t.collectAtMs).toBeLessThanOrEqual(2_200);
  });

  it('shows the end state at once with reduced motion', () => {
    expect(vaultTimeline(true)).toBe(REDUCED_TIMELINE);
    expect(Object.values(REDUCED_TIMELINE).every((ms) => ms === 0)).toBe(true);
  });
});

describe('avalancheCoinCount', () => {
  it('grows with the haul on a log scale, clamped for readability and frame time', () => {
    expect(avalancheCoinCount(0)).toBe(0);
    expect(avalancheCoinCount(Number.NaN)).toBe(0);
    expect(avalancheCoinCount(1)).toBe(AVALANCHE_MIN_COINS);
    expect(avalancheCoinCount(100)).toBeGreaterThan(avalancheCoinCount(10));
    expect(avalancheCoinCount(1e12)).toBe(AVALANCHE_MAX_COINS);
  });
});

describe('Avalanche', () => {
  it('lands the same heap for the same seed and a different one for another seed', () => {
    const a = pour(7);
    const b = pour(7);
    const c = pour(8);
    a.settle();
    b.settle();
    c.settle();
    expect(avalancheHash(a)).toBe(avalancheHash(b));
    expect(avalancheHash(a)).not.toBe(avalancheHash(c));
  });

  it('does not depend on frame timing: one big step equals the same time in small ones', () => {
    const whole = pour(21);
    const chunked = pour(21);
    whole.step(1);
    for (let i = 0; i < 4; i++) chunked.step(0.25);
    expect(avalancheHash(chunked)).toBe(avalancheHash(whole));
  });

  it('pours over time, clinks on the way down and comes to rest inside the chamber', () => {
    const avalanche = pour(3, 60);
    const impacts: AvalancheImpact[] = [];
    impacts.push(...avalanche.step(0.05));
    expect(avalanche.coins.some((coin) => !coin.released)).toBe(true);
    for (let i = 0; i < 400 && !avalanche.settled; i++) impacts.push(...avalanche.step(1 / 60));
    expect(avalanche.settled).toBe(true);
    expect(impacts.length).toBeGreaterThan(0);
    for (const impact of impacts) {
      expect(impact.velocity).toBeGreaterThan(0);
      expect(impact.velocity).toBeLessThanOrEqual(1.5);
      expect(Math.abs(impact.pan)).toBeLessThanOrEqual(1);
    }
    for (const coin of avalanche.coins) {
      expect(coin.x).toBeGreaterThanOrEqual(coin.radius - 1e-9);
      expect(coin.x).toBeLessThanOrEqual(avalanche.width - coin.radius + 1e-9);
      expect(coin.y).toBeLessThanOrEqual(avalanche.height);
      expect(coin.y).toBeGreaterThan(0);
    }
  });

  it('spreads into a heap rather than a single tower', () => {
    const avalanche = pour(11, 80);
    avalanche.settle();
    const xs = avalanche.coins.map((coin) => coin.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(avalanche.width * 0.4);
  });

  it('settle() is the reduced-motion pile: everything at rest, matching a played-out pour', () => {
    const played = pour(5);
    for (let i = 0; i < 2_000 && !played.settled; i++) played.step(1 / 120);
    const settled = pour(5);
    settled.settle();
    expect(settled.settled).toBe(true);
    expect(avalancheHash(settled)).toBe(avalancheHash(played));
  });

  it('handles an empty pour and rejects a broken chamber', () => {
    const empty = pour(1, 0);
    expect(empty.settled).toBe(true);
    expect(empty.step(1)).toEqual([]);
    expect(() => new Avalanche({ width: 0, height: 10, count: 1, seed: 1 })).toThrow(/chamber/);
    expect(() => new Avalanche({ width: 10, height: 10, count: 1.5, seed: 1 })).toThrow(/count/);
  });
});

describe('countUpValue', () => {
  it('starts at zero, never overshoots and lands exactly on the server total', () => {
    expect(countUpValue(840, 0, 1_500)).toBe(0);
    expect(countUpValue(840, 1_500, 1_500)).toBe(840);
    expect(countUpValue(840, 99_999, 1_500)).toBe(840);
    expect(countUpValue(840, 10, 0)).toBe(840);
    let previous = 0;
    for (let ms = 0; ms <= 1_500; ms += 16) {
      const value = countUpValue(840, ms, 1_500);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(840);
      previous = value;
    }
    expect(countUpValue(840, 750, 1_500)).toBeGreaterThan(420);
  });
});

describe('TickThrottle', () => {
  it('lets a tick through only for a new value after the gap', () => {
    const throttle = new TickThrottle(45);
    expect(throttle.accept(0, 1)).toBe(true);
    expect(throttle.accept(20, 2)).toBe(false);
    expect(throttle.accept(45, 2)).toBe(true);
    expect(throttle.accept(200, 2)).toBe(false);
    expect(throttle.accept(201, 3)).toBe(true);
  });
});

describe('vault strings', () => {
  function keys(tree: ResourceTree, prefix = ''): string[] {
    return Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`),
    );
  }

  function placeholders(text: string): string[] {
    return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '').sort();
  }

  it('ship the same keys and placeholders in EN, FR and DE', () => {
    const english = VAULT_STRINGS.en;
    for (const language of LANGUAGES) {
      const strings = VAULT_STRINGS[language];
      expect(keys(strings).sort()).toEqual(keys(english).sort());
      for (const key of keys(english)) {
        const local = strings[key];
        const base = english[key];
        expect(typeof local === 'string' && typeof base === 'string').toBe(true);
        if (typeof local === 'string' && typeof base === 'string') {
          expect(placeholders(local)).toEqual(placeholders(base));
        }
      }
    }
  });

  it('resolve through i18next with interpolation', () => {
    const i18n = createI18n({ language: 'fr', resources: { en: {}, fr: {}, de: {} } });
    registerVaultStrings(i18n);
    expect(i18n.t(vaultKey('away'), { hours: 9, minutes: 41 })).toBe('Absent 9 h 41 min');
    i18n.changeLanguage('de');
    expect(i18n.t(vaultKey('collect'))).toBe('Einsammeln');
  });
});
