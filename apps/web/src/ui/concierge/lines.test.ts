import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONCIERGE_LINE_IDS,
  CONCIERGE_LINE_VARIANTS,
  CONCIERGE_LINES,
  type ConciergeLineId,
  type ConciergeParams,
} from '../../game/concierge/index.ts';
import {
  BUNDLED_RESOURCES,
  createI18n,
  LANGUAGES,
  type I18n,
  type Language,
} from '../../i18n/index.ts';
import de from '../../i18n/locales/de/concierge.json';
import en from '../../i18n/locales/en/concierge.json';
import fr from '../../i18n/locales/fr/concierge.json';
import { loadConciergeStrings } from './i18n.ts';
import { CONCIERGE_PLACEHOLDERS, LINE_PLACEHOLDERS, lineText } from './present.ts';

interface Tree {
  readonly [key: string]: string | Tree;
}

const FILES: Readonly<Record<Language, Tree>> = { en, fr, de };
const UI_BRANCHES = new Set(['card', 'names']);

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = `${prefix}${key}`;
    if (typeof value === 'string') out.set(path, value);
    else for (const [leaf, text] of leaves(value, `${path}.`)) out.set(leaf, text);
  }
  return out;
}

function lineLeaves(language: Language): Map<string, string> {
  const all = leaves(FILES[language]);
  for (const key of [...all.keys()]) {
    if (UI_BRANCHES.has(key.split('.')[0] ?? '')) all.delete(key);
  }
  return all;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1] ?? '');
}

/** Params of the shape each rule sends, so every variant renders as the player would see it. */
const SAMPLE: Readonly<Record<ConciergeLineId, ConciergeParams>> = {
  'greeting.firstCascade': {},
  'cascade.chic': { count: 12 },
  'cascade.lavish': { count: 24 },
  'cascade.opulent': { count: 48 },
  'cascade.decadent': { count: 96 },
  'cascade.obscene': { count: 180 },
  'fusion.first': { tier: 'silver' },
  'fusion.minor': { tier: 'gold' },
  'fusion.platinum': { tier: 'platinum' },
  'fusion.diamond': { tier: 'diamond' },
  'fusion.heirloom': { tier: 'heirloom' },
  'pour.perfect': {},
  'decorum.warning': {},
  'decorum.freeze': { seconds: 6 },
  'decorum.stillFrozen': {},
  'tip.aimCentre': {},
  'crate.arrived': {},
  'reward.modest': { rarity: 'fine' },
  'reward.rare': { rarity: 'exquisite' },
  'reward.legendary': { rarity: 'legendary' },
  'vault.empty': {},
  'vault.welcomeBack': { coins: 1240 },
  'vault.capped': { coins: 5000 },
  'tip.upgradeAffordable': { upgrade: 'dropRate' },
  'upgrade.purchased': { upgrade: 'vaultCapacity', level: 3 },
  'tip.feedTower': {},
  'tower.wobbling': {},
  'tip.idle': {},
  'ascension.arrived': { venue: 'rivieraYacht' },
};

/** The personality guide's reading budget: a remark is a glance, a tip a short sentence. */
const MAX_CHARS = { remark: 90, tip: 140 } as const;

describe('Concierge copy', () => {
  it.each(LANGUAGES)('covers every brain line id with all five variants in %s', (language) => {
    const lines = lineLeaves(language);
    for (const lineId of CONCIERGE_LINE_IDS) {
      for (let variant = 0; variant < CONCIERGE_LINE_VARIANTS; variant += 1) {
        const text = lines.get(`${lineId}.${String(variant)}`);
        expect(text, `${language} ${lineId}.${String(variant)}`).toBeTypeOf('string');
        expect(text?.trim(), `${language} ${lineId}.${String(variant)}`).not.toBe('');
      }
    }
    expect(lines.size).toBe(CONCIERGE_LINE_IDS.length * CONCIERGE_LINE_VARIANTS);
    expect(lines.size).toBeGreaterThanOrEqual(120);
  });

  it.each(LANGUAGES)('has no line keys the brain cannot say in %s', (language) => {
    const known = new Set(
      CONCIERGE_LINE_IDS.flatMap((lineId) =>
        Array.from({ length: CONCIERGE_LINE_VARIANTS }, (_, v) => `${lineId}.${String(v)}`),
      ),
    );
    const stray = [...lineLeaves(language).keys()].filter((key) => !known.has(key));
    expect(stray).toEqual([]);
  });

  it('declares placeholders for exactly the brain line ids', () => {
    expect(Object.keys(LINE_PLACEHOLDERS).sort()).toEqual([...CONCIERGE_LINE_IDS].sort());
  });

  it.each(LANGUAGES)('only interpolates what each line is sent in %s', (language) => {
    for (const [key, text] of lineLeaves(language)) {
      const lineId = key.slice(0, key.lastIndexOf('.')) as ConciergeLineId;
      const allowed: readonly string[] = LINE_PLACEHOLDERS[lineId];
      for (const name of placeholders(text)) {
        expect(CONCIERGE_PLACEHOLDERS as readonly string[], `${language} ${key}`).toContain(name);
        expect(allowed, `${language} ${key} uses {{${name}}}`).toContain(name);
      }
    }
  });

  it('keeps the same placeholders in every language, variant by variant', () => {
    const english = lineLeaves('en');
    for (const language of LANGUAGES) {
      for (const [key, text] of lineLeaves(language)) {
        expect(placeholders(text).sort(), `${language} ${key}`).toEqual(
          placeholders(english.get(key) ?? '').sort(),
        );
      }
    }
  });
});

describe('Concierge lines as rendered', () => {
  const instances = new Map<Language, I18n>();

  beforeAll(async () => {
    for (const language of LANGUAGES) {
      const i18n = createI18n({ language, resources: BUNDLED_RESOURCES });
      await loadConciergeStrings(i18n);
      instances.set(language, i18n);
    }
  });

  it.each(LANGUAGES)('renders every variant whole and within budget in %s', (language) => {
    const i18n = instances.get(language);
    if (i18n === undefined) throw new Error(`no i18n for ${language}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (const lineId of CONCIERGE_LINE_IDS) {
        const { kind } = CONCIERGE_LINES[lineId];
        for (let variant = 0; variant < CONCIERGE_LINE_VARIANTS; variant += 1) {
          const label = `${language} ${lineId}.${String(variant)}`;
          const text = lineText(i18n, { lineId, variant, params: SAMPLE[lineId] });
          expect(text, label).not.toMatch(/\{\{|\}\}|concierge:/);
          expect(text.length, `${label}: "${text}"`).toBeLessThanOrEqual(MAX_CHARS[kind]);
        }
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
