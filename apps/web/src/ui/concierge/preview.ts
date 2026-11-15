import { createBus } from '../../app/bus.ts';
import { mountUi, type UiApp } from '../../app/index.ts';
import { createAudioEngine, isAudioSupported } from '../../audio/index.ts';
import { createConciergeVoice, type ConciergeVoice } from '../../audio/concierge/index.ts';
import {
  CONCIERGE_DURATION_MS,
  CONCIERGE_LINE_IDS,
  CONCIERGE_LINE_VARIANTS,
  conciergeLine,
  isConciergeLineId,
  type ConciergeEvents,
  type ConciergeHushReason,
  type ConciergeLine,
  type ConciergeLineId,
  type ConciergeParams,
} from '../../game/concierge/index.ts';
import { isLanguage } from '../../i18n/index.ts';
import { Haptics } from '../../vfx/haptics.ts';
import type { ConciergeBrainPort } from './stage.ts';
import { mountConcierge, type ConciergeView } from './mount.ts';

/**
 * Dev-only look-dev harness for Augustin, served by Vite at /src/ui/concierge/preview.html.
 * A stand-in brain speaks whichever line the controls pick. Query flags: `lang=fr|de`,
 * `motion=reduced|full`, `line=<lineId>`, `variant=0..4`, `hold` (the card stays up until
 * dismissed), `muted` (start muted) and `bare` (no controls, for screenshots).
 * Keys: N next line, P previous, V next variant, M mute.
 */
interface PreviewBrain extends ConciergeBrainPort {
  say(lineId: ConciergeLineId, variant: number): void;
  setMuted(muted: boolean): void;
}

declare global {
  interface Window {
    __concierge?: ConciergeView;
    __conciergeBrain?: PreviewBrain;
    __ui?: UiApp;
  }
}

const params = new URLSearchParams(location.search);
const hold = params.has('hold');

const SAMPLE_PARAMS: Partial<Record<ConciergeLineId, ConciergeParams>> = {
  'cascade.chic': { count: 12 },
  'cascade.lavish': { count: 24 },
  'cascade.opulent': { count: 48 },
  'cascade.decadent': { count: 96 },
  'cascade.obscene': { count: 180 },
  'fusion.first': { tier: 'silver' },
  'fusion.minor': { tier: 'gold' },
  'fusion.platinum': { tier: 'platinum' },
  'fusion.diamond': { tier: 'diamond' },
  'fusion.heirloom': { tier: 'heirloom' },
  'decorum.freeze': { seconds: 6 },
  'reward.modest': { rarity: 'fine' },
  'reward.rare': { rarity: 'exquisite' },
  'reward.legendary': { rarity: 'legendary' },
  'vault.welcomeBack': { coins: 1240 },
  'vault.capped': { coins: 5000 },
  'tip.upgradeAffordable': { upgrade: 'dropRate' },
  'upgrade.purchased': { upgrade: 'dropRate', level: 3 },
  'ascension.arrived': { venue: 'rivieraYacht' },
};

function previewBrain(): PreviewBrain {
  const events = createBus<ConciergeEvents>();
  let current: ConciergeLine | null = null;
  let muted = params.has('muted');
  let doneTimer: ReturnType<typeof setTimeout> | null = null;

  const hush = (reason: ConciergeHushReason): void => {
    if (doneTimer !== null) clearTimeout(doneTimer);
    doneTimer = null;
    const said = current;
    current = null;
    if (said) events.emit('concierge:hush', { lineId: said.lineId, reason });
  };

  return {
    events,
    get current() {
      return current;
    },
    get muted() {
      return muted;
    },
    say(lineId, variant) {
      if (muted) return;
      const spec = conciergeLine(lineId);
      if (current) hush('preempted');
      const line: ConciergeLine = {
        lineId,
        variant,
        expression: spec.expression,
        kind: spec.kind,
        priority: spec.priority,
        durationMs: CONCIERGE_DURATION_MS[spec.kind],
        params: SAMPLE_PARAMS[lineId] ?? {},
      };
      current = line;
      events.emit('concierge:say', line);
      if (!hold) {
        doneTimer = setTimeout(() => {
          hush('done');
        }, line.durationMs);
      }
    },
    setMuted(next) {
      if (next === muted) return;
      if (next) hush('muted');
      muted = next;
      events.emit('concierge:muted', { muted });
    },
    dismiss() {
      hush('dismissed');
    },
  };
}

function controlButton(label: string, onPress: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onPress);
  return button;
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

  let voice: ConciergeVoice | null = null;
  if (isAudioSupported()) {
    const engine = createAudioEngine();
    voice = createConciergeVoice({ context: engine.context, sfxBus: engine.buses.sfx });
  }
  const brain = previewBrain();
  const view = await mountConcierge({
    ui: app,
    host,
    brain,
    voice: () => voice,
    haptics: new Haptics(navigator, () => performance.now()),
  });

  const requested = params.get('line');
  let lineIndex = Math.max(
    0,
    isConciergeLineId(requested) ? CONCIERGE_LINE_IDS.indexOf(requested) : 0,
  );
  let variant = Math.min(
    CONCIERGE_LINE_VARIANTS - 1,
    Math.max(0, Number.parseInt(params.get('variant') ?? '0', 10) || 0),
  );
  const speak = (): void => {
    const lineId = CONCIERGE_LINE_IDS[lineIndex];
    if (lineId === undefined) throw new Error(`Preview: no line at index ${String(lineIndex)}`);
    brain.say(lineId, variant);
    select.value = lineId;
  };
  const step = (by: number): void => {
    lineIndex = (lineIndex + by + CONCIERGE_LINE_IDS.length) % CONCIERGE_LINE_IDS.length;
    variant = 0;
    speak();
  };
  const nextVariant = (): void => {
    variant = (variant + 1) % CONCIERGE_LINE_VARIANTS;
    speak();
  };
  const toggleMute = (): void => {
    brain.setMuted(!brain.muted);
    muteButton.textContent = brain.muted ? 'Unmute' : 'Mute';
  };

  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Line');
  for (const lineId of CONCIERGE_LINE_IDS) {
    const option = document.createElement('option');
    option.value = lineId;
    option.textContent = `${lineId} (${conciergeLine(lineId).expression})`;
    select.append(option);
  }
  select.addEventListener('change', () => {
    lineIndex = CONCIERGE_LINE_IDS.indexOf(select.value as ConciergeLineId);
    variant = 0;
    speak();
  });
  const muteButton = controlButton(brain.muted ? 'Unmute' : 'Mute', toggleMute);
  const controls = document.createElement('div');
  controls.className = 'preview-controls';
  controls.append(
    select,
    controlButton('Prev', () => {
      step(-1);
    }),
    controlButton('Next', () => {
      step(1);
    }),
    controlButton('Variant', nextVariant),
    controlButton('Say again', speak),
    muteButton,
  );
  if (!params.has('bare')) document.body.append(controls);
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLSelectElement) return;
    if (event.key === 'n') step(1);
    else if (event.key === 'p') step(-1);
    else if (event.key === 'v') nextVariant();
    else if (event.key === 'm') toggleMute();
  });

  speak();
  window.__concierge = view;
  window.__conciergeBrain = brain;
  window.__ui = app;
}

void boot();
