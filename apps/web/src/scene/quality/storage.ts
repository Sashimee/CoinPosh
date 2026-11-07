import type { RenderBackend } from '../../backend.ts';
import { isQualityTier, type QualityTier } from './tiers.ts';

export const QUALITY_STORAGE_KEY = 'coinposh.quality.v1';

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export interface StoredQuality {
  readonly tier: QualityTier;
  readonly backend: RenderBackend;
  /** Median milliseconds per frame the first-boot benchmark measured, or null if a downgrade wrote it. */
  readonly benchmarkMs: number | null;
}

export interface QualityStorageLogger {
  warn(message: string, error?: unknown): void;
}

/** Storage can be missing or throw (private mode, blocked site data); the tier then lives only in memory. */
export function browserStore(logger: QualityStorageLogger = console): KeyValueStore | null {
  try {
    return globalThis.localStorage;
  } catch (error) {
    logger.warn('[CoinPosh] localStorage is unavailable, the quality tier will not persist', error);
    return null;
  }
}

export function loadQuality(
  store: KeyValueStore | null,
  backend: RenderBackend,
  logger: QualityStorageLogger = console,
): StoredQuality | null {
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(QUALITY_STORAGE_KEY);
  } catch (error) {
    logger.warn(
      '[CoinPosh] Reading the saved quality tier failed, re-running the benchmark',
      error,
    );
    return null;
  }
  if (raw === null) return null;
  const parsed = parseStoredQuality(raw);
  if (parsed === null) {
    logger.warn('[CoinPosh] The saved quality tier is malformed, re-running the benchmark');
    return null;
  }
  return parsed.backend === backend ? parsed : null;
}

export function saveQuality(
  store: KeyValueStore | null,
  value: StoredQuality,
  logger: QualityStorageLogger = console,
): boolean {
  if (store === null) return false;
  try {
    store.setItem(QUALITY_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch (error) {
    logger.warn(
      '[CoinPosh] Saving the quality tier failed, it will be re-measured next boot',
      error,
    );
    return false;
  }
}

function parseStoredQuality(raw: string): StoredQuality | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { tier, backend, benchmarkMs } = record;
  if (!isQualityTier(tier)) return null;
  if (backend !== 'webgpu' && backend !== 'webgl2') return null;
  if (benchmarkMs !== null && (typeof benchmarkMs !== 'number' || !Number.isFinite(benchmarkMs))) {
    return null;
  }
  return { tier, backend, benchmarkMs };
}
