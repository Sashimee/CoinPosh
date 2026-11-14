import {
  RaritySchema,
  ScratchCardIdSchema,
  ScratchRevealResponseSchema,
  type Rarity,
  type ScratchCardId,
} from '@coinposh/shared';
import { mountUi, type UiApp } from '../../app/index.ts';
import { isLanguage } from '../../i18n/index.ts';
import { NetworkError } from '../../net/errors.ts';
import { createScratchSurface } from '../../vfx/scratch/surface.ts';
import type { ScratchApi } from './controller.ts';
import { scratchKey } from './i18n.ts';
import { mountScratch, type ScratchModule } from './mount.ts';

/**
 * Dev-only look-dev harness for scratch cards, served by Vite at /src/game/scratch/preview.html.
 * The reveal answers like the server: one fixed grid per rarity, the card consumed on success.
 * Query flags: `lang=fr|de`, `motion=reduced|full`, `gpu=webgl2|canvas`, `rarity=<rarity>`,
 * `fail=not_found|offline` (the first reveal fails that way), `cards=<n>` and `closed`.
 */
declare global {
  interface Window {
    __scratch?: ScratchModule;
    __ui?: UiApp;
  }
}

const params = new URLSearchParams(location.search);

const GRIDS: Readonly<Record<Rarity, readonly Rarity[]>> = {
  common: ['common', 'fine', 'rare', 'fine', 'common', 'rare', 'exquisite', 'legendary', 'common'],
  fine: ['fine', 'rare', 'common', 'rare', 'fine', 'exquisite', 'common', 'exquisite', 'fine'],
  rare: ['fine', 'rare', 'common', 'rare', 'fine', 'common', 'rare', 'exquisite', 'legendary'],
  exquisite: [
    'exquisite',
    'rare',
    'fine',
    'common',
    'exquisite',
    'rare',
    'fine',
    'common',
    'exquisite',
  ],
  legendary: [
    'rare',
    'legendary',
    'fine',
    'legendary',
    'exquisite',
    'common',
    'fine',
    'legendary',
    'rare',
  ],
  heirloom: [
    'heirloom',
    'legendary',
    'rare',
    'exquisite',
    'heirloom',
    'legendary',
    'rare',
    'fine',
    'heirloom',
  ],
};

const PRIZES: Readonly<Record<Rarity, number>> = {
  common: 250,
  fine: 600,
  rare: 1_200,
  exquisite: 3_500,
  legendary: 12_000,
  heirloom: 50_000,
};

function card(index: number): ScratchCardId {
  return ScratchCardIdSchema.parse(`scratch_preview${String(index).padStart(4, '0')}`);
}

function previewApi(rarity: Rarity, owned: Set<ScratchCardId>): ScratchApi {
  let failure = params.get('fail');
  let nonce = 40;
  let coins = 18_000;
  return {
    async reveal(body) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const fail = failure;
      failure = null;
      if (fail === 'offline') throw new NetworkError('Preview: the reveal was told to go offline');
      if (fail === 'not_found' || !owned.has(body.cardId)) {
        throw Object.assign(new Error('No such scratch card.'), { code: 'not_found' });
      }
      owned.delete(body.cardId);
      coins += PRIZES[rarity];
      nonce += 1;
      return ScratchRevealResponseSchema.parse({
        cardId: body.cardId,
        grid: GRIDS[rarity],
        roll: {
          rarity,
          rewards: [{ kind: 'currency', currency: 'coins', amount: PRIZES[rarity] }],
          proof: { serverSeedHash: 'c0'.repeat(32), clientSeed: 'velvet-rope', nonce },
          pity: { rare: 0, exquisite: 3, legendary: 11 },
        },
        wallet: { coins, bullion: 0, goldBars: 2, pearls: 0, keys: 1, tickets: 0, stars: 0 },
      });
    },
  };
}

function boot(): void {
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
  const parsed = RaritySchema.safeParse(params.get('rarity'));
  const rarity = parsed.success ? parsed.data : 'rare';
  const count = Math.max(1, Math.min(9, Number(params.get('cards') ?? '2') || 2));
  const cards = Array.from({ length: count }, (_, i) => card(i + 1));
  const gpu = params.get('gpu');
  const scratch = mountScratch({
    ui: app,
    host,
    api: previewApi(rarity, new Set(cards)),
    cards,
    wallet: null,
    vibrate: (pattern) => navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]),
    reducedMotion: () => app.store.getState().settings.motion === 'reduced',
    openFair: (_trigger, options) => {
      console.info('Preview: the Certified Fair panel would open', options);
    },
    surface: () =>
      createScratchSurface({ forceWebGL: gpu === 'webgl2', forceCanvas: gpu === 'canvas' }),
  });
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.dataset.testid = 'scratch-trigger';
  trigger.textContent = app.i18n.t(scratchKey('open'));
  trigger.style.cssText =
    'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);padding:12px 22px;pointer-events:auto';
  trigger.addEventListener('click', () => {
    scratch.open();
  });
  host.append(trigger);
  if (!params.has('closed')) scratch.open();
  window.__scratch = scratch;
  window.__ui = app;
}

boot();
