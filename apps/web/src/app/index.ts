import '../ui/styles.css';
import type { AudioEngine } from '../audio/index.ts';
import { detectLanguage, i18n as appI18n, type I18n } from '../i18n/index.ts';
import type { Hud } from '../ui/hud.ts';
import { createHud } from '../ui/hud.ts';
import { Localizer } from '../ui/localize.ts';
import {
  isReducedMotion,
  onReducedMotionChange,
  setMotionPreference,
} from '../ui/motion/reduced.ts';
import { applyTheme, rivieraThemeVariables } from '../ui/theme.ts';
import { bindAudioSettings, type AudioSettingsTarget } from './audioSettings.ts';
import { createBus, type Bus } from './bus.ts';
import { bindFeedback, browserVibrate, type FeedbackTargets } from './feedback.ts';
import type { DecorumState, Wallet } from './model.ts';
import {
  browserStorage,
  defaultSettings,
  loadSettings,
  saveSettings,
  sameSettings,
  type Settings,
  type SettingsStorage,
} from './settings.ts';
import { initialUiState, type UiEvents, type UiState } from './state.ts';
import { createStore, watch, type Store } from './store.ts';

export type UiAudio = AudioSettingsTarget & Pick<AudioEngine, 'playImpact'>;

export interface MountOptions {
  /** Element laid over the canvas; the UI fills it and only captures pointers on its controls. */
  readonly root: HTMLElement;
  /** Can also arrive later through `attachAudio`, once a gesture has unlocked Web Audio. */
  readonly audio?: UiAudio | null;
  readonly storage?: SettingsStorage | null;
  readonly i18n?: I18n;
  /** Browser language preferences used when nothing is saved yet. */
  readonly languages?: readonly string[];
  readonly vibrate?: FeedbackTargets['vibrate'];
}

export interface UpgradeRequest {
  readonly lineId: string;
  readonly fromLevel: number;
}

export interface UiApp {
  readonly store: Store<UiState>;
  readonly bus: Bus<UiEvents>;
  readonly i18n: I18n;
  readonly bannerSlot: HTMLElement;
  readonly settings: Settings;
  attachAudio(audio: UiAudio | null): void;
  /** Balances exactly as the server (or the Demo Mode mock) reported them. */
  setWallet(wallet: Wallet & { readonly provisional?: boolean }): void;
  setCascade(count: number): void;
  setDecorum(decorum: DecorumState): void;
  setUpgradeLevels(levels: Readonly<Record<string, number>>): void;
  /** Ends the pending purchase; pass the server-confirmed levels when it succeeded. */
  resolveUpgrade(levels?: Readonly<Record<string, number>>): void;
  onUpgradeRequest(handler: (request: UpgradeRequest) => void): () => void;
  onSettingsChange(handler: (settings: Settings) => void): () => void;
  dispose(): void;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

function requireCount(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number ≥ 0, got ${value}`);
  }
  return value;
}

export function mountApp(options: MountOptions): UiApp {
  const i18n = options.i18n ?? appI18n;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const defaults = defaultSettings(detectLanguage(options.languages ?? browserLanguages()));
  const settings = loadSettings(storage, defaults);
  i18n.changeLanguage(settings.language);
  setMotionPreference(settings.motion);

  const store = createStore<UiState>(initialUiState(settings));
  const bus = createBus<UiEvents>();
  const disposers: (() => void)[] = [];
  const loc = new Localizer(i18n);
  const own = (dispose: () => void): void => {
    disposers.push(dispose);
  };

  const feedbackTargets: { audio: FeedbackTargets['audio']; vibrate: FeedbackTargets['vibrate'] } =
    {
      audio: options.audio ?? null,
      vibrate: options.vibrate === undefined ? browserVibrate() : options.vibrate,
    };
  own(bindFeedback(bus, store, feedbackTargets));
  let unbindAudio: (() => void) | null = null;
  const attachAudio = (audio: UiAudio | null): void => {
    unbindAudio?.();
    unbindAudio = audio ? bindAudioSettings(audio, store) : null;
    feedbackTargets.audio = audio;
  };
  attachAudio(options.audio ?? null);
  own(() => {
    unbindAudio?.();
  });

  const root = options.root;
  applyTheme(root, rivieraThemeVariables());
  const paintMotion = (): void => {
    root.dataset.motion = isReducedMotion() ? 'reduced' : 'full';
  };
  own(onReducedMotionChange(paintMotion));
  paintMotion();

  own(
    watch(
      store,
      (s) => s.settings,
      (next, previous) => {
        if (!previous) return;
        if (next.language !== previous.language) i18n.changeLanguage(next.language);
        if (next.motion !== previous.motion) setMotionPreference(next.motion);
        if (!sameSettings(next, previous)) saveSettings(storage, next);
      },
    ),
  );
  const paintLanguage = (): void => {
    document.documentElement.lang = i18n.language;
    document.title = i18n.t('app.name');
  };
  own(i18n.onLanguageChanged(paintLanguage));
  paintLanguage();

  const hud: Hud = createHud({ i18n, loc, store, bus, own });
  root.classList.add('cp-ui-host');
  root.append(hud.root);

  return {
    store,
    bus,
    i18n,
    bannerSlot: hud.bannerSlot,
    get settings() {
      return store.getState().settings;
    },
    attachAudio,
    setWallet(wallet) {
      store.setState({
        coins: requireCount('coins', wallet.coins),
        goldBars: requireCount('goldBars', wallet.goldBars),
        provisional: wallet.provisional ?? false,
      });
    },
    setCascade(count) {
      store.setState({ cascadeCount: requireCount('cascade count', count) });
    },
    setDecorum(decorum) {
      requireCount('decorum.used', decorum.used);
      requireCount('decorum.capacity', decorum.capacity);
      requireCount('decorum.frozenSeconds', decorum.frozenSeconds);
      store.setState({ decorum });
    },
    setUpgradeLevels(levels) {
      store.setState({ upgradeLevels: levels });
    },
    resolveUpgrade(levels) {
      store.setState(
        levels ? { pendingUpgrade: null, upgradeLevels: levels } : { pendingUpgrade: null },
      );
    },
    onUpgradeRequest(handler) {
      return bus.on('upgrades:request', handler);
    },
    onSettingsChange(handler) {
      return watch(
        store,
        (s) => s.settings,
        (next, previous) => {
          if (previous) handler(next);
        },
      );
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
      loc.dispose();
      hud.root.remove();
      root.classList.remove('cp-ui-host');
    },
  };
}
