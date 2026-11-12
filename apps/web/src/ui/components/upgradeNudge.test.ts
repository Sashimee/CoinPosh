import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import de from '../../i18n/locales/de/ui.json';
import en from '../../i18n/locales/en/ui.json';
import fr from '../../i18n/locales/fr/ui.json';
import { createAnnouncementHold } from './announcementHold.ts';
import { announcementSlotFor, type AnnouncementSlot } from './announcementSlot.ts';
import {
  CRATE_HINT_SLOT_MS,
  holdForCrateCinematics,
  type CinematicEvents,
} from './cinematicHold.ts';
import {
  HINT_LINGER_MS,
  NUDGE_SETTLE_MS,
  REAPPEAR_LINGER_MS,
  scheduleNudge,
  type NudgeSchedule,
} from './upgradeNudge.ts';

type Name = Parameters<CinematicEvents['on']>[0];
type Handler = Parameters<CinematicEvents['on']>[1];

interface Rig {
  readonly slot: AnnouncementSlot;
  readonly nudge: NudgeSchedule;
  /** Every show and fold the line made, in order. */
  readonly log: string[];
  emit(type: Name, crateId: string): void;
  /** A crate from its fall through its collected unbox, with no reveal left up. */
  unbox(crateId: string): void;
  stop(): void;
}

