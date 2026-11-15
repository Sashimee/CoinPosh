import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type {
  ConciergeEvents,
  ConciergeHushReason,
  ConciergeLine,
  ConciergeLineId,
} from '../../game/concierge/index.ts';
import { wireConciergeStage, type ConciergeShowMode } from './stage.ts';

type Call = readonly ['show', ConciergeLineId, ConciergeShowMode] | readonly ['hide', string];

function line(lineId: ConciergeLineId, variant = 0): ConciergeLine {
  return {
    lineId,
    variant,
    expression: 'pleased',
    kind: 'remark',
    priority: 30,
    durationMs: 3400,
    params: {},
  };
}

function setup(initial: { current?: ConciergeLine | null; muted?: boolean } = {}) {
  const events = createBus<ConciergeEvents>();
  const calls: Call[] = [];
  const brain = {
    events,
    current: initial.current ?? null,
    muted: initial.muted ?? false,
    dismiss: () => undefined,
  };
  const dispose = wireConciergeStage(brain, {
    show: (said, mode) => calls.push(['show', said.lineId, mode]),
    hide: (reason: ConciergeHushReason) => calls.push(['hide', reason]),
  });
  return { events, calls, dispose };
}

const tick = (): Promise<void> => Promise.resolve();

describe('wireConciergeStage', () => {
  it('enters on a say and exits on its hush', () => {
    const { events, calls } = setup();
    events.emit('concierge:say', line('cascade.chic'));
    events.emit('concierge:hush', { lineId: 'cascade.chic', reason: 'done' });
    expect(calls).toEqual([
      ['show', 'cascade.chic', 'enter'],
      ['hide', 'done'],
    ]);
  });

  it('swaps the words on a cut-in instead of closing and reopening the card', async () => {
    const { events, calls } = setup();
    events.emit('concierge:say', line('cascade.chic'));
    events.emit('concierge:hush', { lineId: 'cascade.chic', reason: 'preempted' });
    events.emit('concierge:say', line('cascade.obscene'));
    await tick();
    expect(calls).toEqual([
      ['show', 'cascade.chic', 'enter'],
      ['show', 'cascade.obscene', 'swap'],
    ]);
  });

  it('closes after a preemption that no line follows', async () => {
    const { events, calls } = setup();
    events.emit('concierge:say', line('tip.idle'));
    events.emit('concierge:hush', { lineId: 'tip.idle', reason: 'preempted' });
    expect(calls).toHaveLength(1);
    await tick();
    expect(calls.at(-1)).toEqual(['hide', 'preempted']);
  });

  it('ignores a hush for a line that is not on the card', () => {
    const { events, calls } = setup();
    events.emit('concierge:say', line('tip.feedTower'));
    events.emit('concierge:hush', { lineId: 'cascade.chic', reason: 'done' });
    expect(calls).toEqual([['show', 'tip.feedTower', 'enter']]);
  });

  it('ignores a hush when nothing is showing', () => {
    const { events, calls } = setup();
    events.emit('concierge:hush', { lineId: 'cascade.chic', reason: 'dismissed' });
    expect(calls).toEqual([]);
  });

  it('closes when the player mutes the Concierge, once', () => {
    const { events, calls } = setup();
    events.emit('concierge:say', line('vault.empty'));
    events.emit('concierge:hush', { lineId: 'vault.empty', reason: 'muted' });
    events.emit('concierge:muted', { muted: true });
    expect(calls).toEqual([
      ['show', 'vault.empty', 'enter'],
      ['hide', 'muted'],
    ]);
  });

  it('closes on the muted event even if the hush went missing', () => {
    const { events, calls } = setup();
    events.emit('concierge:say', line('vault.empty'));
    events.emit('concierge:muted', { muted: true });
    expect(calls.at(-1)).toEqual(['hide', 'muted']);
  });

  it('shows a line already being said when it mounts, unless muted', () => {
    expect(setup({ current: line('crate.arrived') }).calls).toEqual([
      ['show', 'crate.arrived', 'enter'],
    ]);
    expect(setup({ current: line('crate.arrived'), muted: true }).calls).toEqual([]);
  });

  it('stops listening once disposed, including a pending preemption', async () => {
    const { events, calls, dispose } = setup();
    events.emit('concierge:say', line('tip.idle'));
    events.emit('concierge:hush', { lineId: 'tip.idle', reason: 'preempted' });
    dispose();
    events.emit('concierge:say', line('cascade.chic'));
    await tick();
    expect(calls).toEqual([['show', 'tip.idle', 'enter']]);
  });
});
