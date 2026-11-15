import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, type ResourceTree } from '../../i18n/index.ts';
import { hexToRgbChannels } from '../../ui/theme.ts';
import { GACHA_STRINGS } from './i18n.ts';
import { pullAction, pullPrompt, unlockCue } from './plan.ts';
import { rivieraTokens } from '../../scene/venues/riviera/palette.ts';
import { GACHA_CARD_BED, LOCKED_PULL, LOCKED_PULL_VARIABLES } from './tokens.ts';

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = hexToRgbChannels(hex)
    .split(' ')
    .map((value) => {
      const c = Number(value) / 255;
      return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function leafTexts(tree: ResourceTree): string[] {
  return Object.values(tree).flatMap((value) =>
    typeof value === 'string' ? [value] : leafTexts(value),
  );
}

const css = readFileSync(new URL('./gacha.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`test: gacha.css has no rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('gacha locked Pull', () => {
  it('explains a Pull locked for want of a Ticket while the machine is idle', () => {
    expect(pullPrompt(pullAction(0, false), false)).toEqual({
      locked: true,
      reason: 'needTickets',
      sources: 'ticketSources',
    });
  });

  it('stays locked but quiet while a prize card is showing', () => {
    expect(pullPrompt(pullAction(0, false), true)).toEqual({
      locked: true,
      reason: null,
      sources: null,
    });
  });

  it('says nothing when Pull is open, busy or still syncing', () => {
    for (const action of [pullAction(1, false), pullAction(null, false), pullAction(2, true)]) {
      expect(pullPrompt(action, false)).toEqual({ locked: false, reason: null, sources: null });
    }
  });

  it('names Vault Crates as the Ticket source in every language', () => {
    const crate = { en: /Vault Crate/, fr: /caisses? du coffre/i, de: /Tresorkiste/ } as const;
    for (const language of LANGUAGES) {
      expect(GACHA_STRINGS[language].needTickets).toMatch(crate[language]);
      expect(GACHA_STRINGS[language].ticketSources).toMatch(crate[language]);
    }
  });

  it('never promises Tickets from quests or streaks, which this build does not mount', () => {
    const unmounted = /quest|streak|quête|série|aufgabe|serie/i;
    for (const language of LANGUAGES) {
      for (const text of leafTexts(GACHA_STRINGS[language])) expect(text).not.toMatch(unmounted);
    }
  });

  it('plays the unlock glint only on the render Pull goes from locked to open', () => {
    const open = pullAction(1, false);
    expect(unlockCue(true, pullPrompt(open, false), open, false, false)).toBe('play');
    expect(unlockCue(false, pullPrompt(open, false), open, false, false)).toBe('keep');
    expect(unlockCue(null, pullPrompt(open, false), open, false, false)).toBe('keep');
    expect(unlockCue(true, pullPrompt(open, false), open, false, true)).toBe('keep');
    const busy = pullAction(1, true);
    expect(unlockCue(true, pullPrompt(busy, false), busy, false, false)).toBe('keep');
  });

  it('clears the unlock glint once Collect brings back a Pull that is locked again', () => {
    const spent = pullAction(0, false);
    expect(unlockCue(false, pullPrompt(spent, false), spent, false, false)).toBe('clear');
    expect(unlockCue(true, pullPrompt(spent, false), spent, false, false)).toBe('clear');
  });

  it('clears the unlock glint while Pull is hidden behind a prize card', () => {
    const open = pullAction(3, false);
    expect(unlockCue(true, pullPrompt(open, true), open, true, false)).toBe('clear');
    expect(unlockCue(false, pullPrompt(open, true), open, true, false)).toBe('clear');
  });

  it('never draws the unlock glint or pop over a locked plaque', () => {
    expect(css).not.toMatch(/\.cp-gacha-pull\.is-unlocked(?!:not\(\.is-locked\))/);
    rule('.cp-gacha-pull.is-unlocked:not(.is-locked)::after');
    rule('.cp-gacha-pull.is-unlocked:not(.is-locked)');
  });

  it('derives the plaque bed from navy lacquer, keeping its hue', () => {
    const [r = 0, g = 0, b = 0] = hexToRgbChannels(LOCKED_PULL.bed).split(' ').map(Number);
    const [nr = 0, ng = 0, nb = 0] = hexToRgbChannels(rivieraTokens['navy-lacquer'])
      .split(' ')
      .map(Number);
    expect(luminance(LOCKED_PULL.bed)).toBeGreaterThan(luminance(GACHA_CARD_BED));
    expect(r / nr).toBeCloseTo(b / nb, 1);
    expect(g / ng).toBeCloseTo(b / nb, 1);
  });

  it('keeps the locked label and its reason at 4.5:1 or better', () => {
    expect(contrast(LOCKED_PULL.ink, LOCKED_PULL.bed)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(LOCKED_PULL.ink, GACHA_CARD_BED)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(LOCKED_PULL.edge, LOCKED_PULL.bed)).toBeGreaterThanOrEqual(3);
  });

  it('paints the locked plaque and its reason from those tokens, never through opacity', () => {
    const locked = rule(".cp-gacha .cp-gacha-pull[aria-disabled='true']");
    expect(locked).toContain('background: var(--cp-gacha-locked-bed)');
    expect(locked).toContain('color: var(--cp-gacha-locked-ink)');
    for (const selector of ['.cp-gacha-hint', '.cp-gacha-sources']) {
      expect(rule(selector)).toContain('color: var(--cp-gacha-locked-ink)');
    }
    expect(css).not.toMatch(/cp-gacha-(pull|hint|sources)[^{]*\{[^}]*opacity/);
    for (const name of Object.keys(LOCKED_PULL_VARIABLES)) expect(css).toContain(`var(${name})`);
  });
});
