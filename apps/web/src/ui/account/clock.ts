import type { Account } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import type { SettingsStorage } from '../../app/settings.ts';
import { watch } from '../../app/store.ts';
import type { AccountClient } from '../../net/index.ts';
import { announcementHoldFor } from '../components/announcementHold.ts';
import type { UiContext } from '../context.ts';
import { Localizer } from '../localize.ts';
import {
  addPlay,
  FRESH_PROMPT,
  parsePromptRecord,
  PROMPT_STORAGE_KEY,
  promptReason,
  type PromptReason,
  type PromptRecord,
  type PromptTrigger,
} from './model.ts';
import type { AccountSurface, AccountSurfaceOptions } from './surface.ts';

/** How often play time is counted toward the two-hour prompt. */
export const PLAY_TICK_MS = 15_000;
/** The prompt waits out the ascension's own celebration before it asks. */
export const AFTER_ASCENSION_MS = 6_000;

export interface AccountUiOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n' | 'bannerSlot'>;
  /** The UI root over the canvas; the progress-choice sheet mounts here. */
  readonly host: HTMLElement;
  /** The empty slot the settings panel keeps for this section. */
  readonly slot: HTMLElement;
  readonly client: () => Promise<AccountClient>;
  /** True while the table takes drops; only that time counts toward the prompt. */
  readonly playing: () => boolean;
  readonly storage: SettingsStorage | null;
  readonly now?: () => number;
  /** Whether the tab is on screen; defaults to the document's visibility. */
  readonly visible?: () => boolean;
  /** Builds the section and the prompt; defaults to importing them on first need. */
  readonly mountSurface?: (options: AccountSurfaceOptions) => Promise<AccountSurface>;
}

export interface AccountUi {
  /** The player reached a new venue: the moment the gentle prompt is for. */
  ascended(): void;
  dispose(): void;
}

/**
 * The part of the account UI every player loads after boot: the play clock and the
 * once-per-device prompt record. The section, the prompt card and their strings and styles
 * load the first time Settings opens or the prompt is due.
 */
export function mountAccountUi(options: AccountUiOptions): AccountUi {
  const now = options.now ?? (() => Date.now());
  const visible = options.visible ?? (() => document.visibilityState === 'visible');
  const mountSurface =
    options.mountSurface ??
    ((surfaceOptions: AccountSurfaceOptions) =>
      import('./surface.ts').then(({ mountAccountSurface }) =>
        mountAccountSurface(surfaceOptions),
      ));
  const cinematics = announcementHoldFor(options.ui.store);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(options.ui.i18n);
  const ctx: UiContext = {
    i18n: options.ui.i18n,
    loc,
    store: options.ui.store,
    bus: options.ui.bus,
    own: (dispose) => disposers.push(dispose),
  };

  let linked: boolean | null = null;
  let disposed = false;
  let mounted: AccountSurface | null = null;
  let loading: Promise<AccountSurface | null> | null = null;

  const onAccount = (account: Account): void => {
    linked = account.identities.length > 0;
    if (linked) mounted?.prompt.hide();
  };

  const surface = (): Promise<AccountSurface | null> => {
    loading ??= mountSurface({
      ctx,
      bannerSlot: options.ui.bannerSlot,
      host: options.host,
      slot: options.slot,
      client: options.client,
      onAccount,
    })
      .then((ready) => {
        if (disposed) {
          ready.dispose();
          return null;
        }
        mounted = ready;
        return mounted;
      })
      .catch((error: unknown) => {
        loading = null;
        throw error;
      });
    return loading;
  };

  let record = loadRecord(options.storage);
  let queued: PromptReason | null = null;
  let showing: PromptReason | null = null;
  let checking = false;

  const save = (): void => {
    if (!options.storage) return;
    try {
      options.storage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(record));
    } catch (error) {
      console.warn(
        'CoinPosh account: the prompt clock could not be saved; it restarts next visit.',
        error,
      );
    }
  };

  const calm = (): boolean =>
    ctx.store.getState().panel === null && !cinematics.held && !mounted?.prompt.visible;

  const showWhenCalm = (): void => {
    if (queued === null || !calm()) return;
    surface()
      .then((ready) => {
        if (!ready || queued === null || !calm()) return;
        const reason = queued;
        queued = null;
        record = { ...record, shown: reason };
        save();
        showing = reason;
        ready.prompt.show(reason);
      })
      .catch((error: unknown) => {
        console.warn('CoinPosh account: the prompt could not load; asking again later.', error);
      });
  };

  const consider = async (trigger: PromptTrigger): Promise<void> => {
    if (checking || queued !== null || promptReason(record, trigger, linked === true) === null)
      return;
    checking = true;
    try {
      if (linked === null) {
        const client = await options.client();
        onAccount(await client.get());
      }
      const reason = promptReason(record, trigger, linked === true);
      if (reason === null) return;
      queued = reason;
      showWhenCalm();
    } finally {
      checking = false;
    }
  };
  const considerLoudly = (trigger: PromptTrigger): void => {
    consider(trigger).catch((error: unknown) => {
      console.warn(
        'CoinPosh account: the account could not be checked for the prompt; asking later.',
        error,
      );
    });
  };

  ctx.own(
    watch(
      ctx.store,
      (s) => s.panel,
      (panel, previous) => {
        if (panel === 'settings' && previous !== 'settings') {
          surface()
            .then((ready) => {
              ready?.section.refresh();
            })
            .catch((error: unknown) => {
              console.error(
                'CoinPosh account: the Keep my progress section could not load; it tries again next time Settings opens.',
                error,
              );
            });
        }
        if (panel !== null) mounted?.prompt.hide();
        else showWhenCalm();
      },
    ),
  );

  ctx.own(
    cinematics.onChange((held) => {
      if (!held) {
        showWhenCalm();
        return;
      }
      // A crate the player did not ask for has the screen: the card steps aside and comes back
      // after the cinematic, instead of counting as seen.
      if (mounted?.prompt.visible && showing !== null) {
        queued = showing;
        mounted.prompt.hide();
      }
    }),
  );

  let last = now();
  const tick = setInterval(() => {
    const at = now();
    const elapsed = at - last;
    last = at;
    if (!visible() || !options.playing()) return;
    record = addPlay(record, elapsed);
    save();
    considerLoudly('tick');
  }, PLAY_TICK_MS);
  ctx.own(() => {
    clearInterval(tick);
  });

  let wait: ReturnType<typeof setTimeout> | null = null;
  ctx.own(() => {
    if (wait !== null) clearTimeout(wait);
  });

  return {
    ascended() {
      if (wait !== null) clearTimeout(wait);
      wait = setTimeout(() => {
        wait = null;
        considerLoudly('ascension');
      }, AFTER_ASCENSION_MS);
    },
    dispose() {
      disposed = true;
      for (const dispose of disposers.splice(0).reverse()) dispose();
      loc.dispose();
      mounted?.dispose();
      mounted = null;
    },
  };
}

function loadRecord(storage: SettingsStorage | null): PromptRecord {
  if (!storage) return FRESH_PROMPT;
  const raw = storage.getItem(PROMPT_STORAGE_KEY);
  const record = parsePromptRecord(raw);
  if (record) return record;
  console.warn(
    `CoinPosh account: ${PROMPT_STORAGE_KEY} held an unreadable record; the prompt clock restarts.`,
  );
  return FRESH_PROMPT;
}
