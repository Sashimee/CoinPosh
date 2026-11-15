import { DEFAULT_FEATURE_FLAGS, type Quest, type QuestsResponse } from '@coinposh/shared';
import { mountUi, type UiApp } from '../../app/index.ts';
import { isLanguage } from '../../i18n/index.ts';
import { ApiRequestError } from '../../net/errors.ts';
import { claimResponse, DEFAULT_QUESTS, questsResponse, seasonResponse } from './fixture.ts';
import { seasonKey } from './i18n.ts';
import type { SeasonData } from './model.ts';
import { mountSeason, type SeasonPanel } from './mount.ts';

/**
 * Dev-only look-dev harness for quests and the season track, served by Vite at
 * /src/ui/season/preview.html. Query flags: `lang=fr|de`, `motion=reduced|full`, `tab=season`,
 * `empty` (no quests offered), `fail` (the loads reject), `claim=fail|already` (how the server
 * answers the first claim; a retry then succeeds), `premium` (monetization flags on, so the
 * premium row opens) and `closed` (leave the sheet shut until the trigger is pressed).
 */
declare global {
  interface Window {
    __season?: SeasonPanel;
    __ui?: UiApp;
  }
}

const params = new URLSearchParams(location.search);
const premium = params.has('premium');

function settle<T>(value: T, ms = 450): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });
}

function previewData(): SeasonData {
  let quests: QuestsResponse = questsResponse(
    params.has('empty') ? [] : DEFAULT_QUESTS,
    {
      days: 5,
      freezes: 1,
    },
    Date.now(),
  );
  let claimMode = params.get('claim');
  const fail = (): Promise<never> =>
    settle(null).then(() => Promise.reject(new Error('Preview: the load was told to fail')));
  return {
    quests: () => (params.has('fail') ? fail() : settle(quests)),
    season: () =>
      params.has('fail')
        ? fail()
        : settle(seasonResponse(1_220, { premiumUnlocked: premium, now: Date.now() })),
    claim: async (questId) => {
      await settle(null, 600);
      const quest = quests.quests.find((candidate) => candidate.id === questId);
      if (quest === undefined) throw new Error(`Preview: no quest ${questId}`);
      const mode = claimMode;
      claimMode = null;
      if (mode === 'fail') throw new Error('Preview: the claim was told to fail');
      const claimed: Quest = { ...quest, claimed: true };
      quests = { ...quests, quests: quests.quests.map((q) => (q.id === questId ? claimed : q)) };
      if (mode === 'already') {
        throw new ApiRequestError('questsClaim', 409, {
          code: 'conflict',
          message: 'Preview: this quest was already claimed',
        });
      }
      return claimResponse(quest);
    },
  };
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#ui');
  if (!root) throw new Error('Preview root #ui is missing');
  const lang = params.get('lang');
  const app = mountUi(root, { languages: isLanguage(lang) ? [lang] : navigator.languages });
  if (isLanguage(lang))
    app.store.setState((s) => ({ settings: { ...s.settings, language: lang } }));
  const motion = params.get('motion');
  if (motion === 'reduced' || motion === 'full' || motion === 'system') {
    app.store.setState((s) => ({ settings: { ...s.settings, motion } }));
  }
  const host = app.bannerSlot.closest<HTMLElement>('.cp-ui-host');
  if (!host) throw new Error('Preview: the UI host .cp-ui-host is missing');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.dataset.testid = 'season-trigger';
  trigger.style.cssText =
    'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);padding:12px 22px;pointer-events:auto';
  host.append(trigger);
  const panel = await mountSeason({
    ui: app,
    host,
    data: previewData(),
    onClose: () => undefined,
    flags: premium
      ? { ...DEFAULT_FEATURE_FLAGS, monetization: true, premiumSeasonTrack: true }
      : DEFAULT_FEATURE_FLAGS,
  });
  trigger.textContent = app.i18n.t(seasonKey('open'));
  const tab = params.get('tab') === 'season' ? 'season' : 'quests';
  trigger.addEventListener('click', () => {
    panel.open(trigger, tab);
  });
  if (!params.has('closed')) panel.open(trigger, tab);
  window.__season = panel;
  window.__ui = app;
}

void boot();
