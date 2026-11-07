import type { WebGPURenderer } from 'three/webgpu';

export interface GpuFrameTimer {
  /** GPU milliseconds of the most recently resolved frame, or null while none is fresh. */
  readonly latestMs: number | null;
  /** Call right after each frame's render to queue the next timestamp readback. */
  afterRender(): void;
  dispose(): void;
}

/** Readbacks lag a few frames; a reading older than this is not trusted as current load. */
const STALE_FRAMES = 30;

export type TimestampRenderer = Pick<
  WebGPURenderer,
  'backend' | 'hasFeature' | 'resolveTimestampsAsync'
>;

/**
 * GPU frame time from timestamp queries, which is what dynamic resolution should react to.
 * Returns null when the renderer was not created with `trackTimestamp: true` or the device
 * lacks `timestamp-query` (WebGPU) / `EXT_disjoint_timer_query_webgl2` (WebGL2); callers
 * then fall back to frame intervals.
 */
export function createGpuFrameTimer(
  renderer: TimestampRenderer,
  logger: Pick<Console, 'warn'> = console,
): GpuFrameTimer | null {
  const backend: unknown = renderer.backend;
  const tracking =
    typeof backend === 'object' &&
    backend !== null &&
    'trackTimestamp' in backend &&
    backend.trackTimestamp === true;
  if (!tracking || !renderer.hasFeature('timestamp-query')) return null;

  let latest: number | null = null;
  let framesSinceReading = Number.POSITIVE_INFINITY;
  let pending = false;
  let alive = true;

  return {
    get latestMs() {
      return framesSinceReading <= STALE_FRAMES ? latest : null;
    },
    afterRender() {
      if (!alive) return;
      framesSinceReading++;
      if (pending) return;
      pending = true;
      renderer
        .resolveTimestampsAsync()
        .then((ms) => {
          if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
            latest = ms;
            framesSinceReading = 0;
          }
        })
        .catch((error: unknown) => {
          alive = false;
          latest = null;
          logger.warn(
            '[CoinPosh] GPU timestamp readback failed; dynamic resolution falls back to frame intervals',
            error,
          );
        })
        .finally(() => {
          pending = false;
        });
    },
    dispose() {
      alive = false;
      latest = null;
    },
  };
}
