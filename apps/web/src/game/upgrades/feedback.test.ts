import { WalletSchema } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import type { HapticPattern } from '../../app/feedback.ts';
import { createBus } from '../../app/bus.ts';
import { createI18n } from '../../i18n/index.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import type { UpgradeEvents } from './events.ts';
import { bindUpgradeFeedback, PURCHASE_CHIME, PURCHASE_HAPTIC } from './feedback.ts';
import { registerUpgradeStrings } from './i18n.ts';

const WALLET = WalletSchema.parse({
  coins: 40,
  bullion: 0,
  goldBars: 0,
  pearls: 0,
  keys: 0,
  tickets: 0,
  stars: 0,
});

interface Celebration {
  readonly lineId: string;
  readonly haptic: HapticPattern;
}

function setup(options: { readonly withCelebrate?: boolean } = {}) {
  const i18n = createI18n({ language: 'en', resources: { en: {}, fr: {}, de: {} } });
  registerUpgradeStrings(i18n);
  const events = createBus<UpgradeEvents>();
  const played: ImpactEvent[] = [];
  const celebrations: Celebration[] = [];
  const queued: (() => void)[] = [];
  const dispose = bindUpgradeFeedback({
    events,
    i18n,
    audio: () => ({ playImpact: (event) => played.push(event) }),
    notify: () => undefined,
    delay: (run) => {
      queued.push(run);
      return () => {
        queued.splice(queued.indexOf(run), 1);
      };
    },
    ...(options.withCelebrate === false
      ? {}
      : {
          celebrate: (lineId: string, haptic: HapticPattern) =>
            celebrations.push({ lineId, haptic }),
        }),
  });
  const flush = (): void => {
    for (const run of queued.splice(0)) run();
  };
  return { events, played, celebrations, dispose, flush };
}

describe('upgrade purchase celebration', () => {
  it('celebrates the confirmed line once, with the chime and its haptic', () => {
    const t = setup();
    t.events.emit('upgrade:purchased', { lineId: 'pusherSpeed', level: 1, wallet: WALLET });
    expect(t.celebrations).toEqual([{ lineId: 'pusherSpeed', haptic: PURCHASE_HAPTIC }]);
    t.flush();
    expect(t.played).toEqual(PURCHASE_CHIME.map((note) => note.sound));
  });

  it('waits for the server: a request or a refusal is never celebrated', () => {
    const t = setup();
    t.events.emit('upgrade:requested', { lineId: 'pusherSpeed', level: 1 });
    t.events.emit('upgrade:rejected', { lineId: 'pusherSpeed', level: 1, reason: 'unaffordable' });
    t.flush();
    expect(t.celebrations).toEqual([]);
    expect(t.played).toEqual([]);
  });

  it('celebrates each confirmed level of back-to-back purchases', () => {
    const t = setup();
    t.events.emit('upgrade:purchased', { lineId: 'pusherSpeed', level: 1, wallet: WALLET });
    t.events.emit('upgrade:purchased', { lineId: 'dropRate', level: 3, wallet: WALLET });
    expect(t.celebrations.map((c) => c.lineId)).toEqual(['pusherSpeed', 'dropRate']);
  });

  it('stops celebrating once disposed', () => {
    const t = setup();
    t.dispose();
    t.events.emit('upgrade:purchased', { lineId: 'pusherSpeed', level: 1, wallet: WALLET });
    expect(t.celebrations).toEqual([]);
  });

  it('defaults to the upgrades panel and stays quiet when no panel is mounted', () => {
    const t = setup({ withCelebrate: false });
    expect(() => {
      t.events.emit('upgrade:purchased', { lineId: 'pusherSpeed', level: 1, wallet: WALLET });
    }).not.toThrow();
    t.flush();
    expect(t.played).toHaveLength(PURCHASE_CHIME.length);
  });

  it('buzzes under each chime note, ending strongest on the brass', () => {
    const pattern = typeof PURCHASE_HAPTIC === 'number' ? [PURCHASE_HAPTIC] : [...PURCHASE_HAPTIC];
    expect(pattern.length % 2).toBe(1);
    const onsets: number[] = [];
    let at = 0;
    pattern.forEach((ms, index) => {
      if (index % 2 === 0) onsets.push(at);
      at += ms;
    });
    expect(onsets).toEqual(PURCHASE_CHIME.map((note) => note.delayMs));
    const pulses = pattern.filter((_, index) => index % 2 === 0);
    expect(Math.max(...pulses)).toBe(pulses.at(-1));
  });
});
