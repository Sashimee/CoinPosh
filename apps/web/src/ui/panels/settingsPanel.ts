import { MIXER_BUSES, MOTION_OPTIONS, QUALITY_OPTIONS, type Settings } from '../../app/settings.ts';
import { watch } from '../../app/store.ts';
import { LANGUAGES } from '../../i18n/index.ts';
import { tr, type UiContext } from '../context.ts';
import { h } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { createSegmented, createSlider, createToggle } from '../components/controls.ts';

function updateSettings(ctx: UiContext, patch: Partial<Settings>): void {
  ctx.store.setState((state) => ({ settings: { ...state.settings, ...patch } }));
}

function group(ctx: UiContext, iconName: IconName, titleKey: string, ...fields: HTMLElement[]) {
  const title = h('h3', { class: 'cp-section-title' }, icon(iconName), h('span'));
  const label = title.lastElementChild;
  if (label) ctx.loc.text(label, () => tr(ctx, titleKey));
  return h('section', { class: 'cp-section cp-settings-group' }, title, ...fields);
}

export function createSettingsPanel(ctx: UiContext): HTMLElement {
  const initial = ctx.store.getState().settings;

  const sliders = MIXER_BUSES.map((bus) => ({
    bus,
    control: createSlider(ctx, {
      id: `settings-volume-${bus}`,
      label: () => tr(ctx, `settings.${bus}`),
      value: initial.volumes[bus],
      onChange(value) {
        ctx.store.setState((state) => ({
          settings: { ...state.settings, volumes: { ...state.settings.volumes, [bus]: value } },
        }));
      },
    }),
  }));
  const mono = createToggle(ctx, {
    id: 'settings-mono',
    label: () => tr(ctx, 'settings.mono'),
    hint: () => tr(ctx, 'settings.monoHint'),
    value: initial.mono,
    onChange(value) {
      updateSettings(ctx, { mono: value });
    },
  });
  const haptics = createToggle(ctx, {
    id: 'settings-haptics',
    label: () => tr(ctx, 'settings.haptics'),
    hint: () => tr(ctx, 'settings.hapticsHint'),
    value: initial.haptics,
    onChange(value) {
      updateSettings(ctx, { haptics: value });
    },
  });
  const motionHint = h('p', { class: 'cp-field-hint' });
  ctx.loc.text(motionHint, () => tr(ctx, 'settings.reduceMotionHint'));
  const motion = createSegmented(ctx, {
    id: 'settings-motion',
    label: () => tr(ctx, 'settings.reduceMotion'),
    options: MOTION_OPTIONS.map((value) => ({
      value,
      label: () => tr(ctx, `settings.motion.${value}`),
    })),
    value: initial.motion,
    onChange(value) {
      updateSettings(ctx, { motion: value });
    },
  });
  motion.el.append(motionHint);
  const quality = createSegmented(ctx, {
    id: 'settings-quality',
    label: () => tr(ctx, 'settings.quality'),
    options: QUALITY_OPTIONS.map((value) => ({
      value,
      label: () => tr(ctx, `settings.qualityOption.${value}`),
    })),
    value: initial.quality,
    onChange(value) {
      updateSettings(ctx, { quality: value });
    },
  });
  const language = createSegmented(ctx, {
    id: 'settings-language',
    label: () => tr(ctx, 'settings.language'),
    options: LANGUAGES.map((value) => ({
      value,
      // Each language is named in itself so a player stuck in the wrong one can find theirs.
      label: () => ctx.i18n.t(`settings.languageName.${value}`, { lng: value }),
    })),
    value: initial.language,
    onChange(value) {
      updateSettings(ctx, { language: value });
    },
  });

  ctx.own(
    watch(
      ctx.store,
      (s) => s.settings,
      (settings) => {
        for (const { bus, control } of sliders) control.set(settings.volumes[bus]);
        mono.set(settings.mono);
        haptics.set(settings.haptics);
        motion.set(settings.motion);
        quality.set(settings.quality);
        language.set(settings.language);
      },
    ),
  );

  return h(
    'div',
    { class: 'cp-settings' },
    group(ctx, 'sound', 'settings.audio', ...sliders.map((s) => s.control.el), mono.el),
    group(ctx, 'feel', 'settings.feel', haptics.el, motion.el),
    group(ctx, 'display', 'settings.display', quality.el),
    group(ctx, 'language', 'settings.language', language.el),
  );
}