function rig(): Rig {
  const handlers = new Map<Name, Set<Handler>>();
  const hold = createAnnouncementHold();
  const director = { active: null as string | null };
  const log: string[] = [];
  const stopCrates = holdForCrateCinematics({
    events: {
      on(type, handler) {
        const set = handlers.get(type) ?? new Set();
        handlers.set(type, set);
        set.add(handler);
        return () => set.delete(handler);
      },
    },
    hold,
    director,
    onFrame: () => () => undefined,
    afterRevealExit: (done) => {
      done();
      return () => undefined;
    },
    warn: () => undefined,
  });
  const slot = announcementSlotFor(hold);
  const nudge = scheduleNudge(slot.quietFor('upgrade-nudge'), {
    show: (reappearing) => log.push(reappearing ? 'reshow' : 'show'),
    fold: () => log.push('fold'),
  });
  const emit = (type: Name, crateId: string): void => {
    for (const handler of [...(handlers.get(type) ?? [])]) handler({ crateId });
  };
  return {
    slot,
    nudge,
    log,
    emit,
    unbox(crateId) {
      emit('crate:fell', crateId);
      director.active = crateId;
      emit('crate:opened', crateId);
      emit('crate:collected', crateId);
      director.active = null;
    },
    stop() {
      nudge.dispose();
      stopCrates();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleNudge', () => {
  it('lingers about six seconds, never longer, and does not come back', () => {
    expect(HINT_LINGER_MS).toBeLessThanOrEqual(6000);
    const r = rig();
    r.nudge.offer();
    expect(r.log).toEqual(['show']);
    vi.advanceTimersByTime(HINT_LINGER_MS - 1);
    expect(r.log).toEqual(['show']);
    vi.advanceTimersByTime(1);
    expect(r.log).toEqual(['show', 'fold']);
    expect(r.nudge.phase).toBe('done');
    r.slot.claim('rank-stamp')();
    vi.advanceTimersByTime(60_000);
    expect(r.log).toEqual(['show', 'fold']);
    r.stop();
  });

  it('folds the instant a crate falls and comes back once after its unbox', () => {
    const r = rig();
    r.nudge.offer();
    vi.advanceTimersByTime(1000);
    r.emit('crate:fell', 'c1');
    expect(r.log).toEqual(['show', 'fold']);
    vi.advanceTimersByTime(HINT_LINGER_MS);
    expect(r.log).toEqual(['show', 'fold']);
    r.emit('crate:opened', 'c1');
    r.emit('crate:collected', 'c1');
    vi.advanceTimersByTime(NUDGE_SETTLE_MS);
    expect(r.log).toEqual(['show', 'fold', 'reshow']);
    vi.advanceTimersByTime(REAPPEAR_LINGER_MS - 1);
    expect(r.log).toEqual(['show', 'fold', 'reshow']);
    vi.advanceTimersByTime(1);
    expect(r.log).toEqual(['show', 'fold', 'reshow', 'fold']);
    expect(r.nudge.phase).toBe('done');
    r.stop();
  });

  it('defers on crate:spawned and first shows only once that crate has been unboxed', () => {
    const r = rig();
    r.emit('crate:spawned', 'c1');
    r.nudge.offer();
    expect(r.nudge.phase).toBe('waiting');
    vi.advanceTimersByTime(CRATE_HINT_SLOT_MS + NUDGE_SETTLE_MS);
    expect(r.log).toEqual([]);
    r.unbox('c1');
    vi.advanceTimersByTime(NUDGE_SETTLE_MS - 1);
    expect(r.log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.log).toEqual(['show']);
    vi.advanceTimersByTime(HINT_LINGER_MS);
    expect(r.log).toEqual(['show', 'fold']);
    r.stop();
  });

  it('folds when a crate lands under it and stays down through the hand-over to the fall', () => {
    const r = rig();
    r.nudge.offer();
    r.emit('crate:spawned', 'c1');
    expect(r.log).toEqual(['show', 'fold']);
    vi.advanceTimersByTime(CRATE_HINT_SLOT_MS * 2);
    expect(r.log).toEqual(['show', 'fold']);
    r.emit('crate:fell', 'c1');
    vi.advanceTimersByTime(NUDGE_SETTLE_MS * 2);
    expect(r.log).toEqual(['show', 'fold']);
    r.emit('crate:opened', 'c1');
    r.emit('crate:collected', 'c1');
    vi.advanceTimersByTime(NUDGE_SETTLE_MS);
    expect(r.log).toEqual(['show', 'fold', 'reshow']);
    r.stop();
  });

  it('defers while a rank stamp is up and comes back after it', () => {
    const r = rig();
    const stamp = r.slot.claim('rank-stamp');
    r.nudge.offer();
    expect(r.log).toEqual([]);
    stamp();
    vi.advanceTimersByTime(NUDGE_SETTLE_MS);
    expect(r.log).toEqual(['show']);
    const next = r.slot.claim('rank-stamp');
    expect(r.log).toEqual(['show', 'fold']);
    next();
    vi.advanceTimersByTime(NUDGE_SETTLE_MS);
    expect(r.log).toEqual(['show', 'fold', 'reshow']);
    r.stop();
  });

  it('reappears at most once', () => {
    const r = rig();
    r.nudge.offer();
    r.slot.claim('rank-stamp')();
    vi.advanceTimersByTime(NUDGE_SETTLE_MS);
    r.slot.claim('rank-stamp')();
    expect(r.nudge.phase).toBe('done');
    vi.advanceTimersByTime(60_000);
    r.unbox('c1');
    vi.advanceTimersByTime(60_000);
    expect(r.log).toEqual(['show', 'fold', 'reshow', 'fold']);
    r.stop();
  });

  it('waits out a slot that frees for less than the settle time', () => {
    const r = rig();
    r.nudge.offer();
    r.slot.claim('rank-stamp')();
    vi.advanceTimersByTime(NUDGE_SETTLE_MS - 1);
    const second = r.slot.claim('rank-stamp');
    vi.advanceTimersByTime(NUDGE_SETTLE_MS * 3);
    expect(r.log).toEqual(['show', 'fold']);
    second();
    vi.advanceTimersByTime(NUDGE_SETTLE_MS);
    expect(r.log).toEqual(['show', 'fold', 'reshow']);
    r.stop();
  });

  it('never shows once dismissed while waiting, and folds when dismissed while showing', () => {
    const waiting = rig();
    const stamp = waiting.slot.claim('rank-stamp');
    waiting.nudge.offer();
    waiting.nudge.dismiss();
    stamp();
    vi.advanceTimersByTime(60_000);
    expect(waiting.log).toEqual([]);
    waiting.stop();

    const showing = rig();
    showing.nudge.offer();
    showing.nudge.dismiss();
    expect(showing.log).toEqual(['show', 'fold']);
    vi.advanceTimersByTime(60_000);
    expect(showing.log).toEqual(['show', 'fold']);
    showing.stop();
  });

  it('ignores a second offer', () => {
    const r = rig();
    r.nudge.offer();
    r.nudge.offer();
    expect(r.log).toEqual(['show']);
    r.stop();
  });

  it('stops both its timers and its slot cue on dispose', () => {
    const r = rig();
    r.nudge.offer();
    r.nudge.dispose();
    r.emit('crate:fell', 'c1');
    vi.advanceTimersByTime(HINT_LINGER_MS * 2);
    expect(r.log).toEqual(['show']);
    r.stop();
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
