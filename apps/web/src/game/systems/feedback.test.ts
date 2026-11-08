import type { CoinId } from '@coinposh/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { GameEvents } from './events.ts';
import { wireFeedback, type FeedbackAudio, type FeedbackVfx } from './feedback.ts';

const BOUNDS = { fieldHalfWidth: 0.25, fieldFrontZ: 0.4 };
const COIN_ID = 'coin_AAAAAAAAAAAAAAA1' as CoinId;

function setup() {
  const calls: { target: string; args: unknown[] }[] = [];
  const spy =
    (target: string) =>
    (...args: unknown[]): void => {
      calls.push({ target, args });
    };
  const vfx: FeedbackVfx = {
    contactSparks: spy('contactSparks'),
    fusion: spy('fusion'),
    cascade: spy('cascade'),
    numberPop: spy('numberPop'),
    cameraKick: spy('cameraKick'),
  };
  const audio: FeedbackAudio = {
    playImpact: spy('playImpact'),
    comboStep: spy('comboStep'),
    setComboTier: spy('setComboTier'),
    duckMusic: spy('duckMusic'),
  };
  const live = { vfx: null as FeedbackVfx | null, audio: null as FeedbackAudio | null };
  const events = createBus<GameEvents>();
  const vault = { getBoundingClientRect: () => ({}) } as unknown as Element;
  const stop = wireFeedback(events, {
    vfx: () => live.vfx,
    audio: () => live.audio,
    vault,
    bounds: BOUNDS,
  });
  const named = (target: string) => calls.filter((call) => call.target === target);
  return { events, live, vfx, audio, vault, stop, calls, named };
}

describe('wireFeedback', () => {
  it('flies every credited amount from where the coin fell into the Vault', () => {
    const { events, live, vfx, vault, named } = setup();
    live.vfx = vfx;
    events.emit('value:credited', {
      amount: 25,
      coinId: COIN_ID,
      tier: 'gold',
      position: { x: 0.1, y: 0.02, z: 0.39 },
      cascade: null,
    });
    events.emit('value:credited', {
      amount: 1,
      coinId: COIN_ID,
      tier: null,
      position: null,
      cascade: null,
    });
    const pops = named('numberPop');
    expect(pops.map(({ args }) => [args[0], args[2], args[3]])).toEqual([
      [25, vault, { tier: 'gold' }],
      [1, vault, {}],
    ]);
    expect(pops[0]?.args[1]).toMatchObject({ x: 0.1, y: 0.02, z: 0.39 });
    expect(pops[1]?.args[1]).toMatchObject({ x: 0, y: 0, z: BOUNDS.fieldFrontZ });
  });

  it('reaches effects that came up after it was wired, and skips the ones still missing', () => {
    const { events, live, audio, named } = setup();
    const hit = { position: { x: 0.25, y: 0, z: 0 }, strength: 0.5, surface: 'wood' as const };
    events.emit('coin:contact', hit);
    expect(named('playImpact')).toEqual([]);
    live.audio = audio;
    events.emit('coin:contact', hit);
    expect(named('playImpact').map(({ args }) => args[0])).toEqual([
      { material: 'wood', velocity: 1.4, pan: 1 },
    ]);
    expect(named('contactSparks')).toEqual([]);
  });

  it('sparks and clinks a contact on its surface', () => {
    const { events, live, vfx, audio, named } = setup();
    live.vfx = vfx;
    live.audio = audio;
    events.emit('coin:contact', {
      position: { x: -0.125, y: 0, z: 0 },
      strength: 1,
      surface: 'metal',
    });
    expect(named('playImpact').map(({ args }) => args[0])).toEqual([
      { material: 'metal', velocity: 2.8, pan: -0.5 },
    ]);
    expect(named('contactSparks').map(({ args }) => args[1])).toEqual([
      { strength: 1, surface: 'metal' },
    ]);
  });

  it('climbs the combo ladder and bursts the cascade where the last front coin fell', () => {
    const { events, live, vfx, audio, named } = setup();
    live.vfx = vfx;
    live.audio = audio;
    const position = { x: 0.05, y: 0.01, z: 0.4 };
    events.emit('coin:fell', { coin: null, edge: 'front', position, tick: 10 });
    events.emit('coin:fell', {
      coin: null,
      edge: 'left',
      position: { x: -0.3, y: 0, z: 0 },
      tick: 11,
    });
    events.emit('cascade:step', { count: 3, tier: 'chic' });
    events.emit('cascade:tier', { tier: 'chic', rank: 1, count: 3 });
    events.emit('cascade:end', { count: 3, tier: 'chic' });
    expect(named('comboStep').map(({ args }) => args[0])).toEqual([3]);
    expect(named('setComboTier').map(({ args }) => args[0])).toEqual([1, 0]);
    const [burst] = named('cascade');
    expect(burst?.args[0]).toBe('chic');
    expect(burst?.args[1]).toMatchObject({ origin: position });
  });

  it('kicks the camera and thumps the cabinet on a nudge, and ducks the music on a freeze', () => {
    const { events, live, vfx, audio, named } = setup();
    live.vfx = vfx;
    live.audio = audio;
    events.emit('nudge', { direction: 'left', strength: 1, source: 'swipe', tick: 0 });
    events.emit('concierge:freeze', { seconds: 6 });
    expect(named('cameraKick').map(({ args }) => args[0])).toEqual([{ shake: 0.5 }]);
    expect(named('playImpact').map(({ args }) => args[0])).toEqual([
      { material: 'wood', velocity: 2.8, pan: 0 },
    ]);
    expect(named('duckMusic')).toHaveLength(1);
  });

  it('strikes the fusion chime on impact, or at once without effects', () => {
    const { events, live, vfx, audio, named } = setup();
    live.audio = audio;
    const fusion = {
      sources: [{ x: 0, y: 0, z: 0 }],
      center: { x: 0, y: 0, z: 0 },
      tier: 'silver' as const,
      claimed: true,
    };
    events.emit('coin:fusion', fusion);
    expect(named('playImpact')).toHaveLength(1);
    live.vfx = vfx;
    events.emit('coin:fusion', fusion);
    expect(named('playImpact')).toHaveLength(1);
    const [shown] = named('fusion');
    (shown?.args[0] as { onImpact: () => void }).onImpact();
    expect(named('playImpact')).toHaveLength(2);
  });

  it('stops reacting once unwired', () => {
    const { events, live, vfx, stop, calls } = setup();
    live.vfx = vfx;
    stop();
    events.emit('nudge', { direction: 'left', strength: 1, source: 'key', tick: 0 });
    expect(calls).toEqual([]);
  });
});
