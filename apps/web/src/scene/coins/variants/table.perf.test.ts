import {
  COIN_TIERS,
  COLLECTIBLE_COIN_VARIANTS,
  PRIZE_FAMILIES,
  PRIZE_RARITIES,
} from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { loadPrizes } from '../../prizes/lazy.ts';
import { VariantCoinField } from './field.ts';

/**
 * The main-thread share of a 16.7 ms frame that a busy collecting table adds on the mid profile
 * (quality medium): eight prizes ticking and glinting, and a heavy spread of variant coins across
 * every tier and variant, re-sent each frame as the sim moves them, culled, LOD-split, labelled
 * and uploaded. The GPU side cannot be timed here (CI renders on SwiftShader, see
 * e2e/budgets.ts); it is bounded by the draw calls counted below, and the device frame time is
 * T-11.16's frame budget check on the wired table.
 */
const FRAME_BUDGET_MS = 1;
const FRAMES = 240;
/** Each frame keeps its fastest round: a busy runner only ever adds time (see #150). */
const ROUNDS = 8;
const COINS_PER_BATCH = 4;
const PRIZES = 8;
const RADIUS = 0.0135;
/** Two LOD meshes per tier and variant, plus the contact discs and the badges. */
const MAX_VARIANT_DRAWS = COIN_TIERS.length * COLLECTIBLE_COIN_VARIANTS.length * 2 + 2;
const MAX_PRIZE_DRAWS = 5;

function percentile(samples: readonly number[], share: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Infinity;
}

async function playTable(): Promise<{ times: number[]; draws: number; coins: number }> {
  const { createPrizeKit } = await loadPrizes();
  const kit = createPrizeKit({ quality: 'medium' });
  const prizes = Array.from({ length: PRIZES }, (_, i) =>
    kit.create(PRIZE_FAMILIES[i % PRIZE_FAMILIES.length] ?? 'watch', {
      rarity: PRIZE_RARITIES[i % PRIZE_RARITIES.length] ?? 'common',
    }),
  );
  const field = new VariantCoinField({ capacity: COINS_PER_BATCH * 2, radius: RADIUS });
  const camera = new PerspectiveCamera(35, 390 / 844, 0.01, 10);
  camera.position.set(0, 0.55, 0.75);
  camera.lookAt(new Vector3(0, 0, -0.05));
  camera.updateProjectionMatrix();

  const positions = new Float32Array(COINS_PER_BATCH * 3);
  const quaternions = new Float32Array(COINS_PER_BATCH * 4);
  const ids = new Float64Array(COINS_PER_BATCH);
  const times: number[] = [];
  let draws = 0;
  let coins = 0;
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const start = performance.now();
    let batch = 0;
    for (const tier of COIN_TIERS) {
      for (const variant of COLLECTIBLE_COIN_VARIANTS) {
        for (let k = 0; k < COINS_PER_BATCH; k += 1) {
          const slot = batch * COINS_PER_BATCH + k;
          positions[k * 3] = ((slot % 12) - 5.5) * 0.028;
          positions[k * 3 + 1] = 0;
          positions[k * 3 + 2] = 0.12 - Math.floor(slot / 12) * 0.03 + frame * 0.0002;
          const half = (slot * 0.37 + frame * 0.01) / 2;
          quaternions[k * 4 + 1] = Math.sin(half);
          quaternions[k * 4 + 3] = Math.cos(half);
          ids[k] = slot;
        }
        field.setTransforms(tier, variant, positions, quaternions, COINS_PER_BATCH, ids);
        if (frame % 30 === batch % 30) field.glint(tier, variant, batch * COINS_PER_BATCH);
        batch += 1;
      }
    }
    const stats = field.update(camera, 844, 1 / 60);
    for (const [i, prize] of prizes.entries()) {
      if (frame % 60 === i * 7) prize.glint();
      prize.update(1 / 60);
    }
    times.push(performance.now() - start);
    draws = stats.drawCalls + prizes.reduce((sum, prize) => sum + prize.drawCalls, 0);
    coins = stats.coins;
  }
  field.dispose();
  for (const prize of prizes) prize.dispose();
  kit.dispose();
  return { times, draws, coins };
}

describe('collecting table main-thread cost on the mid profile', () => {
  it(`ticks ${PRIZES} prizes and ${COIN_TIERS.length * COLLECTIBLE_COIN_VARIANTS.length * COINS_PER_BATCH} variant coins in under ${FRAME_BUDGET_MS} ms a frame`, async () => {
    await playTable();
    const fastest: number[] = [];
    let last = { draws: 0, coins: 0 };
    for (let round = 0; round < ROUNDS; round += 1) {
      const run = await playTable();
      run.times.forEach((ms, frame) => {
        fastest[frame] = Math.min(fastest[frame] ?? Infinity, ms);
      });
      last = run;
    }
    const median = percentile(fastest, 0.5);
    const p95 = percentile(fastest, 0.95);
    console.info(
      `[collectingTable] medium, ${last.coins} variant coins on screen, ${PRIZES} prizes, ${last.draws} draw calls: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, worst ${Math.max(...fastest).toFixed(3)} ms`,
    );
    expect(last.coins).toBeGreaterThan(0);
    expect(last.draws).toBeLessThanOrEqual(MAX_VARIANT_DRAWS + PRIZES * MAX_PRIZE_DRAWS);
    expect(median).toBeLessThan(FRAME_BUDGET_MS / 4);
    expect(p95).toBeLessThan(FRAME_BUDGET_MS);
  });
});
