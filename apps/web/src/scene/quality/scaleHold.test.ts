import { describe, expect, it } from 'vitest';
import {
  BOOT_HOLD_MS,
  createScaleHold,
  OVERLAY_GRACE_MS,
  OVERLAY_MAX_MS,
  OVERLAY_POLL_MS,
  PLAYABLE_WAIT_MS,
} from './scaleHold.ts';

function sources() {
  const state = { playable: null as number | null, open: false, polls: 0 };
  return {
    state,
    playableAt: () => state.playable,
    overlayOpen: () => {
      state.polls += 1;
      return state.open;
    },
  };
}

const held = (until: number, nowMs: number) => nowMs < until;

describe('createScaleHold', () => {
  it('holds through boot and hands the playable frame to the boot pin', () => {
    const s = sources();
    const hold = createScaleHold(s);
    expect(held(hold.until(500), 500)).toBe(true);
    expect(hold.takeBootPin(500)).toBe(false);
    expect(held(hold.until(4_000), 4_000)).toBe(true);
    s.state.playable = 4_200;
    expect(held(hold.until(4_216), 4_216)).toBe(false);
    expect(hold.takeBootPin(4_216)).toBe(true);
    expect(hold.takeBootPin(4_232)).toBe(false);
  });

  it('pins on a playable mark up to BOOT_HOLD_MS old, as after a renderer rebuild in boot', () => {
    const recent = sources();
    recent.state.playable = 1_000;
    expect(createScaleHold(recent).takeBootPin(1_000 + BOOT_HOLD_MS - 1)).toBe(true);
    const stale = sources();
    stale.state.playable = 1_000;
    const hold = createScaleHold(stale);
    expect(hold.takeBootPin(1_000 + BOOT_HOLD_MS)).toBe(false);
    expect(hold.takeBootPin(1_000 + BOOT_HOLD_MS + 16)).toBe(false);
  });

  it('stops waiting for a playable mark that never comes', () => {
    const hold = createScaleHold(sources());
    expect(held(hold.until(1_000), 1_000)).toBe(true);
    expect(held(hold.until(1_000 + PLAYABLE_WAIT_MS - 1), 1_000 + PLAYABLE_WAIT_MS - 1)).toBe(true);
    expect(held(hold.until(1_000 + PLAYABLE_WAIT_MS), 1_000 + PLAYABLE_WAIT_MS)).toBe(false);
  });

  it('holds while a dialog is open and for OVERLAY_GRACE_MS after it closes', () => {
    const s = sources();
    s.state.playable = 0;
    const hold = createScaleHold(s);
    const t0 = 20_000;
    expect(held(hold.until(t0), t0)).toBe(false);
    s.state.open = true;
    expect(held(hold.until(t0 + OVERLAY_POLL_MS), t0 + OVERLAY_POLL_MS)).toBe(true);
    expect(held(hold.until(t0 + 3_000), t0 + 3_000)).toBe(true);
    s.state.open = false;
    const closedAt = t0 + 3_100;
    expect(held(hold.until(closedAt), closedAt)).toBe(true);
    expect(
      held(hold.until(closedAt + OVERLAY_GRACE_MS - 200), closedAt + OVERLAY_GRACE_MS - 200),
    ).toBe(true);
    expect(held(hold.until(closedAt + OVERLAY_GRACE_MS), closedAt + OVERLAY_GRACE_MS)).toBe(false);
  });

  it('measures again once a dialog has stayed open for OVERLAY_MAX_MS', () => {
    const s = sources();
    s.state.playable = 0;
    s.state.open = true;
    const hold = createScaleHold(s);
    const t0 = 20_000;
    for (let t = t0; t < t0 + OVERLAY_MAX_MS; t += OVERLAY_POLL_MS) {
      expect(held(hold.until(t), t)).toBe(true);
    }
    expect(held(hold.until(t0 + OVERLAY_MAX_MS), t0 + OVERLAY_MAX_MS)).toBe(false);
    s.state.open = false;
    hold.until(t0 + OVERLAY_MAX_MS + OVERLAY_POLL_MS);
    s.state.open = true;
    const reopened = t0 + OVERLAY_MAX_MS + 2 * OVERLAY_POLL_MS;
    expect(held(hold.until(reopened), reopened)).toBe(true);
  });

  it('reads the DOM at most once per poll interval', () => {
    const s = sources();
    s.state.playable = 0;
    const hold = createScaleHold(s);
    for (let t = 20_000; t < 21_000; t += 16) hold.until(t);
    expect(s.state.polls).toBeLessThanOrEqual(1_000 / OVERLAY_POLL_MS + 1);
  });
});
