import type { NetMode } from './env.ts';
import { NetworkError } from './errors.ts';

export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TURNSTILE_SCRIPT_ID = 'coinposh-turnstile-api';

const ERROR_CODES_URL =
  'https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/';

/** The slice of Cloudflare's explicit-render API this loader drives. */
export interface TurnstileApi {
  render(container: HTMLElement, params: TurnstileRenderParams): string | null | undefined;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

export interface TurnstileRenderParams {
  readonly sitekey: string;
  readonly action: string;
  readonly execution: 'execute';
  readonly appearance: 'interaction-only';
  readonly theme: 'dark';
  readonly size: 'flexible';
  readonly language: string;
  readonly retry: 'never';
  readonly 'refresh-expired': 'manual';
  readonly callback: (token: string) => void;
  readonly 'error-callback': (code: string) => boolean;
  readonly 'expired-callback': () => void;
  readonly 'timeout-callback': () => void;
  readonly 'unsupported-callback': () => void;
  readonly 'before-interactive-callback': () => void;
  readonly 'after-interactive-callback': () => void;
}

export interface TurnstileWindow {
  turnstile?: TurnstileApi;
}

/**
 * Where the widget lives. It stays invisible while Cloudflare passes the player silently and is
 * shown only when Cloudflare asks for an interactive challenge.
 */
export interface TurnstileHost {
  readonly container: HTMLElement;
  challengeShown(): void;
  challengeHidden(): void;
  /** The check failed; the host may tell the player a retry follows. */
  failed(): void;
  dispose(): void;
}

export interface TurnstileOptions {
  readonly mode: NetMode;
  readonly siteKey: string | undefined;
  /** Created on the first token request, so nothing is mounted at boot. */
  readonly host: () => TurnstileHost;
  readonly language: () => string;
  readonly window?: TurnstileWindow;
  readonly document?: Document;
  readonly loadTimeoutMs?: number;
  /** How long Cloudflare may take to pass the player silently; paused while a challenge is shown. */
  readonly tokenTimeoutMs?: number;
}

export interface TurnstileTokens {
  /** One fresh, single-use token per call. Calls queue behind each other on the one widget. */
  token(): Promise<string>;
  dispose(): void;
}

export const TURNSTILE_ACTION = 'guest-signup';
const DEFAULT_LOAD_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

interface Pending {
  resolve(token: string): void;
  reject(error: Error): void;
}

export function createTurnstile(options: TurnstileOptions): TurnstileTokens {
  if (options.mode.kind === 'demo') {
    return {
      token: () =>
        Promise.reject(
          new Error(
            'CoinPosh net: Turnstile was asked for a token in Demo Mode. Demo sign-up uses local tokens; this is a wiring bug.',
          ),
        ),
      dispose: () => undefined,
    };
  }
  const siteKey = options.siteKey;
  if (siteKey === undefined) {
    throw new Error(
      'CoinPosh net: live mode needs VITE_TURNSTILE_SITE_KEY for guest sign-up. Rebuild with the Turnstile site key that matches the server TURNSTILE_SECRET_KEY.',
    );
  }
  const win = options.window ?? (window as TurnstileWindow);
  const doc = options.document ?? document;
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;

  let api: Promise<TurnstileApi> | null = null;
  let host: TurnstileHost | null = null;
  let widgetId: string | null = null;
  let pending: Pending | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const stopWatchdog = (): void => {
    clearTimeout(watchdog);
    watchdog = undefined;
  };
  const startWatchdog = (): void => {
    stopWatchdog();
    watchdog = setTimeout(() => {
      settle(
        new NetworkError(
          `CoinPosh net: Cloudflare Turnstile gave no token within ${tokenTimeoutMs} ms; guest sign-up will retry.`,
        ),
      );
    }, tokenTimeoutMs);
  };
  const settle = (outcome: string | Error): void => {
    const current = pending;
    if (current === null) return;
    pending = null;
    stopWatchdog();
    host?.challengeHidden();
    if (typeof outcome === 'string') {
      current.resolve(outcome);
      return;
    }
    host?.failed();
    current.reject(outcome);
  };

  const loadApi = (): Promise<TurnstileApi> => {
    api ??= new Promise<TurnstileApi>((resolve, reject) => {
      const ready = win.turnstile;
      if (ready) {
        resolve(ready);
        return;
      }
      doc.getElementById(TURNSTILE_SCRIPT_ID)?.remove();
      const script = doc.createElement('script');
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      const fail = (reason: string): void => {
        clearTimeout(timer);
        script.remove();
        api = null;
        reject(
          new NetworkError(
            `CoinPosh net: the Cloudflare Turnstile script ${reason} (${TURNSTILE_SCRIPT_URL}). Check the network or a content blocker; guest sign-up will retry.`,
          ),
        );
      };
      const timer = setTimeout(() => {
        fail(`did not load within ${loadTimeoutMs} ms`);
      }, loadTimeoutMs);
      script.addEventListener('load', () => {
        const loaded = win.turnstile;
        if (!loaded) {
          fail('loaded but did not define window.turnstile');
          return;
        }
        clearTimeout(timer);
        resolve(loaded);
      });
      script.addEventListener('error', () => {
        fail('failed to load');
      });
      doc.head.append(script);
    });
    return api;
  };

  const widget = (turnstile: TurnstileApi): string => {
    if (widgetId !== null) return widgetId;
    host ??= options.host();
    const id = turnstile.render(host.container, {
      sitekey: siteKey,
      action: TURNSTILE_ACTION,
      execution: 'execute',
      appearance: 'interaction-only',
      theme: 'dark',
      size: 'flexible',
      language: options.language(),
      retry: 'never',
      'refresh-expired': 'manual',
      callback: (token) => {
        settle(token);
      },
      // Returning true tells Turnstile the error is handled, so it neither retries nor logs it.
      'error-callback': (code) => {
        settle(
          new NetworkError(
            `CoinPosh net: Cloudflare Turnstile failed with error ${code} (${ERROR_CODES_URL}); guest sign-up will retry.`,
          ),
        );
        return true;
      },
      'expired-callback': () => {
        settle(
          new NetworkError(
            'CoinPosh net: the Cloudflare Turnstile token expired before sign-up used it; guest sign-up will retry.',
          ),
        );
      },
      'timeout-callback': () => {
        settle(
          new NetworkError(
            'CoinPosh net: the Cloudflare Turnstile challenge timed out before it was solved; guest sign-up will retry.',
          ),
        );
      },
      'unsupported-callback': () => {
        settle(
          new Error(
            'CoinPosh net: this browser is not supported by Cloudflare Turnstile, so live guest sign-up cannot run here.',
          ),
        );
      },
      'before-interactive-callback': () => {
        stopWatchdog();
        host?.challengeShown();
      },
      'after-interactive-callback': () => {
        host?.challengeHidden();
        if (pending !== null) startWatchdog();
      },
    });
    if (typeof id !== 'string' || id === '') {
      throw new Error(
        'CoinPosh net: Cloudflare Turnstile did not render a widget; check VITE_TURNSTILE_SITE_KEY and that this domain is allowed for it.',
      );
    }
    widgetId = id;
    return id;
  };

  const fresh = async (): Promise<string> => {
    const turnstile = await loadApi();
    if (disposed) throw new Error('CoinPosh net: Turnstile was disposed before a token arrived.');
    const id = widget(turnstile);
    try {
      return await new Promise<string>((resolve, reject) => {
        pending = { resolve, reject };
        startWatchdog();
        turnstile.execute(id);
      });
    } finally {
      // Tokens are single-use, so the widget is reset to be ready for the next sign-up.
      if (widgetId === id) turnstile.reset(id);
    }
  };

  return {
    token() {
      if (disposed) {
        return Promise.reject(
          new Error('CoinPosh net: Turnstile was asked for a token after dispose.'),
        );
      }
      const next = queue.then(fresh, fresh);
      queue = next.catch(() => undefined);
      return next;
    },
    dispose() {
      disposed = true;
      stopWatchdog();
      const waiting = pending;
      pending = null;
      waiting?.reject(new Error('CoinPosh net: Turnstile was disposed before a token arrived.'));
      const id = widgetId;
      widgetId = null;
      if (id !== null) {
        void api?.then((turnstile) => {
          turnstile.remove(id);
        });
      }
      host?.dispose();
      host = null;
    },
  };
}
