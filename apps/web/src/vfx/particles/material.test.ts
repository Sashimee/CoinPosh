import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { SHUTTER, STREAK_MAX_SCREEN, STREAK_MAX_SIZES, streakHalfLength } from './material.ts';

const WIDTH = 390;
const HEIGHT = 844;

function phoneProjY(): number {
  const camera = new PerspectiveCamera(40, WIDTH / HEIGHT, 0.05, 40);
  camera.updateProjectionMatrix();
  return camera.projectionMatrix.elements[5];
}

function px(halfLength: number, depth: number): number {
  return ((halfLength * phoneProjY()) / depth) * HEIGHT;
}

function streakPx(size: number, speed: number, depth: number): number {
  return px(streakHalfLength(size, speed, depth, phoneProjY()), depth);
}

describe('streakHalfLength', () => {
  it('keeps a slow spark stretched by its virtual shutter', () => {
    const size = 0.004;
    const speed = 0.05;
    expect(streakHalfLength(size, speed, 0.8, 2.75)).toBeCloseTo(size + speed * SHUTTER, 9);
  });

  it('never stretches past six sizes however fast the spark flies', () => {
    for (const speed of [1, 10, 1e4]) {
      const half = streakHalfLength(0.004, speed, 50, 2.75);
      expect(half).toBeCloseTo(STREAK_MAX_SIZES * 0.004, 9);
    }
  });

  it('caps every spark and homing streak under 40 css px at 390x844', () => {
    for (const depth of [0.3, 0.6, 1, 2]) {
      for (const size of [0.0022, 0.004, 0.0045]) {
        for (const speed of [0, 0.5, 3, 12, 80]) {
          expect(streakPx(size, speed, depth)).toBeLessThanOrEqual(40);
        }
      }
    }
    expect(STREAK_MAX_SCREEN * HEIGHT).toBeLessThan(40);
  });

  it('adds no stretch past 40 css px even to a sprite already that large up close', () => {
    for (const depth of [0.15, 0.3, 0.6, 1, 2]) {
      for (const size of [0.0022, 0.005, 0.01]) {
        for (const speed of [0, 0.5, 3, 12, 80]) {
          expect(streakPx(size, speed, depth)).toBeLessThanOrEqual(Math.max(40, px(size, depth)));
        }
      }
    }
  });

  it('still lets a fast spark read as a streak rather than a dot', () => {
    const size = 0.004;
    expect(streakHalfLength(size, 3, 0.8, phoneProjY())).toBeGreaterThan(size * 2.5);
  });

  it('never shrinks a streak below its own round size', () => {
    expect(streakHalfLength(0.03, 5, 0.05, 2.75)).toBeCloseTo(0.03, 9);
    expect(streakHalfLength(0.004, 0, 0, 2.75)).toBeCloseTo(0.004, 9);
  });
});
