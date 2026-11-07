import { mountUi, type UiApp } from '../app/index.ts';
import { isLanguage } from '../i18n/index.ts';

/**
 * Dev-only look-dev harness for the HUD, served by Vite at /src/ui/preview.html. The numbers
 * here are stand-ins for what the server would report. Query flags: `lang=fr|de`,
 * `panel=upgrades|settings`, `coins=<n>`, `bars=<n>`, `combo=<n>`, `decorum=<0..1>`,
 * `frozen=<s>`, `levels=<line>:<n>,…`, `demo` (a scripted run of coin gains and cascades), and
 * `scene` (render the Riviera venue behind the UI).
 */
declare global {
  interface Window {
    __ui?: UiApp;
  }
}

const params = new URLSearchParams(location.search);

function numberParam(name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`Preview flag ${name} must be a number, got "${raw}"`);
  return value;
}

function levelsParam(): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const pair of (params.get('levels') ?? '').split(',')) {
    const [id, level] = pair.split(':');
    if (id && level) levels[id] = Number(level);
  }
  return levels;
}

async function startScene(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#preview');
  if (!canvas) throw new Error('Preview canvas #preview is missing');
  const [{ PerspectiveCamera, Scene, Timer, WebGPURenderer }, venueModule] = await Promise.all([
    import('three/webgpu'),
    import('../scene/venues/riviera/index.ts'),
  ]);
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  await renderer.init();
  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.05, 120);
  const venue = await venueModule.createRivieraVenue(scene, renderer, { quality: 'low' });
  const timer = new Timer();
  await renderer.setAnimationLoop((now: number) => {
    timer.update(now);
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    venueModule.applyCameraPreset(camera, venue.cameraPreset(camera.aspect));
    camera.updateProjectionMatrix();
    venue.update(timer.getDelta());
    renderer.render(scene, camera);
  });
}

function runDemo(app: UiApp): void {
  let coins = app.store.getState().coins;
  let combo = 0;
  let decorum = 0;
  setInterval(() => {
    coins += 25 + Math.floor(Math.random() * 400);
    combo = combo > 26 ? 0 : combo + 1 + Math.floor(Math.random() * 3);
    decorum = (decorum + 7) % 100;
    app.setWallet({ coins, goldBars: app.store.getState().goldBars });
    app.setCascade(combo);
    app.setDecorum({ used: decorum, capacity: 100, frozenSeconds: 0 });
  }, 700);
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
  app.setWallet({ coins: numberParam('coins', 12_480), goldBars: numberParam('bars', 0) });
  app.setCascade(numberParam('combo', 0));
  app.setDecorum({
    used: numberParam('decorum', 0.2) * 100,
    capacity: 100,
    frozenSeconds: numberParam('frozen', 0),
  });
  app.setUpgradeLevels(levelsParam());
  app.onUpgradeRequest(({ lineId, fromLevel }) => {
    setTimeout(() => {
      app.resolveUpgrade({ ...app.store.getState().upgradeLevels, [lineId]: fromLevel + 1 });
    }, 600);
  });
  const panel = params.get('panel');
  if (panel === 'upgrades' || panel === 'settings') {
    requestAnimationFrame(() => {
      app.store.setState({ panel });
    });
  }
  if (params.has('demo')) runDemo(app);
  if (params.has('scene')) {
    startScene().catch((error: unknown) => {
      console.error('UI preview: the venue backdrop could not start', error);
    });
  }
  window.__ui = app;
}

boot();
