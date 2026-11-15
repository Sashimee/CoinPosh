import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { GameEvents } from '../../game/systems/events.ts';
import { createBossPresence } from './presence.ts';

/**
 * Both figures update on the main thread every frame beside the game. Measured on a desktop, so
 * a mid phone at roughly 5x slower spends well under a millisecond of its 16.7 ms on them.
 */
const FRAME_BUDGET_MS = 0.1;
const FRAMES = 600;
/** Fastest of several rounds: preemption on a shared runner only ever adds time. */
const ROUNDS = 7;

describe('boss presence perf', () => {
  it('updates both figures through a cascade within the frame budget', () => {
    const bus = createBus<GameEvents>();
    const figures = [
      createBossPresence({ kind: 'taxInspector', events: bus, side: -1 }),
      createBossPresence({ kind: 'rivalTycoon', events: bus }),
    ];
    let best = Infinity;
    for (let round = 0; round < ROUNDS; round++) {
      const start = performance.now();
      for (let frame = 0; frame < FRAMES; frame++) {
        if (frame === 60) bus.emit('cascade:tier', { tier: 'lavish', rank: 2, count: 8 });
        if (frame === 90) bus.emit('cascade:tier', { tier: 'obscene', rank: 5, count: 40 });
        if (frame === 200) bus.emit('cascade:end', { count: 40, tier: 'obscene' });
        for (const figure of figures) figure.update(1 / 60);
      }
      best = Math.min(best, (performance.now() - start) / FRAMES);
    }
    for (const figure of figures) figure.dispose();
    expect(best).toBeLessThan(FRAME_BUDGET_MS);
  });
});
