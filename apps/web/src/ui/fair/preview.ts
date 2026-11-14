import { commitmentOf, type ActiveSeed, type RevealedSeed } from '@coinposh/shared';
import { mountUi, type UiApp } from '../../app/index.ts';
import { isLanguage } from '../../i18n/index.ts';
import { sha256Hex } from '../../net/encoding.ts';
import type { FairData } from './data.ts';
import { fairKey } from './i18n.ts';
import { FAIR_TABS, type FairTab } from './model.ts';
import { mountFair, type FairPanel } from './mount.ts';

/**
 * Dev-only look-dev harness for the Certified Fair panel, served by Vite at
 * /src/ui/fair/preview.html. The seeds are fixtures hashed for real, so the verify view checks
 * them exactly as it would the server's. Query flags: `lang=fr|de`, `motion=reduced|full`,
 * `tab=odds|pity|verify`, `fresh` (no pity counts yet), `fail` (the ledger load rejects),
 * `proof` (open on a roll to check) and `closed` (leave the sheet shut until the trigger).
 */
declare global {
  interface Window {
    __fair?: FairPanel;
    __ui?: UiApp;
  }
}

const params = new URLSearchParams(location.search);
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 13, 18, 30);

async function fixtureSeed(generation: number, finalNonce: number): Promise<RevealedSeed> {
  const serverSeed = await sha256Hex(`coinposh-preview-server:${String(generation)}`);
  return {
    serverSeed,
    serverSeedHash: await commitmentOf(serverSeed),
    clientSeed: generation === 0 ? 'velvet-rope' : `lucky-${String(generation)}`,
    finalNonce,
    revealedAt: NOW - (3 - generation) * DAY_MS,
  };
}

async function fixtureActive(generation: number): Promise<ActiveSeed> {
  const serverSeed = await sha256Hex(`coinposh-preview-server:${String(generation)}`);
  return { serverSeedHash: await commitmentOf(serverSeed), clientSeed: 'gold-leaf', nonce: 17 };
}

function settle<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, 450);
  });
}

async function previewData(): Promise<FairData> {
  const revealed = await Promise.all([fixtureSeed(0, 64), fixtureSeed(1, 23), fixtureSeed(2, 120)]);
  let generation = 3;
  let active = await fixtureActive(generation);
  return {
    seeds: () =>
      params.has('fail')
        ? settle(null).then(() => Promise.reject(new Error('Preview: the ledger was told to fail')))
        : settle({ active, revealed: [...revealed] }),
    rotate: async (clientSeed) => {
      const serverSeed = await sha256Hex(`coinposh-preview-server:${String(generation)}`);
      const spent: RevealedSeed = {
        serverSeed,
        serverSeedHash: active.serverSeedHash,
        clientSeed: active.clientSeed,
        finalNonce: active.nonce,
        revealedAt: Date.now(),
      };
      revealed.push(spent);
      generation++;
      active = {
        ...(await fixtureActive(generation)),
        clientSeed: clientSeed ?? active.clientSeed,
        nonce: 0,
      };
      return settle({ active, revealed: spent });
    },
    pity: () =>
      params.has('fresh')
        ? {}
        : {
            vaultCrate: { rare: 9, exquisite: 23, legendary: 71 },
            goldSafe: { rare: 2, exquisite: 6, legendary: 14 },
            gacha: { rare: 5, exquisite: 38, legendary: 119 },
          },
  };
}

function isTab(value: string | null): value is FairTab {
  return FAIR_TABS.some((tab) => tab === value);
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
  trigger.dataset.testid = 'fair-trigger';
  trigger.style.cssText =
    'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);padding:12px 22px;pointer-events:auto';
  host.append(trigger);
  const data = await previewData();
  const panel = mountFair({ ui: app, host, data, onClose: () => undefined });
  trigger.textContent = app.i18n.t(fairKey('open'));
  const tab = params.get('tab');
  const first = (await data.seeds().catch(() => null))?.revealed[0] ?? null;
  const proof =
    params.has('proof') && first
      ? { serverSeedHash: first.serverSeedHash, clientSeed: first.clientSeed, nonce: 7 }
      : undefined;
  const open = () => {
    panel.open(trigger, { ...(isTab(tab) ? { tab } : {}), ...(proof ? { proof } : {}) });
  };
  trigger.addEventListener('click', open);
  if (!params.has('closed')) open();
  window.__fair = panel;
  window.__ui = app;
}

boot().catch((error: unknown) => {
  console.error('Certified Fair preview could not start', error);
});
