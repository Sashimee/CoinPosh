import { album } from '@coinposh/economy';
import { mountUi, type UiApp } from '../../app/index.ts';
import { isLanguage } from '../../i18n/index.ts';
import { seenCompletionsStore } from './data.ts';
import { albumResponse } from './fixture.ts';
import { albumKey } from './i18n.ts';
import { albumView, completedSetIds, type AlbumData } from './model.ts';
import { mountAlbum, type AlbumPanel } from './mount.ts';

/**
 * Dev-only look-dev harness for the album, served by Vite at /src/ui/album/preview.html.
 * The ownership is a stand-in for what the server would report. Query flags: `lang=fr|de`,
 * `motion=reduced|full`, `empty` (nothing collected yet), `fail` (the load rejects),
 * `fanfare` (the Sunset Gala completed since the last visit) and `closed` (leave the sheet shut
 * until the trigger is pressed, so the open cue's haptic follows a real tap).
 */
declare global {
  interface Window {
    __album?: AlbumPanel;
    __ui?: UiApp;
  }
}

const params = new URLSearchParams(location.search);
const [deck, captains] = album;

function copies(id: string, set: string): number {
  if (params.has('empty')) return 0;
  if (set === deck.id) return 1 + (id.length % 3);
  if (set === captains.id) return captains.items.findIndex((item) => item.id === id) < 4 ? 1 : 0;
  return 1;
}

function previewData(): AlbumData {
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
        : settle(albumView(albumResponse(copies))),
  };
}

function previewSeen(): ReturnType<typeof seenCompletionsStore> {
  const seen = seenCompletionsStore(null);
  const done = completedSetIds(albumView(albumResponse(copies)));
  seen.write(params.has('fanfare') ? done.filter((id) => id === deck.id) : done);
  return seen;
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
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.dataset.testid = 'album-trigger';
  trigger.style.cssText =
    'position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);padding:12px 22px;pointer-events:auto';
  host.append(trigger);
  const panel = mountAlbum({
    ui: app,
    host,
    data: previewData(),
    seen: previewSeen(),
    onClose: () => undefined,
  });
  trigger.textContent = app.i18n.t(albumKey('open'));
  trigger.addEventListener('click', () => {
    panel.open(trigger);
  });
  if (!params.has('closed')) panel.open(trigger);
  window.__album = panel;
  window.__ui = app;
}

boot();
