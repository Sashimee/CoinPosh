import './vault.css';
import type { UiApp, UiAudio } from '../../app/index.ts';
import type { Bus } from '../../app/bus.ts';
import { formatBalance, type InterpolationValues } from '../../i18n/index.ts';
import type { ImpactEvent } from '../../audio/index.ts';
import { rivieraTokens } from '../../scene/venues/riviera/palette.ts';
import { Odometer } from '../../ui/components/odometer.ts';
import { makePressable } from '../../ui/components/pressable.ts';
import { feedback, type UiContext } from '../../ui/context.ts';
import { h, listen, restartAnimation } from '../../ui/dom.ts';
import { Localizer } from '../../ui/localize.ts';
import { schedule } from '../../ui/motion/loop.ts';
import { isReducedMotion } from '../../ui/motion/reduced.ts';
import { Avalanche, type AvalancheCoin } from './avalanche.ts';
import { countUpValue, TickThrottle } from './countUp.ts';
import type { VaultEvents } from './events.ts';
import { registerVaultStrings, vaultKey } from './i18n.ts';
import { avalancheCoinCount, vaultTimeline, type VaultReturn } from './plan.ts';

const DOOR_CLANG: ImpactEvent = { material: 'metal', velocity: 1.1, pan: 0 };
const LANDING_CHIME: readonly ImpactEvent[] = [
  { material: 'coin', velocity: 1.2, pan: -0.15 },
  { material: 'metal', velocity: 0.7, pan: 0.15 },
];
const CLINK_GAP_MS = 32;
const ODOMETER_GAP_MS = 45;
const HAPTIC_GAP_MS = 140;
const COLLECT_OUT_MS = 320;
const CHAMBER_WIDTH = 300;
const CHAMBER_HEIGHT = 168;

export interface VaultReturnOptions {
  readonly ui: Pick<UiApp, 'store' | 'bus' | 'i18n'>;
  /** The overlay is appended here; usually the UI root laid over the canvas. */
  readonly host: HTMLElement;
  readonly settlement: VaultReturn;
  readonly audio: () => Pick<UiAudio, 'playImpact'> | null;
  readonly onCollected: () => void;
  readonly events?: Bus<VaultEvents>;
  readonly reducedMotion?: boolean;
  /** Seeds the pour; any integer, e.g. derived from the settlement, so a replay looks the same. */
  readonly seed?: number;
}

export interface VaultReturnScreen {
  readonly el: HTMLElement;
  /** Jumps to the end state: settled pile, full total, Collect live. */
  skip(): void;
  dispose(): void;
}

