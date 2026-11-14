import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScratchCard } from './card.ts';
import type { ScratchSurface } from './surface.ts';
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

let doc: FakeDocument;
let open: ScratchCard | null = null;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function openCard(surface: () => Promise<ScratchSurface>, reducedMotion = false) {
  const card: ScratchCard = new ScratchCard({
    host: doc.body as unknown as HTMLElement,
    labels: LABELS,
    reducedMotion,
    onBegin: () => {
      queueMicrotask(() => {
        card.reveal(answer());
      });
    },
    surface,
  });
  open = card;
  const root = card.el as unknown as FakeElement;
  return { card, root, cta: root.find('scratch-cta') };
}

beforeEach(() => {
  doc = installFakeDom();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  open?.dispose();
  open = null;
  runFrames(1);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a scratch card with no foil', () => {
  it('fades its cover and settles on the prize the house already paid', async () => {
    const { card, root, cta } = openCard(() => Promise.reject(new Error('no GPU, no 2D canvas')));
    await settle();
    expect(root.dataset.foil).toBe('none');
    expect(console.error).toHaveBeenCalledOnce();

    cta.click();
    await settle();
    expect(card.phase).toBe('clearing');
    expect(cta.disabled).toBe(true);

    runFrames(30);
    expect(Number(root.style['--cp-scratch-cover'])).toBeLessThan(1);
    runFrames(400);
    expect(card.phase).toBe('settled');
    expect(root.style['--cp-scratch-cover']).toBe('0');
    expect(cta.textContent).toBe(LABELS.collect);
    expect(cta.disabled).toBe(false);
  });

  it('clears straight away when the foil fails after the grid is in', async () => {
    const surface = deferred<ScratchSurface>();
    const { card, cta } = openCard(() => surface.promise, true);
    cta.click();
    await settle();
    expect(card.phase).toBe('scratching');

    surface.reject(new Error('context lost'));
    await settle();
    expect(card.phase).toBe('clearing');
    runFrames(400);
    expect(card.phase).toBe('settled');
  });

  it('frees a surface that starts after the card has closed', async () => {
    const surface = deferred<ScratchSurface>();
    const { card } = openCard(() => surface.promise);
    card.dispose();
    const late = new FakeSurface(doc);
    surface.resolve(late);
    await settle();
    expect(late.disposed).toBe(true);
  });
});

describe('reveal all before the foil is up', () => {
  it('holds the button and sweeps as soon as the foil starts', async () => {
    const surface = deferred<ScratchSurface>();
    const { card, cta } = openCard(() => surface.promise);
    cta.click();
    await settle();
    expect(card.phase).toBe('scratching');
    expect(cta.disabled).toBe(false);

    cta.click();
    expect(card.phase).toBe('scratching');
    expect(cta.disabled).toBe(true);

    surface.resolve(new FakeSurface(doc));
    await settle();
    expect(card.ready).toBe(true);
    expect(card.phase).toBe('sweeping');
    runFrames(600);
    expect(card.phase).toBe('settled');
  });

  it('fades at once on reduced motion', async () => {
    const surface = deferred<ScratchSurface>();
    const { card, cta } = openCard(() => surface.promise, true);
    cta.click();
    await settle();
    card.revealAll();
    expect(card.phase).toBe('scratching');

    const foil = new FakeSurface(doc);
    surface.resolve(foil);
    await settle();
    expect(card.phase).toBe('clearing');
    runFrames(60);
    expect(foil.clear).toBeGreaterThan(0);
  });
});
