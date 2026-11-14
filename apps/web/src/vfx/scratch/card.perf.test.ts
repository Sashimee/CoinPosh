import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CpuParticles } from '../particles/cpuParticles.ts';
import type { ParticleSpawn } from '../particles/layout.ts';
import { createAttractors, type ParticleEnvironment } from '../particles/physics.ts';
import { ScratchCard } from './card.ts';
import {
  answer,
  FakeSurface,
  installFakeDom,
  LABELS,
  runFrames,
  settle,
  type FakeDocument,
  type FakeElement,
} from './testDom.ts';

/**
 * The card's own main-thread share of a 16.7 ms frame on the WebGL2 fallback: pointer moves,
 * stamps, coverage, flake spawns and their CPU integration, and the style writes. The GPU draw
 * is not in it; the surface's pixel-ratio cap and frame gate keep that part small.
 */
const FRAME_BUDGET_MS = 2;
const MOVES_PER_FRAME = 4;
const STROKE_FRAMES = 90;
const SETTLE_FRAMES = 150;
/** Each frame keeps its fastest round: a busy runner only ever adds time (see #150). */
const ROUNDS = 12;
const ENV: ParticleEnvironment = {
  floor: { y: -100, minX: 1, maxX: 0, minZ: 1, maxZ: 0 },
  attractors: createAttractors(),
};

/** The fallback surface's CPU work, without the WebGL draw. */
class CpuFlakeSurface extends FakeSurface {
  private readonly particles = new CpuParticles(768);

  override flakes(spawns: readonly ParticleSpawn[]): void {
    for (const spawn of spawns) this.particles.emit(spawn);
  }

  override frame(): void {
    this.particles.step(1 / 60, ENV);
  }
}

let doc: FakeDocument;

beforeEach(() => {
  doc = installFakeDom();
});

afterEach(() => {
  runFrames(1);
  vi.unstubAllGlobals();
});

/** Scratches a zigzag over the whole window, then lets the card settle; returns each frame's ms. */
async function scratchOnce(reducedMotion: boolean): Promise<number[]> {
  const card: ScratchCard = new ScratchCard({
    host: doc.body as unknown as HTMLElement,
    labels: LABELS,
    reducedMotion,
    onBegin: () => {
      queueMicrotask(() => {
        card.reveal(answer());
      });
    },
    surface: () => Promise.resolve(new CpuFlakeSurface(doc)),
  });
  const root = card.el as unknown as FakeElement;
  const window = root.find('scratch-window');
  let at = 0;
  const pointer = (x: number, y: number) => ({
    button: 0,
    pointerId: 1,
    clientX: x * 300,
    clientY: y * 300,
    timeStamp: (at += 4),
    preventDefault: () => undefined,
  });
  window.dispatch('pointerdown', pointer(0.05, 0.05));
  await settle();
  window.dispatch('pointerup', pointer(0.05, 0.05));
  window.dispatch('pointerdown', pointer(0.05, 0.05));

  const times: number[] = [];
  for (let frame = 0; frame < STROKE_FRAMES + SETTLE_FRAMES; frame++) {
    const start = performance.now();
    if (frame < STROKE_FRAMES) {
      for (let move = 0; move < MOVES_PER_FRAME; move++) {
        const t = (frame * MOVES_PER_FRAME + move) / (STROKE_FRAMES * MOVES_PER_FRAME);
        const row = t * 10;
        const x = Math.floor(row) % 2 === 0 ? row % 1 : 1 - (row % 1);
        window.dispatch('pointermove', pointer(0.05 + 0.9 * x, 0.05 + 0.9 * t));
      }
    }
    runFrames(1);
    times.push(performance.now() - start);
  }
  expect(card.phase).toBe('settled');
  card.dispose();
  return times;
}

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Infinity;
}

describe('scratch card main-thread cost', () => {
  for (const reducedMotion of [false, true]) {
    it(`scratches and settles in under ${FRAME_BUDGET_MS} ms a frame (${reducedMotion ? 'reduced' : 'full'} motion)`, async () => {
      await scratchOnce(reducedMotion);
      const fastest: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const times = await scratchOnce(reducedMotion);
        times.forEach((ms, frame) => {
          fastest[frame] = Math.min(fastest[frame] ?? Infinity, ms);
        });
      }
      const median = percentile(fastest, 0.5);
      const p95 = percentile(fastest, 0.95);
      const worst = Math.max(...fastest);
      console.info(
        `[scratchCard] ${reducedMotion ? 'reduced' : 'full'} over ${fastest.length} frames: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, worst ${worst.toFixed(3)} ms`,
      );
      expect(median).toBeLessThan(FRAME_BUDGET_MS / 4);
      expect(p95).toBeLessThan(FRAME_BUDGET_MS);
    });
  }
});
