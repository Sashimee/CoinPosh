import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnnouncementHold, type AnnouncementHold } from './announcementHold.ts';
import { holdForCrateCinematics, type CinematicEvents } from './cinematicHold.ts';

type Name = Parameters<CinematicEvents['on']>[0];
type Handler = Parameters<CinematicEvents['on']>[1];

const CAP_MS = 1000;

interface Rig {
  readonly hold: AnnouncementHold;
  readonly director: { active: string | null };
  readonly warnings: string[];
  emit(type: Name, crateId: string): void;
  frame(): void;
  /** Lets the collected crate's reveal leave the screen. */
  exitReveal(): void;
  readonly listeners: () => number;
  readonly stop: () => void;
}

function rig(options: { revealUp?: boolean } = {}): Rig {
  const handlers = new Map<Name, Set<Handler>>();
  const frames = new Set<() => void>();
  const exits = new Set<() => void>();
  const hold = createAnnouncementHold();
  const director = { active: null as string | null };
  const warnings: string[] = [];
  const stop = holdForCrateCinematics({
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
    onFrame(check) {
      frames.add(check);
      return () => frames.delete(check);
    },
    afterRevealExit(done) {
      if (options.revealUp === false) {
        done();
        return () => undefined;
      }
      exits.add(done);
      return () => exits.delete(done);
    },
    claimCapMs: CAP_MS,
    warn: (message) => warnings.push(message),
  });
  return {
    hold,
    director,
    warnings,
    emit(type, crateId) {
      for (const handler of [...(handlers.get(type) ?? [])]) handler({ crateId });
    },
    frame() {
      for (const check of [...frames]) check();
    },
    exitReveal() {
      const pending = [...exits];
      exits.clear();
      for (const done of pending) done();
    },
    listeners: () => [...handlers.values()].reduce((n, set) => n + set.size, 0) + frames.size,
    stop,
  };
}

/** The director takes the opened crate on the same tick when it is idle, as `enqueue` does. */
function openAndPlay(r: Rig, crateId: string): void {
  r.director.active ??= crateId;
  r.emit('crate:opened', crateId);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('holdForCrateCinematics', () => {
  it('holds from the fall through the unbox until the collected reveal has left', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    expect(r.hold.held).toBe(true);
    openAndPlay(r, 'a');
    r.frame();
    vi.advanceTimersByTime(CAP_MS * 5);
    expect(r.hold.held).toBe(true);
    r.emit('crate:collected', 'a');
    expect(r.hold.held).toBe(true);
    r.director.active = null;
    r.frame();
    expect(r.hold.held).toBe(true);
    r.exitReveal();
    expect(r.hold.held).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('lets go at once when the collect finds no reveal up', () => {
    const r = rig({ revealUp: false });
    r.emit('crate:fell', 'a');
    openAndPlay(r, 'a');
    r.emit('crate:collected', 'a');
    expect(r.hold.held).toBe(false);
  });

  it('lets go when a claim stays queued offline past the cap, and holds again once it opens', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    vi.advanceTimersByTime(CAP_MS - 1);
    expect(r.hold.held).toBe(true);
    vi.advanceTimersByTime(1);
    expect(r.hold.held).toBe(false);
    expect(r.warnings).toHaveLength(1);
    openAndPlay(r, 'a');
    expect(r.hold.held).toBe(true);
    r.emit('crate:collected', 'a');
    r.exitReveal();
    expect(r.hold.held).toBe(false);
  });

  it('never lapses a crate that opened inside the cap', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    openAndPlay(r, 'a');
    vi.advanceTimersByTime(CAP_MS * 3);
    r.frame();
    expect(r.hold.held).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it.each(['crate:rejected', 'crate:failed'] as const)('lets go at once on %s', (type) => {
    const r = rig();
    r.emit('crate:fell', 'a');
    r.emit(type, 'a');
    expect(r.hold.held).toBe(false);
    vi.advanceTimersByTime(CAP_MS * 2);
    expect(r.warnings).toEqual([]);
  });

  it('lets go when the director could not start the unbox (its card or cinematic threw)', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    r.emit('crate:opened', 'a');
    expect(r.director.active).toBeNull();
    expect(r.hold.held).toBe(false);
    expect(r.warnings).toHaveLength(1);
  });

  it('keeps a queued crate held behind the one playing, and lets go if its turn throws', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    openAndPlay(r, 'a');
    r.emit('crate:fell', 'b');
    openAndPlay(r, 'b');
    expect(r.director.active).toBe('a');
    r.emit('crate:collected', 'a');
    r.exitReveal();
    r.frame();
    expect(r.hold.held).toBe(true);
    r.director.active = null;
    r.frame();
    expect(r.hold.held).toBe(false);
    expect(r.warnings).toHaveLength(1);
  });

  it('lets go of a crate the director skipped past after its start threw', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    openAndPlay(r, 'a');
    r.emit('crate:fell', 'b');
    openAndPlay(r, 'b');
    r.emit('crate:fell', 'c');
    openAndPlay(r, 'c');
    r.emit('crate:collected', 'a');
    r.exitReveal();
    r.director.active = 'c';
    r.frame();
    expect(r.hold.held).toBe(true);
    expect(r.warnings).toHaveLength(1);
    r.emit('crate:collected', 'c');
    r.exitReveal();
    expect(r.hold.held).toBe(false);
  });

  it('lets go when an unbox ends without a collect', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    openAndPlay(r, 'a');
    r.frame();
    r.director.active = null;
    r.frame();
    expect(r.hold.held).toBe(false);
  });

  it('holds afresh for a crate that falls right after a release', () => {
    const r = rig();
    const changes: boolean[] = [];
    r.hold.onChange((held) => changes.push(held));
    r.emit('crate:fell', 'a');
    openAndPlay(r, 'a');
    r.emit('crate:collected', 'a');
    r.director.active = null;
    r.exitReveal();
    r.emit('crate:fell', 'b');
    expect(changes).toEqual([true, false, true]);
    openAndPlay(r, 'b');
    r.emit('crate:collected', 'b');
    r.exitReveal();
    expect(changes).toEqual([true, false, true, false]);
  });

  it('ignores a repeated fall for a crate it already holds', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    r.emit('crate:fell', 'a');
    r.emit('crate:rejected', 'a');
    expect(r.hold.held).toBe(false);
  });

  it('releases every hold, cancels its timers and unsubscribes on dispose', () => {
    const r = rig();
    r.emit('crate:fell', 'a');
    r.emit('crate:fell', 'b');
    openAndPlay(r, 'b');
    r.emit('crate:collected', 'b');
    r.stop();
    expect(r.hold.held).toBe(false);
    expect(r.listeners()).toBe(0);
    vi.advanceTimersByTime(CAP_MS * 2);
    r.exitReveal();
    expect(r.warnings).toEqual([]);
  });
});
