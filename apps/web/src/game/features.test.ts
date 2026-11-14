import { CoinIdSchema } from '@coinposh/shared';
import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../app/bus.ts';
import { createI18n } from '../i18n/core.ts';
import { connectPlayer, createMockServer, FakeTime } from '../net/test/harness.ts';
import { Haptics } from '../vfx/haptics.ts';
import {
  mountGameFeatures,
  type GameFeature,
  type GameFeatureContext,
  type GameFeatureErrorReport,
} from './features.ts';
import type { GameEvents } from './systems/events.ts';

async function context(reduced = false): Promise<GameFeatureContext> {
  const time = new FakeTime();
  const player = await connectPlayer(createMockServer({ now: time.now, storage: null }), time);
  const i18n = createI18n({
    language: 'fr',
    resources: {
      en: { ui: {}, sample: { banked: 'Banked {{amount}}' } },
      fr: { ui: {}, sample: { banked: '{{amount}} en banque' } },
      de: { ui: {}, sample: { banked: '{{amount}} verbucht' } },
    },
  });
  return {
    events: createBus<GameEvents>(),
    api: player.client,
    i18n,
    audio: () => null,
    haptics: () => new Haptics(undefined, () => 0),
    reducedMotion: () => reduced,
  };
}

const credited = (amount: number): GameEvents['value:credited'] => ({
  amount,
  coinId: CoinIdSchema.parse('coin_AAAAAAAAAAAAAAAA'),
  tier: null,
  position: null,
  cascade: null,
});

/** A sample feature: tallies credited value from the bus and reads the quest board on mount. */
function sampleTally() {
  const lines: string[] = [];
  const motion: boolean[] = [];
  let boardLoaded = false;
  const feature: GameFeature = {
    id: 'sample.tally',
    mount(ctx) {
      let total = 0;
      void ctx.api.call('quests').then(() => {
        boardLoaded = true;
      });
      const off = ctx.events.on('value:credited', ({ amount }) => {
        total += amount;
        motion.push(ctx.reducedMotion());
        lines.push(ctx.i18n.t('sample:banked', { amount: total }));
        ctx.haptics()?.pulse('tick');
      });
      return { dispose: off };
    },
  };
  return { feature, lines, motion, boardLoaded: () => boardLoaded };
}

function recorder(log: string[], id: string, failOn?: 'mount' | 'dispose'): GameFeature {
  return {
    id,
    mount() {
      if (failOn === 'mount') throw new Error(`${id} mount broke`);
      log.push(`mount ${id}`);
      return {
        dispose() {
          if (failOn === 'dispose') throw new Error(`${id} dispose broke`);
          log.push(`dispose ${id}`);
        },
      };
    },
  };
}

describe('mountGameFeatures', () => {
  it('gives a feature the bus, API, i18n and accessors, and silences it on dispose', async () => {
    const ctx = await context(true);
    const sample = sampleTally();
    const handle = mountGameFeatures([sample.feature], ctx);
    ctx.events.emit('value:credited', credited(40));
    ctx.events.emit('value:credited', credited(2));
    await vi.waitFor(() => {
      expect(sample.boardLoaded()).toBe(true);
    });
    expect(sample.lines).toEqual(['40 en banque', '42 en banque']);
    expect(sample.motion).toEqual([true, true]);
    handle.dispose();
    ctx.events.emit('value:credited', credited(8));
    expect(sample.lines).toHaveLength(2);
  });

  it('mounts in order and disposes in reverse, once', async () => {
    const log: string[] = [];
    const handle = mountGameFeatures(
      [recorder(log, 'a'), recorder(log, 'b'), recorder(log, 'c')],
      await context(),
    );
    handle.dispose();
    handle.dispose();
    expect(log).toEqual(['mount a', 'mount b', 'mount c', 'dispose c', 'dispose b', 'dispose a']);
  });

  it('reports a feature whose mount throws and keeps the others running', async () => {
    const log: string[] = [];
    const report = vi.fn<GameFeatureErrorReport>();
    const handle = mountGameFeatures(
      [recorder(log, 'a'), recorder(log, 'broken', 'mount'), recorder(log, 'c')],
      await context(),
      report,
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatch(/"broken" failed to mount/);
    expect(report.mock.calls[0]?.[1]).toEqual(new Error('broken mount broke'));
    handle.dispose();
    expect(log).toEqual(['mount a', 'mount c', 'dispose c', 'dispose a']);
  });

  it('reports a feature whose dispose throws and still tears the rest down', async () => {
    const log: string[] = [];
    const report = vi.fn<GameFeatureErrorReport>();
    const handle = mountGameFeatures(
      [recorder(log, 'a'), recorder(log, 'sticky', 'dispose'), recorder(log, 'c')],
      await context(),
      report,
    );
    handle.dispose();
    expect(log).toEqual(['mount a', 'mount sticky', 'mount c', 'dispose c', 'dispose a']);
    expect(report).toHaveBeenCalledWith(
      expect.stringMatching(/"sticky" failed to dispose/),
      new Error('sticky dispose broke'),
    );
  });

  it('reports to console.error by default', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mountGameFeatures([recorder([], 'broken', 'mount')], await context());
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/"broken" failed to mount; the game continues without it/),
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('refuses two features with one id before mounting either', async () => {
    const log: string[] = [];
    const ctx = await context();
    expect(() => mountGameFeatures([recorder(log, 'twin'), recorder(log, 'twin')], ctx)).toThrow(
      /"twin" is registered twice/,
    );
    expect(log).toEqual([]);
  });

  it('mounts nothing for an empty list', async () => {
    const ctx = await context();
    expect(() => {
      mountGameFeatures([], ctx).dispose();
    }).not.toThrow();
  });
});
