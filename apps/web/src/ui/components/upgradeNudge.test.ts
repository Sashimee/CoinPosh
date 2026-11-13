import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import de from '../../i18n/locales/de/ui.json';
import en from '../../i18n/locales/en/ui.json';
import fr from '../../i18n/locales/fr/ui.json';
import { createAnnouncementHold, type AnnouncementHold } from './announcementHold.ts';
import { holdForCrateCinematics, type CinematicEvents } from './cinematicHold.ts';
import { foldNudgeOnCue, HINT_LINGER_MS } from './upgradeNudge.ts';

type Handler = Parameters<CinematicEvents['on']>[1];

function crateBus(hold: AnnouncementHold): { fell(crateId: string): void; stop(): void } {
  const fell = new Set<Handler>();
  const stop = holdForCrateCinematics({
    events: {
      on(type, handler) {
        if (type !== 'crate:fell') return () => undefined;
        fell.add(handler);
        return () => fell.delete(handler);
      },
    },
    hold,
    director: { active: null },
    onFrame: () => () => undefined,
    afterRevealExit: (done) => {
      done();
      return () => undefined;
    },
    warn: () => undefined,
  });
  return {
    fell(crateId) {
      for (const handler of [...fell]) handler({ crateId });
    },
    stop,
  };
}

describe('foldNudgeOnCue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lingers about six seconds, never longer', () => {
    expect(HINT_LINGER_MS).toBeLessThanOrEqual(6000);
    const fold = vi.fn();
    foldNudgeOnCue(createAnnouncementHold(), fold);
    vi.advanceTimersByTime(HINT_LINGER_MS - 1);
    expect(fold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fold).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(fold).toHaveBeenCalledTimes(1);
  });

  it('folds the instant the first crate falls, and not again when its timer would have run', () => {
    const hold = createAnnouncementHold();
    const crates = crateBus(hold);
    const fold = vi.fn();
    foldNudgeOnCue(hold, fold);
    vi.advanceTimersByTime(1000);
    crates.fell('c1');
    expect(fold).toHaveBeenCalledTimes(1);
    crates.fell('c2');
    vi.advanceTimersByTime(HINT_LINGER_MS);
    expect(fold).toHaveBeenCalledTimes(1);
    crates.stop();
  });

  it('folds at once when a crate already holds the screen', () => {
    const hold = createAnnouncementHold();
    const crates = crateBus(hold);
    crates.fell('c1');
    const fold = vi.fn();
    foldNudgeOnCue(hold, fold);
    expect(fold).toHaveBeenCalledTimes(1);
    crates.stop();
  });

  it('cancelling stops both the timer and the crate cue', () => {
    const hold = createAnnouncementHold();
    const crates = crateBus(hold);
    const fold = vi.fn();
    const cancel = foldNudgeOnCue(hold, fold);
    cancel();
    crates.fell('c1');
    vi.advanceTimersByTime(HINT_LINGER_MS * 2);
    expect(fold).not.toHaveBeenCalled();
    crates.stop();
  });
});

describe('first-upgrade copy', () => {
  it.each([
    ['en', en, /ready/i, /buy/i],
    ['fr', fr, /disponible/i, /acheter/i],
    ['de', de, /bereit/i, /kaufen/i],
  ])('%s says the upgrade is affordable now', (_lang, locale, ready, buy) => {
    const hint = locale.hud.upgradeHint;
    expect(hint.title).toMatch(ready);
    expect(hint.title).toContain('{{name}}');
    expect(hint.aria).toContain('{{name}}');
    expect(hint.hint).toMatch(buy);
    expect(`${hint.title} ${hint.aria}`).not.toMatch(/within reach|à votre portée|in Reichweite/i);
  });
});