export function showVaultReturn(options: VaultReturnOptions): VaultReturnScreen {
  const { settlement, ui } = options;
  registerVaultStrings(ui.i18n);
  const reduced = options.reducedMotion ?? isReducedMotion();
  const timeline = vaultTimeline(reduced);
  const disposers: (() => void)[] = [];
  const loc = new Localizer(ui.i18n);
  const ctx: UiContext = {
    i18n: ui.i18n,
    loc,
    store: ui.store,
    bus: ui.bus,
    own: (dispose) => disposers.push(dispose),
  };
  const t = (key: Parameters<typeof vaultKey>[0], values?: InterpolationValues) =>
    ui.i18n.t(vaultKey(key), values);
  const amountText = (value: number) => formatBalance(value, ui.i18n.language);

  const title = h('h2', { class: 'cp-vault-title', attrs: { id: 'cp-vault-title' } });
  const subtitle = h('p', { class: 'cp-vault-subtitle' });
  const canvas = h('canvas', { class: 'cp-vault-pile', attrs: { 'aria-hidden': 'true' } });
  const door = h(
    'div',
    { class: 'cp-vault-door', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'cp-vault-wheel' }),
  );
  const chamber = h('div', { class: 'cp-vault-chamber' }, canvas, door);
  const odometer = new Odometer();
  const amount = h(
    'p',
    { class: 'cp-vault-amount' },
    h('span', { class: 'cp-vault-plus', text: '+' }),
    odometer.el,
  );
  const amountSr = h('span', { class: 'cp-sr-only' });
  const away = h('p', { class: 'cp-vault-away' });
  const credited = h('p', { class: 'cp-vault-away' });
  credited.hidden = !settlement.capped;
  const capNote = h('p', { class: 'cp-vault-cap' });
  capNote.hidden = !settlement.capped;
  const collectLabel = h('span');
  const collect = h(
    'button',
    {
      class: 'cp-buy cp-vault-collect',
      attrs: { type: 'button', 'aria-disabled': 'true', 'data-testid': 'vault-collect' },
    },
    collectLabel,
  );
  const skipHint = h('p', { class: 'cp-vault-skip', attrs: { 'aria-hidden': 'true' } });
  const card = h(
    'div',
    { class: 'cp-vault-card' },
    title,
    subtitle,
    chamber,
    amount,
    amountSr,
    away,
    credited,
    capNote,
    collect,
    skipHint,
  );
  const root = h(
    'div',
    {
      class: 'cp-vault',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'cp-vault-title',
        'data-motion': reduced ? 'reduced' : 'full',
        'data-testid': 'vault-return',
      },
    },
    card,
  );

  ctx.own(loc.text(title, () => t('title')));
  ctx.own(loc.text(subtitle, () => t('subtitle')));
  ctx.own(loc.text(collectLabel, () => t('collect')));
  ctx.own(loc.text(skipHint, () => t('skip')));
  ctx.own(loc.text(amountSr, () => t('amountLabel', { amount: amountText(settlement.coins) })));
  ctx.own(
    loc.text(away, () =>
      settlement.away.hours > 0
        ? t('away', settlement.away)
        : t('awayMinutes', { minutes: settlement.away.minutes }),
    ),
  );
  ctx.own(loc.text(credited, () => t('credited', settlement.credited)));
  ctx.own(
    loc.text(capNote, () => `${t('capped', { hours: settlement.credited.hours })} ${t('hint')}`),
  );

  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(CHAMBER_WIDTH * pixelRatio);
  canvas.height = Math.round(CHAMBER_HEIGHT * pixelRatio);
  const paint = canvas.getContext('2d');
  if (!paint) throw new Error('Vault return: the browser refused a 2D canvas for the coin pile');
  paint.scale(pixelRatio, pixelRatio);

  const avalanche = new Avalanche({
    width: CHAMBER_WIDTH,
    height: CHAMBER_HEIGHT,
    count: avalancheCoinCount(settlement.coins),
    seed: options.seed ?? settlement.coins ^ settlement.awayMs,
  });

  const play = (sound: ImpactEvent) => options.audio()?.playImpact(sound);
  const clinks = new TickThrottle(CLINK_GAP_MS);
  const rolls = new TickThrottle(ODOMETER_GAP_MS);
  const haptics = new TickThrottle(HAPTIC_GAP_MS);
  let elapsed = 0;
  let counted = false;
  let live = false;
  let closing = false;

  const land = () => {
    if (counted) return;
    counted = true;
    odometer.set(amountText(settlement.coins), 1);
    restartAnimation(amount, 'is-landed');
    restartAnimation(chamber, 'is-glowing');
    LANDING_CHIME.forEach(play);
    feedback(ctx, 'confirm');
    options.events?.emit('vault:counted', { coins: settlement.coins });
  };
  const unlock = () => {
    if (live) return;
    live = true;
    collect.setAttribute('aria-disabled', 'false');
    root.classList.add('is-ready');
    collect.focus({ preventScroll: true });
  };

  const frame = (dt: number): boolean => {
    if (closing) return false;
    elapsed += dt * 1000;
    if (elapsed >= timeline.avalancheAtMs && !avalanche.settled) {
      for (const impact of avalanche.step(dt)) {
        if (clinks.accept(elapsed, impact.velocity)) {
          play({ material: 'coin', velocity: impact.velocity, pan: impact.pan });
        }
      }
    }
    draw(paint, avalanche.coins);
    if (!counted && elapsed >= timeline.countAtMs) {
      const value = countUpValue(settlement.coins, elapsed - timeline.countAtMs, timeline.countMs);
      if (value >= settlement.coins) land();
      else if (rolls.accept(elapsed, value)) {
        odometer.set(amountText(value), 1);
        if (haptics.accept(elapsed, value)) feedback(ctx, 'tick');
      }
    }
    if (elapsed >= timeline.collectAtMs) unlock();
    return !(live && counted && avalanche.settled);
  };

  const skip = () => {
    if (closing) return;
    elapsed = Math.max(elapsed, timeline.collectAtMs);
    door.classList.add('is-open');
    avalanche.settle();
    draw(paint, avalanche.coins);
    land();
    unlock();
  };

  makePressable(collect, ctx, {
    feedback: () => (live ? 'confirm' : 'tap'),
    enabled: () => !closing,
    onPress: () => {
      if (!live) {
        skip();
        return;
      }
      if (closing) return;
      closing = true;
      root.classList.add('is-collecting');
      options.events?.emit('vault:collected', { coins: settlement.coins });
      options.onCollected();
      const remove = () => {
        dispose();
      };
      if (reduced) remove();
      else setTimeout(remove, COLLECT_OUT_MS);
    },
  });
  ctx.own(
    listen(root, 'pointerdown', (event) => {
      if (!live && !(event.target instanceof Node && collect.contains(event.target))) skip();
    }),
  );
  ctx.own(
    listen(root, 'keydown', (event) => {
      if (!live && (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape')) {
        event.preventDefault();
        skip();
      }
    }),
  );

  options.host.append(root);
  options.events?.emit('vault:opened', { coins: settlement.coins, capped: settlement.capped });
  play(DOOR_CLANG);
  feedback(ctx, 'open');

  odometer.jump(amountText(0));
  if (reduced) {
    skip();
  } else {
    root.tabIndex = -1;
    root.focus({ preventScroll: true });
    const doorFrame = requestAnimationFrame(() => {
      door.classList.add('is-open');
    });
    ctx.own(() => {
      cancelAnimationFrame(doorFrame);
    });
    ctx.own(schedule(frame));
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    closing = true;
    for (const off of disposers.splice(0)) off();
    loc.dispose();
    root.remove();
  }

  return { el: root, skip, dispose };
}

