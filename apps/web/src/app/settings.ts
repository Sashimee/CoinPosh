import { DEFAULT_VOLUMES, type MixerBus, type MixerVolumes } from '../audio/index.ts';
import { isLanguage, type Language } from '../i18n/index.ts';

export const SETTINGS_STORAGE_KEY = 'coinposh.settings.v1';

export const MIXER_BUSES: readonly MixerBus[] = ['master', 'music', 'sfx'];
export const QUALITY_OPTIONS = ['auto', 'low', 'high'] as const;
export type QualitySetting = (typeof QUALITY_OPTIONS)[number];
export const MOTION_OPTIONS = ['system', 'reduced', 'full'] as const;
export type MotionSetting = (typeof MOTION_OPTIONS)[number];

export interface Settings {
  readonly volumes: MixerVolumes;
  readonly mono: boolean;
  readonly haptics: boolean;
  readonly motion: MotionSetting;
  readonly quality: QualitySetting;
  readonly language: Language;
}

export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function defaultSettings(language: Language): Settings {
  return {
    volumes: { ...DEFAULT_VOLUMES },
    mono: false,
    haptics: true,
    motion: 'system',
    quality: 'auto',
    language,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export interface ParsedSettings {
  readonly settings: Settings;
  /** Fields that were present but invalid, so they fell back to defaults. */
  readonly rejected: readonly string[];
}

/** Validates persisted settings field by field: one bad field never discards the rest. */
export function parseSettings(raw: unknown, defaults: Settings): ParsedSettings {
  if (!isRecord(raw)) return { settings: defaults, rejected: raw === undefined ? [] : ['root'] };
  const rejected: string[] = [];
  const pick = <T>(key: string, valid: (value: unknown) => value is T, fallback: T): T => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (valid(value)) return value;
    rejected.push(key);
    return fallback;
  };

  const rawVolumes = raw.volumes;
  const volumes: Record<MixerBus, number> = { ...defaults.volumes };
  if (isRecord(rawVolumes)) {
    for (const bus of MIXER_BUSES) {
      const value = rawVolumes[bus];
      if (value === undefined) continue;
      if (isUnitInterval(value)) volumes[bus] = value;
      else rejected.push(`volumes.${bus}`);
    }
  } else if (rawVolumes !== undefined) {
    rejected.push('volumes');
  }

  const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
  return {
    settings: {
      volumes,
      mono: pick('mono', isBoolean, defaults.mono),
      haptics: pick('haptics', isBoolean, defaults.haptics),
      motion: pick('motion', (v): v is MotionSetting => oneOf(MOTION_OPTIONS, v), defaults.motion),
      quality: pick(
        'quality',
        (v): v is QualitySetting => oneOf(QUALITY_OPTIONS, v),
        defaults.quality,
      ),
      language: pick('language', isLanguage, defaults.language),
    },
    rejected,
  };
}

export function loadSettings(storage: SettingsStorage | null, defaults: Settings): Settings {
  if (!storage) return defaults;
  let text: string | null;
  try {
    text = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch (error) {
    console.warn('[CoinPosh] settings could not be read; using defaults this session', error);
    return defaults;
  }
  if (text === null) return defaults;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.warn(
      `[CoinPosh] saved settings are not valid JSON; resetting "${SETTINGS_STORAGE_KEY}"`,
    );
    return defaults;
  }
  const { settings, rejected } = parseSettings(raw, defaults);
  if (rejected.length > 0) {
    console.warn(`[CoinPosh] ignored invalid saved settings: ${rejected.join(', ')}`);
  }
  return settings;
}

/** Returns false when the browser refuses the write (private mode, quota). */
export function saveSettings(storage: SettingsStorage | null, settings: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn('[CoinPosh] settings could not be saved; they will reset on reload', error);
    return false;
  }
}

export function browserStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (error) {
    console.warn('[CoinPosh] localStorage is blocked; settings will not persist', error);
    return null;
  }
}

export function sameSettings(a: Settings, b: Settings): boolean {
  return (
    a.mono === b.mono &&
    a.haptics === b.haptics &&
    a.motion === b.motion &&
    a.quality === b.quality &&
    a.language === b.language &&
    MIXER_BUSES.every((bus) => a.volumes[bus] === b.volumes[bus])
  );
}

export type UiQuality = 'low' | 'high';

export interface DeviceHints {
  readonly cores?: number;
  readonly memoryGb?: number;
}

const LOW_TIER_MAX_CORES = 4;
const LOW_TIER_MAX_MEMORY_GB = 4;

export function resolveUiQuality(setting: QualitySetting, device: DeviceHints): UiQuality {
  if (setting !== 'auto') return setting;
  const fewCores = device.cores !== undefined && device.cores <= LOW_TIER_MAX_CORES;
  const littleMemory = device.memoryGb !== undefined && device.memoryGb <= LOW_TIER_MAX_MEMORY_GB;
  return fewCores || littleMemory ? 'low' : 'high';
}

export function browserDeviceHints(): DeviceHints {
  if (typeof navigator === 'undefined') return {};
  // deviceMemory is Chromium-only and missing from lib.dom.
  const { deviceMemory } = navigator as Navigator & { readonly deviceMemory?: number };
  return deviceMemory === undefined
    ? { cores: navigator.hardwareConcurrency }
    : { cores: navigator.hardwareConcurrency, memoryGb: deviceMemory };
}

export interface SettingsSaver {
  readonly schedule: (settings: Settings) => void;
  /** Writes a pending save now; call before the page goes away. */
  readonly flush: () => void;
}

/** Coalesces bursts (a dragged volume slider) into one storage write after `delayMs` of quiet. */
export function createSettingsSaver(storage: SettingsStorage | null, delayMs = 250): SettingsSaver {
  let pending: Settings | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const flush = (): void => {
    clear();
    if (pending === null) return;
    const settings = pending;
    pending = null;
    saveSettings(storage, settings);
  };
  return {
    schedule(settings) {
      pending = settings;
      clear();
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}
