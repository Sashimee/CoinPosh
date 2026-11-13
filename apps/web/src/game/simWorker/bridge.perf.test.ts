import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three/webgpu';
import { CoinField, type CoinTierId } from '../../scene/coins/index.ts';
import { SIM_COIN_DIMENSIONS, SimBridge } from './bridge.ts';
import { FrameView } from './frame.ts';
import { TICK_MS } from './runtime.ts';
import { FakeWorker, table } from './test/fake-worker.ts';

describe('SimBridge render-thread cost', () => {
  it('draws 250 coins at 120 Hz in well under 2 ms of render-thread time per frame', () => {
    let now = 0;
    const worker = new FakeWorker();
    const bridge = new SimBridge(worker, {
      seed: 1,
      transport: 'transfer',
      now: () => now,
    });
    const field = new CoinField({
      capacity: { copper: 256, silver: 128, gold: 64, platinum: 32, diamond: 16, heirloom: 8 },
      radius: SIM_COIN_DIMENSIONS.radius,
    });
    const camera = new PerspectiveCamera(40, 9 / 16, 0.05, 50);
    camera.position.set(0, 0.45, 0.55);
    camera.lookAt(0, 0, 0.05);
    camera.updateProjectionMatrix();
    const tiers: CoinTierId[] = [
      'copper',
      'copper',
      'copper',
      'copper',
      'copper',
      'silver',
      'gold',
      'platinum',
    ];
    for (let id = 0; id < 250; id += 1) bridge.setTier(id, tiers[id % tiers.length] ?? 'copper');

    const pool = worker.takeBuffers();
    let tick = 0;
    const publish = (): void => {
      pool.push(...worker.takeBuffers());
      const buffer = pool.pop();
      if (!buffer) throw new Error('ring ran dry');
      new FrameView(buffer, 0, bridge.capacity).write(tick, 0, table(250, tick));
      worker.emit('message', { type: 'frame', buffer });
      tick += 1;
    };

    const costs: number[] = [];
    const frameMs = 1000 / 120;
    try {
      for (let frame = 0; frame < 1200; frame += 1) {
        now = frame * frameMs;
        while (tick * TICK_MS + 3 <= now) publish();
        const start = performance.now();
        bridge.sync(field);
        field.update(camera, 1280);
        costs.push(performance.now() - start);
      }
    } finally {
      field.dispose();
    }
    expect(bridge.stats.coins).toBe(250);
    expect(
      (['copper', 'silver', 'gold', 'platinum'] as const).map((tier) => field.count(tier)),
    ).toEqual([157, 31, 31, 31]);
    const steady = costs.slice(240).sort((a, b) => a - b);
    const median = steady[Math.floor(steady.length / 2)] ?? Infinity;
    const p95 = steady[Math.floor(steady.length * 0.95)] ?? Infinity;
    console.info(
      `[simWorker] 250 coins, render thread per 120 Hz frame: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`,
    );
    expect(median).toBeLessThan(1);
    expect(p95).toBeLessThan(2);
  });
});
