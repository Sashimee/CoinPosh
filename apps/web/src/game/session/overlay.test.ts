import { describe, expect, it, vi } from 'vitest';
import type { FeedbackKind } from '../../app/state.ts';
import { createElsewhereOverlay, type ElsewhereView } from './overlay.ts';

function setup() {
  const drawn: string[] = [];
  const feedback: FeedbackKind[] = [];
  const failures: unknown[] = [];
  const view: ElsewhereView = {
    render: (phase) => drawn.push(phase),
    leave: () => drawn.push('leave'),
    dispose: () => drawn.push('dispose'),
  };
  let settle: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  const retake = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = { resolve, reject };
      }),
  );
  const overlay = createElsewhereOverlay({
    view,
    retake,
    feedback: (kind) => feedback.push(kind),
    onRetakeFailed: (error) => failures.push(error),
  });
  const answer = async (outcome: 'ok' | Error): Promise<void> => {
    const pending = settle;
    if (pending === null) throw new Error('no retake is running');
    if (outcome === 'ok') pending.resolve();
    else pending.reject(outcome);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { overlay, drawn, feedback, failures, retake, answer };
}

describe('createElsewhereOverlay', () => {
  it('opens once over the table, with the open cue', () => {
    const { overlay, drawn, feedback } = setup();
    expect(overlay.phase).toBe('hidden');
    overlay.show();
    overlay.show();
    expect(overlay.phase).toBe('open');
    expect(drawn).toEqual(['open']);
    expect(feedback).toEqual(['open']);
  });

  it('ignores "Play here" before it is shown', () => {
    const { overlay, retake } = setup();
    overlay.press();
    expect(retake).not.toHaveBeenCalled();
  });

  it('retakes the table once however often "Play here" is pressed, then leaves with the confirm cue', async () => {
    const { overlay, drawn, feedback, retake, answer } = setup();
    overlay.show();
    overlay.press();
    overlay.press();
    expect(retake).toHaveBeenCalledTimes(1);
    expect(overlay.phase).toBe('busy');
    await answer('ok');
    expect(overlay.phase).toBe('hidden');
    expect(drawn).toEqual(['open', 'busy', 'leave']);
    expect(feedback).toEqual(['open', 'tap', 'confirm']);
  });

  it('keeps the button up after a failed retake and lets the player try again', async () => {
    const { overlay, drawn, feedback, failures, retake, answer } = setup();
    overlay.show();
    overlay.press();
    const failure = new Error('CoinPosh net: the server did not answer');
    await answer(failure);
    expect(overlay.phase).toBe('failed');
    expect(failures).toEqual([failure]);
    expect(feedback.at(-1)).toBe('deny');
    overlay.press();
    expect(retake).toHaveBeenCalledTimes(2);
    await answer('ok');
    expect(drawn).toEqual(['open', 'busy', 'failed', 'busy', 'leave']);
  });

  it('opens again when the table is taken over a second time', async () => {
    const { overlay, drawn, answer } = setup();
    overlay.show();
    overlay.press();
    await answer('ok');
    overlay.show();
    expect(overlay.phase).toBe('open');
    expect(drawn.at(-1)).toBe('open');
  });

  it('does nothing with a retake that answers after it was disposed', async () => {
    const { overlay, drawn, feedback, failures, answer } = setup();
    overlay.show();
    overlay.press();
    overlay.dispose();
    await answer(new Error('late'));
    expect(drawn).toEqual(['open', 'busy', 'dispose']);
    expect(feedback).toEqual(['open', 'tap']);
    expect(failures).toEqual([]);
    overlay.show();
    expect(drawn).toHaveLength(3);
  });
});
