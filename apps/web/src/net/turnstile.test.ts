import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRetryable } from './errors.ts';
import {
  TURNSTILE_SCRIPT_ID,
  TURNSTILE_SCRIPT_URL,
  createTurnstile,
  type TurnstileApi,
  type TurnstileHost,
  type TurnstileRenderParams,
  type TurnstileWindow,
} from './turnstile.ts';

const LIVE = { kind: 'live', apiUrl: 'https://api.example.com' } as const;
const SITE_KEY = '1x00000000000000000000AA';

class FakeScript {
  id = '';
  src = '';
  async = false;
  parent: FakeHead | null = null;
  readonly listeners = new Map<string, () => void>();

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  fire(type: 'load' | 'error'): void {
    this.listeners.get(type)?.();
  }

  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

class FakeHead {
  readonly children: FakeScript[] = [];

  append(script: FakeScript): void {
    script.parent = this;
    this.children.push(script);
  }
}

function fakeDocument() {
  const head = new FakeHead();
  const doc = {
    head,
    createElement: vi.fn(() => new FakeScript()),
    getElementById: (id: string) => head.children.find((child) => child.id === id) ?? null,
  };
  return { head, doc, document: doc as unknown as Document };
}

/**
 * Behaves like Cloudflare's widget: a widget holding an unused token refuses to execute until it
 * is reset, and each execution yields a different token.
 */
class FakeTurnstile implements TurnstileApi {
  params: TurnstileRenderParams | null = null;
  readonly renders: HTMLElement[] = [];
  executions = 0;
  resets = 0;
  removed: string[] = [];
  holdsToken = false;
  /** What the next execute does; `pass` issues a token on a later microtask. */
  next: 'pass' | 'hold' = 'pass';

  render(container: HTMLElement, params: TurnstileRenderParams): string {
    this.renders.push(container);
    this.params = params;
    return 'widget-1';
  }

  execute(): void {
    if (this.holdsToken) throw new Error('fake turnstile: execute before reset');
    this.executions += 1;
    const token = `token-${this.executions}`;
    if (this.next === 'pass') {
      queueMicrotask(() => {
        this.holdsToken = true;
        this.params?.callback(token);
      });
    }
  }

  reset(): void {
    this.resets += 1;
    this.holdsToken = false;
  }

  remove(id: string): void {
    this.removed.push(id);
  }
}

function fakeHost() {
  const container = {} as HTMLElement;
  const host = {
    container,
    challengeShown: vi.fn(),
    challengeHidden: vi.fn(),
    failed: vi.fn(),
    dispose: vi.fn(),
  } satisfies TurnstileHost;
  return host;
}

function setup(options: { loaded?: boolean; tokenTimeoutMs?: number } = {}) {
  const api = new FakeTurnstile();
  const win: TurnstileWindow = options.loaded === false ? {} : { turnstile: api };
  const dom = fakeDocument();
  const host = fakeHost();
  const makeHost = vi.fn(() => host);
  const turnstile = createTurnstile({
    mode: LIVE,
    siteKey: SITE_KEY,
    host: makeHost,
    language: () => 'fr',
    window: win,
    document: dom.document,
    loadTimeoutMs: 1000,
    tokenTimeoutMs: options.tokenTimeoutMs ?? 5000,
  });
  return { api, win, dom, host, makeHost, turnstile };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createTurnstile in Demo Mode', () => {
  it('never injects the script, mounts a host or touches the window', async () => {
    const dom = fakeDocument();
    const makeHost = vi.fn(fakeHost);
    const win: TurnstileWindow = {};
    const turnstile = createTurnstile({
      mode: { kind: 'demo' },
      siteKey: undefined,
      host: makeHost,
      language: () => 'en',
      window: win,
      document: dom.document,
    });
    await expect(turnstile.token()).rejects.toThrow(/Demo Mode/);
    turnstile.dispose();
    expect(dom.doc.createElement).not.toHaveBeenCalled();
    expect(dom.head.children).toHaveLength(0);
    expect(makeHost).not.toHaveBeenCalled();
  });
});

