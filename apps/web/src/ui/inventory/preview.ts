import { album } from '@coinposh/economy';
import { mountUi, type UiApp } from '../../app/index.ts';
import { detectBackend } from '../../backend.ts';
import { isLanguage } from '../../i18n/index.ts';
import type { CardArtSource } from './art.ts';
import { seenLevelsStore } from './data.ts';
import { inventoryKey } from './i18n.ts';
import type { InventoryData, InventoryEntry, InventoryView, ItemStack } from './model.ts';
import { mountInventory, type InventoryPanel } from './mount.ts';

/**
 * Dev-only look-dev harness for the inventory, served by Vite at /src/ui/inventory/preview.html.
 * The items and the fuse rate are stand-ins for what the server would report. Query flags:
 * `lang=fr|de`, `motion=reduced|full`, `empty`, `fail` (the load rejects), `art` (render the
 * card props offscreen; `art=webgl2` forces the WebGL2 backend), `gain` (a charm levelled up
 * since the last visit) and `closed` (leave the sheet shut until the trigger is pressed, so
 * the open cue's haptic follows a real tap).
 */
declare global {
  interface Window {
    __inventory?: InventoryPanel;
    __ui?: UiApp;
  }
}

const params = new URLSearchParams(location.search);
const DUPLICATES_PER_LEVEL = 3;

function fixtureEntries(): InventoryEntry[] {
  const charms = album.flatMap((set) =>
    set.items.map((item): Pick<InventoryEntry, 'type' | 'rarity'> => ({
      type: item.id,
      rarity: item.rarity,
    })),
  );
  const entries: InventoryEntry[] = charms.slice(0, 9).map((item, index) => ({
    ...item,
    id: `charm_${String(index)}`,
    kind: 'charm',
    level: 1 + ((index + 1) % 4),
    equipped: index === 2,
    ready: false,
  }));
  const bell = entries[0];
  if (bell) {
    for (let copy = 0; copy < 4; copy++) entries.push({ ...bell, id: `charm_dupe${String(copy)}` });
  }
  entries.push(
    {
      id: 'safe_ready',
      kind: 'safe',
      type: 'brassSafe',
      rarity: null,
      level: 1,
      equipped: false,
      ready: true,
    },
    {
      id: 'safe_sealed',
      kind: 'safe',
      type: 'brassSafe',
      rarity: null,
      level: 1,
      equipped: false,
      ready: false,
    },
    {
      id: 'scratch_0',
      kind: 'scratchCard',
      type: 'scratchCard',
      rarity: null,
      level: 1,
      equipped: false,
      ready: false,
    },
  );
  return entries;
}

function previewData(): InventoryData {
  let entries = params.has('empty') ? [] : fixtureEntries();
  const view = (): InventoryView => ({ entries, duplicatesPerLevel: DUPLICATES_PER_LEVEL });
  const settle = <T>(value: T): Promise<T> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(value);
      }, 450);
    });
  return {
    load: () =>
      params.has('fail')
        ? settle(null).then(() => Promise.reject(new Error('Preview: the load was told to fail')))
        : settle(view()),
    levelUp: (stack: ItemStack) => {
      const spent = new Set(stack.ids.slice(1, 1 + DUPLICATES_PER_LEVEL));
      if (spent.size < DUPLICATES_PER_LEVEL)
        return Promise.reject(new Error(`Preview: ${stack.key} has too few copies to fuse`));
      entries = entries
        .filter((entry) => !spent.has(entry.id))
        .map((entry) => (entry.id === stack.ids[0] ? { ...entry, level: entry.level + 1 } : entry));
      return settle(view());
    },
  };
}

async function previewArt(): Promise<CardArtSource | null> {
  const mode = params.get('art');
  if (mode === null) return null;
  const canvas = document.querySelector<HTMLCanvasElement>('#stage');
  if (!canvas) throw new Error('Preview canvas #stage is missing');
  const { WebGPURenderer } = await import('three/webgpu');
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: mode === 'webgl2' });
  await renderer.init();
  return { renderer, backend: detectBackend(renderer.backend) };
}

function memorySeen(): ReturnType<typeof seenLevelsStore> {
  const seen = seenLevelsStore(null);
  if (params.has('gain')) {
    seen.write({ [`charm:${album[0].items[0].id}`]: 1 });
  }
  return seen;
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
  trigger.dataset.testid = 'inventory-trigger';
  trigger.style.cssText =
    'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);padding:12px 22px;pointer-events:auto';
  host.append(trigger);
  const panel = mountInventory({
    ui: app,
    host,
    data: previewData(),
    art: await previewArt(),
    seen: memorySeen(),
    onClose: () => undefined,
  });
  trigger.textContent = app.i18n.t(inventoryKey('open'));
  trigger.addEventListener('click', () => {
    panel.open(trigger);
  });
  if (!params.has('closed')) panel.open(trigger);
  window.__inventory = panel;
  window.__ui = app;
}

boot().catch((error: unknown) => {
  console.error('Inventory preview could not start', error);
});