const COIN_LIGHT = rivieraTokens.champagne;
const COIN_BASE = rivieraTokens['gold-brushed'];
const COIN_RIM_SHADE = rivieraTokens['navy-lacquer'];
const COIN_RIM_SHADE_ALPHA = 0.4;

function draw(paint: CanvasRenderingContext2D, coins: readonly AvalancheCoin[]): void {
  paint.clearRect(0, 0, CHAMBER_WIDTH, CHAMBER_HEIGHT);
  for (const coin of coins) {
    if (!coin.released) continue;
    const face = Math.abs(Math.cos(coin.angle));
    const height = Math.max(coin.thickness * 0.5, coin.thickness * (0.6 + 0.4 * face));
    paint.save();
    paint.translate(coin.x, coin.y);
    paint.rotate(Math.sin(coin.angle) * 0.25);
    paint.beginPath();
    paint.ellipse(0, height * 0.18, coin.radius, height / 2, 0, 0, Math.PI * 2);
    paint.fillStyle = COIN_BASE;
    paint.fill();
    paint.globalAlpha = COIN_RIM_SHADE_ALPHA;
    paint.fillStyle = COIN_RIM_SHADE;
    paint.fill();
    paint.globalAlpha = 1;
    const shine = paint.createLinearGradient(-coin.radius, -height, coin.radius, height);
    shine.addColorStop(0, coin.tint > 0.5 ? COIN_LIGHT : COIN_BASE);
    shine.addColorStop(1, COIN_BASE);
    paint.beginPath();
    paint.ellipse(0, 0, coin.radius, height / 2, 0, 0, Math.PI * 2);
    paint.fillStyle = shine;
    paint.fill();
    const glint = Math.max(0, Math.sin(coin.angle * 2 + coin.x * 0.05));
    if (glint > 0.6) {
      paint.globalAlpha = (glint - 0.6) * 2.5;
      paint.beginPath();
      paint.ellipse(
        -coin.radius * 0.35,
        -height * 0.15,
        coin.radius * 0.28,
        height * 0.12,
        0,
        0,
        Math.PI * 2,
      );
      paint.fillStyle = rivieraTokens.ivory;
      paint.fill();
    }
    paint.restore();
  }
}
