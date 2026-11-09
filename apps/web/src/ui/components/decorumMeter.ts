import { decorumView, type DecorumView } from '../../app/model.ts';
import { watch } from '../../app/store.ts';
import { formatPercent } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { SPRINGS } from '../motion/spring.ts';
import { SpringValue } from '../motion/value.ts';
import { createMeterRail, type MeterRail } from './meterRail.ts';

const SHAKE_VELOCITY = 180;
const LEVEL_KEYS = {
  calm: 'decorum.calm',
  warning: 'decorum.warning',
  critical: 'decorum.warning',
  frozen: 'decorum.frozenTitle',
} as const;

function sameView(a: DecorumView, b: DecorumView): boolean {
  return a.fraction === b.fraction && a.level === b.level && a.frozenSeconds === b.frozenSeconds;
}

/** Decorum stays a rail until it moves, and folds back once it has been spotless this long. */
const SETTLED_LINGER_MS = 1400;

function hasMoved(view: DecorumView): boolean {
  return view.fraction > 0 || view.level !== 'calm';
}

export function createDecorumMeter(ctx: UiContext): MeterRail {
  const heading = h('span', { class: 'cp-side-label' });
  const fill = h('span', { class: 'cp-decorum-fill' });
  const bell = h('span', { class: 'cp-decorum-bell' }, icon('bell'));
  const track = h(
    'span',
    {
      class: 'cp-decorum-track',
      attrs: { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    },
    fill,
    h('span', { class: 'cp-decorum-ticks', attrs: { 'aria-hidden': 'true' } }),
  );
  const percent = h('span', { class: 'cp-decorum-percent', attrs: { 'aria-hidden': 'true' } });
  const status = h('span', { class: 'cp-decorum-status' });
  const rail = createMeterRail(ctx, {
    side: 'left',
    className: 'cp-decorum',
    testId: 'hud-decorum',
    spine: h('span', { class: 'cp-decorum-spine' }, bell, track),
    card: h('span', { class: 'cp-rail-text' }, heading, percent, status),
  });
  const root = rail.root;
  root.dataset.level = 'calm';

  const level = new SpringValue(0, SPRINGS.snappy, (value) => {
    root.style.setProperty('--cp-decorum', String(Math.min(1, Math.max(0, value))));
  });
  const shake = new SpringValue(0, SPRINGS.pop, (value) => {
    bell.style.rotate = value === 0 ? '' : `${value}deg`;
  });

  ctx.loc.text(heading, () => tr(ctx, 'decorum.label'));
  const describe = (view: DecorumView): void => {
    status.textContent = tr(ctx, LEVEL_KEYS[view.level]);
    const share = formatPercent(view.fraction, ctx.i18n.language);
    percent.textContent = share;
    track.setAttribute('aria-valuenow', String(Math.round(view.fraction * 100)));
    track.setAttribute('aria-label', tr(ctx, 'decorum.aria', { percent: share }));
  };

  ctx.own(
    watch(
      ctx.store,
      (s) => decorumView(s.decorum),
      (view, previous) => {
        root.dataset.level = view.level;
        void level.to(view.fraction);
        if (previous && view.fraction > previous.fraction) {
          shake.kick(view.level === 'calm' ? SHAKE_VELOCITY * 0.4 : SHAKE_VELOCITY);
        }
        rail.setOpen(hasMoved(view), SETTLED_LINGER_MS);
        describe(view);
      },
      sameView,
    ),
  );
  ctx.own(
    ctx.loc.bind(() => {
      describe(decorumView(ctx.store.getState().decorum));
    }),
  );
  return rail;
}

/** The Concierge's freeze notice: rings in under the balance and counts the table back in. */
export function createConciergeNotice(ctx: UiContext): HTMLElement {
  const title = h('span', { class: 'cp-notice-title' });
  const countdown = h('span', { class: 'cp-notice-countdown' });
  const bell = h('span', { class: 'cp-notice-bell' }, icon('bell'));
  const notice = h(
    'div',
    {
      class: 'cp-notice cp-panel',
      attrs: { role: 'status', 'data-testid': 'hud-concierge', hidden: '' },
    },
    bell,
    h('span', { class: 'cp-notice-text' }, title, countdown),
  );
  const drop = new SpringValue(0, SPRINGS.bouncy, (value) => {
    notice.style.translate = `0 ${(1 - value) * -24}px`;
    notice.style.opacity = String(Math.min(1, Math.max(0, value)));
  });

  ctx.loc.text(title, () => tr(ctx, 'decorum.frozenTitle'));
  const showCountdown = (seconds: number): void => {
    countdown.textContent = tr(ctx, 'decorum.frozenCountdown', { count: seconds });
  };
  ctx.own(
    watch(
      ctx.store,
      (s) => decorumView(s.decorum).frozenSeconds,
      (seconds, previous) => {
        if (seconds > 0) {
          showCountdown(seconds);
          if (!previous) {
            notice.hidden = false;
            drop.jump(0);
            void drop.to(1);
          }
        } else if (previous) {
          void drop.to(0, SPRINGS.snappy).then(() => {
            if (decorumView(ctx.store.getState().decorum).frozenSeconds === 0) notice.hidden = true;
          });
        }
      },
    ),
  );
  ctx.own(
    ctx.loc.bind(() => {
      const seconds = decorumView(ctx.store.getState().decorum).frozenSeconds;
      if (seconds > 0) showCountdown(seconds);
    }),
  );
  return notice;
}
