import { describe, expect, it } from 'vitest';
import type { Scheduler } from './connectivity.ts';
import { createNet } from './index.ts';

const manualScheduler: Scheduler = { setTimeout: () => ({}), clearTimeout: () => undefined };

function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

describe('createNet in Demo Mode', () => {
  it('boots against the in-browser server through the same client, without Turnstile', async () => {
    const net = await createNet({
      mode: { kind: 'demo' },
      locale: () => 'fr',
      turnstileToken: () => Promise.reject(new Error('Demo Mode must not ask for Turnstile.')),
      onError: rethrow,
      scheduler: manualScheduler,
      monotonic: () => 0,
    });
    expect(net.mock).not.toBeNull();
    const state = await net.client.call('state');
    expect(state.table.buffer.length).toBeGreaterThan(0);
    net.table.hydrate(state);
    await net.table.flush();
    expect(net.table.balance?.wallet).toEqual(state.wallet);
    expect(net.session.playerId).not.toBeNull();
    expect(net.clock.now()).toBe(state.serverTime);
    net.table.close();
  });
});