describe('createTurnstile in live mode', () => {
  it('refuses to start without a site key', () => {
    expect(() =>
      createTurnstile({
        mode: LIVE,
        siteKey: undefined,
        host: fakeHost,
        language: () => 'en',
        window: {},
        document: fakeDocument().document,
      }),
    ).toThrow(/VITE_TURNSTILE_SITE_KEY/);
  });

  it('does nothing at creation: no script and no host until a token is asked for', () => {
    const { dom, makeHost } = setup({ loaded: false });
    expect(dom.head.children).toHaveLength(0);
    expect(makeHost).not.toHaveBeenCalled();
  });

  it('lazily injects the explicit-render script once and renders a managed, invisible widget', async () => {
    const { api, win, dom, host, turnstile } = setup({ loaded: false });
    const first = turnstile.token();
    await vi.waitFor(() => {
      expect(dom.head.children).toHaveLength(1);
    });
    expect(dom.head.children).toHaveLength(1);
    const script = dom.head.children[0];
    expect(script?.id).toBe(TURNSTILE_SCRIPT_ID);
    expect(script?.src).toBe(TURNSTILE_SCRIPT_URL);
    expect(script?.src).toContain('render=explicit');
    win.turnstile = api;
    script?.fire('load');
    await expect(first).resolves.toBe('token-1');
    expect(api.renders).toEqual([host.container]);
    expect(api.params).toMatchObject({
      sitekey: SITE_KEY,
      execution: 'execute',
      appearance: 'interaction-only',
      language: 'fr',
      retry: 'never',
    });
    await expect(turnstile.token()).resolves.toBe('token-2');
    expect(dom.head.children).toHaveLength(1);
    expect(api.renders).toHaveLength(1);
  });

  it('gives one fresh token per call and resets the widget after every token', async () => {
    const { api, turnstile } = setup();
    await expect(turnstile.token()).resolves.toBe('token-1');
    expect(api.resets).toBe(1);
    await expect(turnstile.token()).resolves.toBe('token-2');
    expect(api.resets).toBe(2);
    expect(api.executions).toBe(2);
  });

  it('queues concurrent calls on the one widget, each with its own token', async () => {
    const { turnstile } = setup();
    const tokens = await Promise.all([turnstile.token(), turnstile.token(), turnstile.token()]);
    expect(tokens).toEqual(['token-1', 'token-2', 'token-3']);
  });

  it('rejects on a widget error, tells the host, and recovers with a fresh token', async () => {
    const { api, host, turnstile } = setup();
    api.next = 'hold';
    const failing = turnstile.token();
    await vi.waitFor(() => {
      expect(api.executions).toBe(1);
    });
    expect(api.params?.['error-callback']('300030')).toBe(true);
    await expect(failing).rejects.toThrow(/error 300030/);
    expect(host.failed).toHaveBeenCalledTimes(1);
    expect(api.resets).toBe(1);
    api.next = 'pass';
    await expect(turnstile.token()).resolves.toBe('token-2');
  });

  it('rejects when the token expires or the challenge times out', async () => {
    const { api, turnstile } = setup();
    api.next = 'hold';
    const expiring = turnstile.token();
    await vi.waitFor(() => {
      expect(api.executions).toBe(1);
    });
    api.params?.['expired-callback']();
    await expect(expiring).rejects.toThrow(/expired/);

    const timing = turnstile.token();
    await vi.waitFor(() => {
      expect(api.executions).toBe(2);
    });
    api.params?.['timeout-callback']();
    await expect(timing).rejects.toThrow(/timed out/);
    expect(api.resets).toBe(2);
  });

  it('rejects when Cloudflare stays silent past the token timeout', async () => {
    vi.useFakeTimers();
    const { api, turnstile } = setup({ tokenTimeoutMs: 3000 });
    api.next = 'hold';
    const silent = turnstile.token();
    const outcome = expect(silent).rejects.toThrow(/within 3000 ms/);
    await vi.advanceTimersByTimeAsync(3000);
    await outcome;
    expect(api.resets).toBe(1);
  });

  it('shows the host during an interactive challenge and pauses the timeout meanwhile', async () => {
    vi.useFakeTimers();
    const { api, host, turnstile } = setup({ tokenTimeoutMs: 3000 });
    api.next = 'hold';
    const solving = turnstile.token();
    await vi.advanceTimersByTimeAsync(0);
    api.params?.['before-interactive-callback']();
    expect(host.challengeShown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    api.params?.['after-interactive-callback']();
    api.params?.callback('solved-token');
    await expect(solving).resolves.toBe('solved-token');
    expect(host.challengeHidden).toHaveBeenCalled();
    expect(host.failed).not.toHaveBeenCalled();
  });

  it('rejects clearly when the script fails to load, then retries the download', async () => {
    const { api, win, dom, turnstile } = setup({ loaded: false });
    const first = turnstile.token();
    await vi.waitFor(() => {
      expect(dom.head.children).toHaveLength(1);
    });
    dom.head.children[0]?.fire('error');
    await expect(first).rejects.toThrow(/challenges\.cloudflare\.com/);
    expect(dom.head.children).toHaveLength(0);

    const second = turnstile.token();
    await vi.waitFor(() => {
      expect(dom.head.children).toHaveLength(1);
    });
    win.turnstile = api;
    dom.head.children[0]?.fire('load');
    await expect(second).resolves.toBe('token-1');
  });

  it('rejects when the script loads without defining window.turnstile', async () => {
    const { dom, turnstile } = setup({ loaded: false });
    const first = turnstile.token();
    await vi.waitFor(() => {
      expect(dom.head.children).toHaveLength(1);
    });
    dom.head.children[0]?.fire('load');
    await expect(first).rejects.toThrow(/window\.turnstile/);
  });

  it('rejects when the script never loads', async () => {
    vi.useFakeTimers();
    const { turnstile } = setup({ loaded: false });
    const first = turnstile.token();
    const outcome = expect(first).rejects.toThrow(/did not load within 1000 ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });

  it('dispose rejects a waiting call, removes the widget and the host, and refuses new calls', async () => {
    const { api, host, turnstile } = setup();
    api.next = 'hold';
    const waiting = turnstile.token();
    await vi.waitFor(() => {
      expect(api.executions).toBe(1);
    });
    turnstile.dispose();
    await expect(waiting).rejects.toThrow(/disposed/);
    await vi.waitFor(() => {
      expect(api.removed).toEqual(['widget-1']);
    });
    expect(host.dispose).toHaveBeenCalledTimes(1);
    expect(host.failed).not.toHaveBeenCalled();
    await expect(turnstile.token()).rejects.toThrow(/after dispose/);
  });
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the token request to reject');
}

async function heldToken(callback: (params: TurnstileRenderParams) => void): Promise<unknown> {
  const { api, turnstile } = setup();
  api.next = 'hold';
  const pending = turnstile.token();
  await vi.waitFor(() => {
    expect(api.executions).toBe(1);
  });
  if (api.params === null) throw new Error('fake turnstile: widget was not rendered');
  callback(api.params);
  return rejectionOf(pending);
}

describe('createTurnstile failures and retry', () => {
  it.each([
    [
      'error-callback',
      (params: TurnstileRenderParams) => {
        params['error-callback']('300030');
      },
    ],
    [
      'expired-callback',
      (params: TurnstileRenderParams) => {
        params['expired-callback']();
      },
    ],
    [
      'timeout-callback',
      (params: TurnstileRenderParams) => {
        params['timeout-callback']();
      },
    ],
  ])('treats %s as transient so the queued request backs off', async (_name, fire) => {
    expect(isRetryable(await heldToken(fire))).toBe(true);
  });

  it('treats the token watchdog as transient', async () => {
    vi.useFakeTimers();
    const { api, turnstile } = setup({ tokenTimeoutMs: 3000 });
    api.next = 'hold';
    const rejection = rejectionOf(turnstile.token());
    await vi.advanceTimersByTimeAsync(3000);
    expect(isRetryable(await rejection)).toBe(true);
  });

  it('treats a script load error as transient', async () => {
    const { dom, turnstile } = setup({ loaded: false });
    const rejection = rejectionOf(turnstile.token());
    await vi.waitFor(() => {
      expect(dom.head.children).toHaveLength(1);
    });
    dom.head.children[0]?.fire('error');
    expect(isRetryable(await rejection)).toBe(true);
  });

  it('treats a script load timeout as transient', async () => {
    vi.useFakeTimers();
    const { turnstile } = setup({ loaded: false });
    const rejection = rejectionOf(turnstile.token());
    await vi.advanceTimersByTimeAsync(1000);
    expect(isRetryable(await rejection)).toBe(true);
  });

  it('does not retry an unsupported browser', async () => {
    const error = await heldToken((params) => {
      params['unsupported-callback']();
    });
    expect(error).toBeInstanceOf(Error);
    expect(isRetryable(error)).toBe(false);
  });

  it('does not retry when Cloudflare renders no widget', async () => {
    const { api, turnstile } = setup();
    const asApi: TurnstileApi = api;
    vi.spyOn(asApi, 'render').mockReturnValue(null);
    const error = await rejectionOf(turnstile.token());
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/did not render a widget/);
    expect(isRetryable(error)).toBe(false);
  });
});
