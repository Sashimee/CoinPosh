export type CoinBackend = 'webgpu' | 'webgl2';

export interface CoinGpuLoss {
  readonly backend: CoinBackend;
  readonly source: 'device-lost' | 'context-lost' | 'error-scope';
  readonly message: string;
  readonly reason: string | null;
}

interface DeviceLostInfo {
  readonly api: 'WebGL' | 'WebGPU';
  readonly message: string;
  readonly reason: string | null;
  readonly originalEvent: unknown;
}

interface LossInfoLike {
  readonly message?: string;
  readonly reason?: string;
}

/** The slice of WebGPURenderer the watcher touches, so tests can hand in a stand-in. */
export interface WatchableRenderer {
  onDeviceLost: (info: DeviceLostInfo) => void;
  readonly backend: unknown;
}

export interface GpuLossWatch {
  readonly backend: CoinBackend;
  readonly loss: CoinGpuLoss | null;
  /**
   * Detaches the hooks. Call it before `renderer.dispose()`, which destroys the device on
   * purpose. After a reported loss, stale lost-device rejections stay silenced.
   */
  stop(): void;
}

export interface GpuLossWatchOptions {
  /**
   * Where unhandled promise rejections surface (`window` in the browser). On WebGPU, three.js
   * leaves `popErrorScope()` rejections unhandled when the device dies mid pipeline build, and
   * that rejection can arrive before `device.lost` settles, so it counts as a loss signal.
   */
  readonly rejections?: EventTarget;
}

const LOST_DEVICE_REJECTION = /popErrorScope|Instance dropped|device (is )?lost/i;

export function coinBackend(renderer: { readonly backend: unknown }): CoinBackend {
  const backend = renderer.backend as { isWebGPUBackend?: boolean } | null;
  return backend?.isWebGPUBackend === true ? 'webgpu' : 'webgl2';
}

const BACKEND_LABEL: Record<CoinBackend, string> = { webgpu: 'WebGPU', webgl2: 'WebGL2' };

/** One log line a player-support engineer can act on: what died, why, and what happens next. */
export function describeGpuLoss(loss: CoinGpuLoss, next: CoinBackend | 'reload'): string {
  const reason = loss.reason ? ` (reason: ${loss.reason})` : '';
  const outcome =
    next === 'reload'
      ? 'Coin rendering has stopped; the page must be reloaded.'
      : `Rebuilding the coin field on ${BACKEND_LABEL[next]}.`;
  const message = loss.message.replace(/[.\s]+$/, '');
  return `[coins] ${BACKEND_LABEL[loss.backend]} ${loss.source}${reason}: ${message}. ${outcome}`;
}

function rejectionMessage(event: Event): string | null {
  const reason = (event as Event & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === 'string' ? reason : null;
}

/**
 * Reports the first GPU loss on `renderer` to `onLost`, exactly once, from whichever signal
 * arrives first: three.js's `onDeviceLost` (WebGL context loss, WebGPU device loss), the raw
 * `GPUDevice.lost` promise (three.js drops losses whose reason is "destroyed", which is also
 * what headless software adapters report), or an unhandled lost-device rejection. The watcher
 * replaces three.js's default `onDeviceLost`, which only logs, so the owner of the render loop
 * decides what to do next and logs it with `describeGpuLoss`.
 */
export function watchGpuLoss(
  renderer: WatchableRenderer,
  onLost: (loss: CoinGpuLoss) => void,
  options: GpuLossWatchOptions = {},
): GpuLossWatch {
  const backend = coinBackend(renderer);
  const previousHandler = renderer.onDeviceLost;
  let loss: CoinGpuLoss | null = null;
  let stopped = false;

  const report = (next: CoinGpuLoss): void => {
    if (stopped || loss) return;
    loss = next;
    onLost(next);
  };

  renderer.onDeviceLost = (info) => {
    report({
      backend,
      source: info.api === 'WebGL' ? 'context-lost' : 'device-lost',
      message: info.message,
      reason: info.reason,
    });
  };

  const device = (renderer.backend as { device?: { lost?: Promise<LossInfoLike> } } | null)?.device;
  if (backend === 'webgpu' && device?.lost) {
    void device.lost.then((info) => {
      report({
        backend,
        source: 'device-lost',
        message: info.message?.trim() ? info.message : 'GPUDevice.lost resolved without a message',
        reason: info.reason ?? null,
      });
    });
  }

  const onRejection = (event: Event): void => {
    const message = rejectionMessage(event);
    if (message === null || !LOST_DEVICE_REJECTION.test(message)) return;
    event.preventDefault();
    report({ backend, source: 'error-scope', message, reason: null });
  };
  if (backend === 'webgpu') options.rejections?.addEventListener('unhandledrejection', onRejection);

  return {
    backend,
    get loss() {
      return loss;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      renderer.onDeviceLost = previousHandler;
      // A dead device keeps rejecting in-flight pipeline builds after its owner moves on, and
      // those were already accounted for by the reported loss.
      if (!loss) options.rejections?.removeEventListener('unhandledrejection', onRejection);
    },
  };
}

interface WebGL2Canvas {
  getContext(id: 'webgl2', attributes?: WebGLContextAttributes): WebGL2RenderingContext | null;
}

export interface WebGL2ContextOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What three.js's WebGL backend asks for with `antialias: true` and default depth/stencil. */
export const COIN_WEBGL2_ATTRIBUTES: WebGLContextAttributes = {
  antialias: true,
  alpha: true,
  depth: true,
  stencil: false,
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gets a WebGL2 context on a fresh canvas from `makeCanvas`, retrying with a linear backoff.
 * When Chromium loses a WebGPU device it may restart the GPU process, and for a few seconds
 * every `getContext('webgl2')` returns null; three.js would then crash inside its backend
 * init. Pass the result to `new WebGPURenderer({ canvas, context, forceWebGL: true })`.
 */
export async function acquireWebGL2Context<C extends WebGL2Canvas>(
  makeCanvas: () => C,
  options: WebGL2ContextOptions = {},
): Promise<{ canvas: C; context: WebGL2RenderingContext; attempt: number }> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 300;
  const sleep = options.sleep ?? wait;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`acquireWebGL2Context: attempts must be a positive integer, got ${attempts}`);
  }
  let waited = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const canvas = makeCanvas();
    const context = canvas.getContext('webgl2', COIN_WEBGL2_ATTRIBUTES);
    if (context) return { canvas, context, attempt };
    if (attempt < attempts) {
      await sleep(delayMs * attempt);
      waited += delayMs * attempt;
    }
  }
  throw new Error(
    `[coins] WebGL2 is unavailable after ${attempts} attempts over ${waited} ms; the GPU ` +
      'process is likely down or WebGL is disabled. Reload the page, or check chrome://gpu.',
  );
}
