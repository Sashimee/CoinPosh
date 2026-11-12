import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { rivieraCameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { unboxShot } from './shot.ts';

const PORTRAIT = 390 / 844;
const LANDSCAPE = 844 / 390;

describe('unboxShot memo', () => {
  it('hands back the same shot for the same framing, aspect and variant', () => {
    const first = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, false);
    const again = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, false);
    expect(again).toBe(first);
  });

  it('frames each variant and aspect on its own', () => {
    const full = unboxShot(rivieraCameraPreset(LANDSCAPE), LANDSCAPE, false);
    const reduced = unboxShot(rivieraCameraPreset(LANDSCAPE), LANDSCAPE, true);
    const portrait = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, false);
    expect(reduced).not.toBe(full);
    expect(portrait).not.toBe(full);
    expect(reduced.center.distanceTo(full.center)).toBeGreaterThan(1e-4);
  });

  it('re-frames when the framing itself moves at the same aspect', () => {
    const framing = rivieraCameraPreset(PORTRAIT);
    const base = unboxShot(framing, PORTRAIT, false);
    const raised = {
      ...framing,
      position: framing.position.clone().add(new Vector3(0, 0.05, 0)),
    };
    const moved = unboxShot(raised, PORTRAIT, false);
    expect(moved).not.toBe(base);
    expect(moved.center.y - base.center.y).toBeGreaterThan(0.01);
  });

  it('keeps every shot of a long session framed after the memo starts evicting', () => {
    const first = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, true);
    for (let i = 0; i < 40; i++) {
      const aspect = 0.4 + i * 0.05;
      unboxShot(rivieraCameraPreset(aspect), aspect, true);
    }
    const refit = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, true);
    expect(refit.center.distanceTo(first.center)).toBeLessThan(1e-12);
    expect(refit.yaw).toBe(first.yaw);
  });
});
