import './account.css';
import type { Account } from '@coinposh/shared';
import type { UiApp } from '../../app/index.ts';
import type { SettingsStorage } from '../../app/settings.ts';
import { watch } from '../../app/store.ts';
import type { AccountClient } from '../../net/index.ts';
import type { UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { Localizer } from '../localize.ts';
import { isReducedMotion, onReducedMotionChange } from '../motion/reduced.ts';
import { createChoiceSheet } from './choice.ts';
import { accountT, registerAccountStrings } from './i18n.ts';
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
import { createPromptCard } from './prompt.ts';
import { createAccountSection } from './section.ts';

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
}

export interface AccountUi {
  /** The player reached a new venue: the moment the gentle prompt is for. */
  ascended(): void;
  dispose(): void;
}

export function mountAccountUi(options: AccountUiOptions): AccountUi {
  registerAccountStrings(options.ui.i18n);
  const now = options.now ?? (() => Date.now());
  const disposers: (() => void)[] = [];
  const loc = new Localizer(options.ui.i18n);
  const ctx: UiContext = {
    i18n: options.ui.i18n,
    loc,
    store: options.ui.store,
    bus: options.ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const t = accountT(ctx.i18n);

  const prompt = createPromptCard({
    ctx,
    t,
    onAction: () => {
      ctx.store.setState({ panel: 'settings' });
      requestAnimationFrame(() => {
        section.highlight();
      });
    },
  });
  options.ui.bannerSlot.append(prompt.el);

  let linked: boolean | null = null;
  const onAccount = (account: Account): void => {
    linked = account.identities.length > 0;
    if (linked) prompt.hide();
  };

  const choice = createChoiceSheet(ctx, t);
  const root = h('div', { class: 'cp-ui cp-account-root' }, choice.el);
  options.host.append(root);
  root.classList.toggle('is-reduced', isReducedMotion());
  ctx.own(
    onReducedMotionChange((reduced) => {
      root.classList.toggle('is-reduced', reduced);
    }),
  );

  const section = createAccountSection({ ctx, t, client: options.client, choice, onAccount });
  options.slot.replaceChildren(section.el);

  let record = loadRecord(options.storage);
  let queued: PromptReason | null = null;
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

  const showWhenCalm = (): void => {
    if (queued === null || ctx.store.getState().panel !== null || prompt.visible) return;
    const reason = queued;
    queued = null;
    record = { ...record, shown: reason };
    save();
    prompt.show(reason);
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
        if (panel === 'settings' && previous !== 'settings') section.refresh();
        if (panel !== null) prompt.hide();
        else showWhenCalm();
      },
    ),
  );

  let last = now();
  const tick = setInterval(() => {
    const at = now();
    const elapsed = at - last;
    last = at;
    if (document.visibilityState !== 'visible' || !options.playing()) return;
    record = addPlay(record, elapsed);
    save();
    considerLoudly('tick');
  }, PLAY_TICK_MS);
  ctx.own(() => {
    clearInterval(tick);
  });

  return {
    ascended() {
      const wait = setTimeout(() => {
        considerLoudly('ascension');
      }, AFTER_ASCENSION_MS);
      ctx.own(() => {
        clearTimeout(wait);
      });
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
      loc.dispose();
      root.remove();
      prompt.el.remove();
      section.el.remove();
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
