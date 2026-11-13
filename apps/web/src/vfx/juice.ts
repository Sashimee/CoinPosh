/** The numbered checklist in 03-ART-AUDIO-JUICE.md. Sound (1) is the audio engine's half. */
export const JUICE_ITEMS = {
  sound: 1,
  hapticOrShake: 2,
  particles: 3,
  squashOvershoot: 4,
  lightResponse: 5,
  numberPop: 6,
  timeManipulation: 7,
  camera: 8,
} as const;

export type JuiceItem = keyof typeof JUICE_ITEMS;

export type VfxEffect =
  | 'dropTrail'
  | 'contactSparks'
  | 'fusion'
  | 'fusionMid'
  | 'fusionCompact'
  | 'cascade'
  | 'obscene'
  | 'numberPop';

export interface EffectJuice {
  /** Items this module delivers on its own, before T-1.10 adds the sound. */
  readonly items: readonly JuiceItem[];
  /** When the call delivers fewer items than `items`, and why that is still enough. */
  readonly scope?: string;
  /** What survives `prefers-reduced-motion`. */
  readonly reduced: string;
}

/**
 * What each effect contributes to the checklist. The facade test (index.test.ts) fires
 * each effect and checks every listed item actually happens and that at least 4 do
 * without counting sound, so an interaction stays juicy even with audio muted.
 */
export const EFFECT_JUICE: Readonly<Record<VfxEffect, EffectJuice>> = {
  dropTrail: {
    items: ['particles', 'squashOvershoot', 'lightResponse', 'hapticOrShake'],
    reduced: 'Static tier-coloured motes along the path, no streaks or swirl, a lighter flash.',
  },
  contactSparks: {
    items: ['particles', 'lightResponse', 'hapticOrShake', 'squashOvershoot'],
    scope:
      'Strength above 0.45 only. Softer contacts are particles alone: the texture of the drop or push they belong to, which carries its own juice.',
    reduced:
      'A third of the sparks as slow glints, a flash that brightens without its scale pop, a haptic tick at most.',
  },
  fusion: {
    items: [
      'particles',
      'lightResponse',
      'squashOvershoot',
      'timeManipulation',
      'camera',
      'hapticOrShake',
    ],
    scope:
      'The full treatment, for the first fusion of the session, the first of each tier, and diamond and up at most once per 20 s; never two within 3 s or three within 30 s (a held-back first plays on the next fusion of its tier). Routine gold and platinum play the mid variant, routine copper and silver the compact one.',
    reduced:
      'Particles drift in instead of spiralling, the ring blooms in place, no shake or FOV kick; the hit-stop stays.',
  },
  fusionMid: {
    items: ['particles', 'lightResponse', 'squashOvershoot', 'hapticOrShake'],
    scope:
      'Routine gold and platinum, and diamond and up inside the 20 s rest: a brighter flash haloed in the tier metal, a small double ring, a double spark crown and a tap, no hit-stop or camera. Another mid within 0.9 s plays compact. The tier-up chime is the audio half.',
    reduced:
      'Fewer sparks as slow glints, the flash brightens without its pop, both rings bloom in place at half strength, a tap.',
  },
  fusionCompact: {
    items: ['particles', 'lightResponse', 'squashOvershoot', 'hapticOrShake'],
    scope:
      'Routine copper and silver fusions, and gold-or-better ones right after a mid: a warm white-gold flash about three coins wide with a tap, no hit-stop or camera. The tier-up chime is the audio half.',
    reduced:
      'Fewer sparks as slow glints, the flash brightens without its pop, the small ring blooms in place.',
  },
  cascade: {
    items: ['particles', 'lightResponse', 'squashOvershoot', 'hapticOrShake', 'camera'],
    scope: 'The camera shiver starts at OPULENT; CHIC and LAVISH deliver the other four.',
    reduced: 'Fewer, slower fizz motes and a softer bloom; no camera shake.',
  },
  obscene: {
    items: [
      'particles',
      'lightResponse',
      'timeManipulation',
      'camera',
      'hapticOrShake',
      'squashOvershoot',
    ],
    reduced: 'A light drift of confetti with no cannons, no slow-mo or shake, a long soft glow.',
  },
  numberPop: {
    items: ['numberPop', 'squashOvershoot', 'lightResponse', 'particles'],
    reduced: 'The value fades in and out where it was earned; no arc, burst or prism animation.',
  },
};

/** The checklist bar every player interaction has to clear (03-ART-AUDIO-JUICE.md). */
export const JUICE_MINIMUM = 4;

/** Which layer of the game delivers a checklist item. */
export type JuiceChannel = 'vfx' | 'audio' | 'haptics' | 'camera' | 'ui';

export interface JuiceCredit {
  readonly item: JuiceItem;
  readonly channel: JuiceChannel;
  /** Set when the item comes from a facade effect, whose own juice index.test.ts measures. */
  readonly effect?: VfxEffect;
  /** Repo-relative path of the code that delivers the item. */
  readonly at: string;
  /** Text in `at` that delivers it; juice.test.ts fails if the code no longer says it. */
  readonly proof: string;
}

/** What an interaction still owes the checklist, and who owns the code that would pay it. */
export interface JuiceFollowUp {
  readonly owners: readonly string[];
  readonly adds: readonly JuiceItem[];
  /** Existing effects the fix would fire. */
  readonly effects?: readonly VfxEffect[];
  /** The POLISH.md item already tracking it, when there is one. */
  readonly tracked?: string;
  readonly plan: string;
}

export interface InteractionJuice {
  readonly credits: readonly JuiceCredit[];
  /** When some instances deliver fewer items than the credits, and why. */
  readonly scope?: string;
  readonly reduced: string;
  /** Only on an interaction that is truly under `JUICE_MINIMUM` today. */
  readonly followUp?: JuiceFollowUp;
}

export const SLICE_INTERACTIONS = [
  'tapAim',
  'drop',
  'pour',
  'nudge',
  'contact',
  'fusionCompact',
  'fusionMid',
  'fusionFull',
  'cascadeChic',
  'cascadeLavish',
  'cascadeOpulent',
  'cascadeDecadent',
  'obscene',
  'numberPop',
  'crateSpawn',
  'crateFall',
  'crateUnbox',
  'crateCollect',
  'upgradeBuy',
  'firstUpgradeNudge',
  'ascensionEntry',
] as const;

export type SliceInteraction = (typeof SLICE_INTERACTIONS)[number];

const WEB = 'apps/web/src';
const MAIN = `${WEB}/main.ts`;
const CUES = `${WEB}/app/feedback.ts`;
const CORE = `${WEB}/game/systems/core.ts`;
const GLUE = `${WEB}/game/systems/feedback.ts`;
const OVERLAY = `${WEB}/game/systems/overlay.ts`;
const OVERLAY_CSS = `${WEB}/game/systems/systems.css`;
const FACADE = `${WEB}/vfx/index.ts`;
const DECORUM = `${WEB}/ui/components/decorumMeter.ts`;
const PLAQUE = `${WEB}/ui/components/balancePlaque.ts`;
const TIER_STAMP = `${WEB}/ui/components/tierStamp.ts`;
const LADDER = `${WEB}/ui/components/comboLadder.ts`;
const PRESSABLE = `${WEB}/ui/components/pressable.ts`;
const UPGRADE_HINT = `${WEB}/ui/components/upgradeNudge.ts`;
const UPGRADES_PANEL = `${WEB}/ui/panels/upgradesPanel.ts`;
const UI_CSS = `${WEB}/ui/styles.css`;
const UPGRADE_CHIME = `${WEB}/game/upgrades/feedback.ts`;
const CRATE_MOUNT = `${WEB}/game/crates/mount.ts`;
const CRATE_VIEW = `${WEB}/game/crates/view.ts`;
const CRATE_AUDIO = `${WEB}/game/crates/audio.ts`;
const REVEAL_CARD = `${WEB}/game/crates/revealCard.ts`;
const UNBOX = `${WEB}/vfx/cinematics/unbox/cinematic.ts`;
const UNBOX_PLAN = `${WEB}/vfx/cinematics/unbox/plan.ts`;
const ASCEND = `${WEB}/vfx/cinematics/ascend/cinematic.ts`;
const ASCEND_PLAN = `${WEB}/vfx/cinematics/ascend/plan.ts`;

const PRESS_CUE = "kind: poured ? 'tick' : 'tap'";
const TAP_CUE = "tap: { sound: { material: 'wood', velocity: 0.55 }, haptic: 8 }";
const TICK_CUE = "tick: { sound: { material: 'coin', velocity: 0.14 }, haptic: 4 }";
const CONFIRM_CUE = "confirm: { sound: { material: 'coin', velocity: 1.6 }, haptic: [14, 40, 22] }";
const OPEN_CUE = "open: { sound: { material: 'metal', velocity: 0.7 }, haptic: 12 }";
const FUSION_CALL =
  'effects.fusion({ sources: sources.map(at), center: at(center), tier, onImpact: strike });';
const FUSION_STRIKE = 'const strike = (): void => {';
const CASCADE_CALL = 'vfx()?.cascade(tier, { origin: at(lastFrontFall) });';

function channelOf(item: JuiceItem): JuiceChannel {
  if (item === 'sound') return 'audio';
  if (item === 'hapticOrShake') return 'haptics';
  if (item === 'camera') return 'camera';
  return 'vfx';
}

/** Credits an effect's measured items to the call site that fires it. */
function fromEffect(
  effect: VfxEffect,
  at: string,
  proof: string,
  items: readonly JuiceItem[] = EFFECT_JUICE[effect].items,
): JuiceCredit[] {
  return items.map((item) => ({ item, channel: channelOf(item), effect, at, proof }));
}

const comboSound: readonly JuiceCredit[] = [
  { item: 'sound', channel: 'audio', at: GLUE, proof: 'audio()?.comboStep(count);' },
  { item: 'sound', channel: 'audio', at: GLUE, proof: 'audio()?.setComboTier(rank);' },
];

const comboUi: readonly JuiceCredit[] = [
  {
    item: 'squashOvershoot',
    channel: 'ui',
    at: TIER_STAMP,
    proof: 'const impact = new SpringValue(0, SPRINGS.bouncy, (value) => {',
  },
  {
    item: 'squashOvershoot',
    channel: 'ui',
    at: LADDER,
    proof: 'const fill = new SpringValue(0, SPRINGS.bouncy, (value) => {',
  },
];

const CASCADE_REDUCED = `${EFFECT_JUICE.cascade.reduced} The ladder note and the tier stamp still land, without their spring.`;

function cascadeTier(withCamera: boolean): InteractionJuice {
  const items = withCamera
    ? EFFECT_JUICE.cascade.items
    : EFFECT_JUICE.cascade.items.filter((item) => item !== 'camera');
  return {
    credits: [...fromEffect('cascade', GLUE, CASCADE_CALL, items), ...comboSound, ...comboUi],
    reduced: CASCADE_REDUCED,
  };
}

function fusionTier(effect: 'fusion' | 'fusionMid' | 'fusionCompact'): InteractionJuice {
  return {
    credits: [
      ...fromEffect(effect, GLUE, FUSION_CALL),
      { item: 'sound', channel: 'audio', at: GLUE, proof: FUSION_STRIKE },
    ],
    scope: EFFECT_JUICE[effect].scope ?? '',
    reduced: EFFECT_JUICE[effect].reduced,
  };
}

/**
 * The slice audit (T-1.18): every player interaction against the checklist, with the code
 * that delivers each item. juice.test.ts holds each to `JUICE_MINIMUM`, checks every proof
 * is still in its file, and keeps the follow-ups honest for the ones that fall short.
 */
export const INTERACTION_JUICE: Readonly<Record<SliceInteraction, InteractionJuice>> = {
  tapAim: {
    credits: [
      { item: 'sound', channel: 'audio', at: MAIN, proof: PRESS_CUE },
      { item: 'sound', channel: 'audio', at: CUES, proof: TAP_CUE },
      { item: 'hapticOrShake', channel: 'haptics', at: CUES, proof: TAP_CUE },
      { item: 'squashOvershoot', channel: 'ui', at: OVERLAY, proof: "' scale(0.82)'" },
      {
        item: 'squashOvershoot',
        channel: 'ui',
        at: OVERLAY_CSS,
        proof: 'transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    ],
    reduced:
      'The reticle snaps to pressed and back without its spring; the clack and the haptic stay.',
    followUp: {
      owners: [GLUE, OVERLAY, OVERLAY_CSS],
      adds: ['particles', 'lightResponse'],
      effects: ['dropTrail'],
      tracked: 'P-177',
      plan: 'Wire the drop trail (see drop) so its tier swirl and flash answer the tap at the reticle, and give the reticle a brief gold bloom ring on press.',
    },
  },
  drop: {
    credits: [
      { item: 'sound', channel: 'audio', at: MAIN, proof: PRESS_CUE },
      { item: 'hapticOrShake', channel: 'haptics', at: CUES, proof: TAP_CUE },
    ],
    scope:
      'The coin appears with no spin-in: Vfx.dropTrail exists and is measured, but nothing calls it in play. The first-contact clink is the contact interaction.',
    reduced: EFFECT_JUICE.dropTrail.reduced,
    followUp: {
      owners: [GLUE],
      adds: ['particles', 'squashOvershoot', 'lightResponse'],
      effects: ['dropTrail'],
      tracked: 'P-57',
      plan: "On 'coin:spawned' call vfx.dropTrail(position, { tier }) (add it to FeedbackVfx), move the trail with the coin until its first contact, then end it.",
    },
  },
  pour: {
    credits: [
      { item: 'sound', channel: 'audio', at: MAIN, proof: PRESS_CUE },
      { item: 'sound', channel: 'audio', at: CUES, proof: TICK_CUE },
      {
        item: 'sound',
        channel: 'audio',
        at: CORE,
        proof: "if (result.grade === 'perfect') ui.feedback('confirm');",
      },
      { item: 'hapticOrShake', channel: 'haptics', at: CUES, proof: TICK_CUE },
      { item: 'hapticOrShake', channel: 'haptics', at: CUES, proof: CONFIRM_CUE },
      {
        item: 'lightResponse',
        channel: 'ui',
        at: OVERLAY_CSS,
        proof: 'box-shadow: 0 0 10px var(--cp-sea-glass);',
      },
      {
        item: 'squashOvershoot',
        channel: 'ui',
        at: OVERLAY_CSS,
        proof: 'animation: cp-sys-beat 240ms ease-in-out infinite alternate;',
      },
      {
        item: 'squashOvershoot',
        channel: 'ui',
        at: OVERLAY_CSS,
        proof: 'animation: cp-sys-stamp 1400ms cubic-bezier(0.34, 1.56, 0.64, 1) both;',
      },
    ],
    scope:
      'Every poured coin ticks; the beat marker glows and throbs inside the window, and only a Perfect Pour rings the confirm cue under its stamp.',
    reduced:
      'The marker widens instead of throbbing and the grade stamp fades in place; every tick and the confirm cue stay.',
  },
  nudge: {
    credits: [
      {
        item: 'sound',
        channel: 'audio',
        at: GLUE,
        proof: 'velocity: (0.4 + 0.6 * strength) * HARDEST_IMPACT_METRES_PER_S',
      },
      { item: 'sound', channel: 'audio', at: CORE, proof: "ui.feedback('tick');" },
      {
        item: 'hapticOrShake',
        channel: 'camera',
        at: GLUE,
        proof: 'vfx()?.cameraKick({ shake: 0.2 + 0.3 * strength });',
      },
      { item: 'hapticOrShake', channel: 'haptics', at: CUES, proof: TICK_CUE },
      {
        item: 'squashOvershoot',
        channel: 'ui',
        at: DECORUM,
        proof: "shake.kick(view.level === 'calm' ? SHAKE_VELOCITY * 0.4 : SHAKE_VELOCITY);",
      },
    ],
    reduced:
      'No camera shake and the Decorum bell does not swing; the wooden thump, the tick and its haptic stay.',
    followUp: {
      owners: [GLUE, FACADE],
      adds: ['particles', 'lightResponse'],
      plan: 'Add a nudge effect to the facade (felt dust puffed off the front rail on the push side and a brass glint along the cabinet edge, scaled by strength; reduced: a still glint) and call it from the nudge handler.',
    },
  },
  contact: {
    credits: [
      ...fromEffect(
        'contactSparks',
        GLUE,
        'vfx()?.contactSparks(at(position), { strength, surface });',
      ),
      { item: 'sound', channel: 'audio', at: GLUE, proof: 'material: surface,' },
    ],
    scope: EFFECT_JUICE.contactSparks.scope ?? '',
    reduced: EFFECT_JUICE.contactSparks.reduced,
  },
  fusionCompact: fusionTier('fusionCompact'),
  fusionMid: fusionTier('fusionMid'),
  fusionFull: fusionTier('fusion'),
  cascadeChic: cascadeTier(false),
  cascadeLavish: cascadeTier(false),
  cascadeOpulent: cascadeTier(true),
  cascadeDecadent: cascadeTier(true),
  obscene: {
    credits: [
      ...fromEffect('cascade', GLUE, CASCADE_CALL),
      ...fromEffect('obscene', FACADE, "if (tier === 'obscene') this.obscene(origin);"),
      ...comboSound,
      ...comboUi,
    ],
    reduced: `${EFFECT_JUICE.obscene.reduced} The top ladder note and the stamp still play.`,
  },
  numberPop: {
    credits: [
      ...fromEffect(
        'numberPop',
        GLUE,
        'vfx()?.numberPop(amount, at(position ?? lip), vault, tier ? { tier } : {});',
      ),
      { item: 'squashOvershoot', channel: 'ui', at: PLAQUE, proof: 'pop.kick(POP_VELOCITY);' },
      {
        item: 'lightResponse',
        channel: 'ui',
        at: PLAQUE,
        proof: "restartAnimation(plaque, 'is-gaining');",
      },
    ],
    scope:
      'Silent on purpose: the lip clink of the fall that earned the credit plays at the same moment.',
    reduced: `${EFFECT_JUICE.numberPop.reduced} The Vault rolls to the new total without its swell.`,
  },
  crateSpawn: {
    credits: [
      {
        item: 'sound',
        channel: 'audio',
        at: CRATE_MOUNT,
        proof:
          "events.emit('crate:stinger', { cue: 'arrive', rarity: null, step: 1, duckSeconds: 0 });",
      },
      { item: 'sound', channel: 'audio', at: CRATE_AUDIO, proof: "case 'arrive':" },
      {
        item: 'hapticOrShake',
        channel: 'haptics',
        at: CRATE_MOUNT,
        proof: "options.haptics?.pulse('tap');",
      },
      {
        item: 'squashOvershoot',
        channel: 'vfx',
        at: CRATE_VIEW,
        proof: 'const squash = reducedMotion ? 1 : 1 - Math.sin(crate.arrive * Math.PI) * 0.18;',
      },
      {
        item: 'lightResponse',
        channel: 'vfx',
        at: CRATE_VIEW,
        proof: 'lerp(BREATHE_LOW, 1, 0.5 + 0.5 * Math.sin((t / BREATHE_S) * Math.PI * 2))',
      },
      {
        item: 'lightResponse',
        channel: 'vfx',
        at: CRATE_VIEW,
        proof: 'const GLINT_DELAY_S = ARRIVE_S;',
      },
    ],
    reduced:
      'The crate is in place from its first frame with a still sheen and a steady seam glow; the thud and the tap stay.',
  },
  crateFall: {
    credits: [
      {
        item: 'sound',
        channel: 'audio',
        at: CRATE_MOUNT,
        proof:
          "events.emit('crate:stinger', { cue: 'teeter', rarity: null, step: 1, duckSeconds: 0 });",
      },
      {
        item: 'sound',
        channel: 'audio',
        at: CRATE_MOUNT,
        proof:
          "events.emit('crate:stinger', { cue: 'fall', rarity: null, step: 1, duckSeconds: 0 });",
      },
      {
        item: 'hapticOrShake',
        channel: 'haptics',
        at: CRATE_MOUNT,
        proof: "options.haptics?.pulse('tick');",
      },
      {
        item: 'lightResponse',
        channel: 'vfx',
        at: CRATE_VIEW,
        proof: '? TEETER_GLOW + 0.25 * Math.sin((t / TEETER_PULSE_S) * Math.PI * 2)',
      },
      {
        item: 'squashOvershoot',
        channel: 'vfx',
        at: CRATE_VIEW,
        proof: 'const squash = k >= 1 ? 1 : 1 - Math.max(0, (k - 0.85) / 0.15) * 0.12;',
      },
    ],
    scope: 'The camera dolly-in on the landing is the first beat of the unbox, credited there.',
    reduced:
      'The crate cuts to the tray without its tumble and the seam holds a steady glow; the teeter creak, the fall thud and the tick stay.',
  },
  crateUnbox: {
    credits: [
      { item: 'sound', channel: 'audio', at: CRATE_AUDIO, proof: "case 'burst':" },
      {
        item: 'hapticOrShake',
        channel: 'haptics',
        at: UNBOX,
        proof: 'haptics?.pulse(burst.haptic);',
      },
      {
        item: 'particles',
        channel: 'vfx',
        at: UNBOX,
        proof: "vfx?.contactSparks(top, { strength: BURST_SPARKS, surface: 'metal' });",
      },
      { item: 'squashOvershoot', channel: 'vfx', at: UNBOX_PLAN, proof: 'const SPRING_MS = 380;' },
      { item: 'lightResponse', channel: 'vfx', at: UNBOX_PLAN, proof: 'glow: 0.5 + rank * 0.3,' },
      { item: 'numberPop', channel: 'ui', at: REVEAL_CARD, proof: "'--cp-crate-stagger'" },
      {
        item: 'timeManipulation',
        channel: 'vfx',
        at: UNBOX,
        proof: 'if (burst.hitStopMs > 0) vfx?.hitStop(burst.hitStopMs);',
      },
      {
        item: 'camera',
        channel: 'camera',
        at: UNBOX_PLAN,
        proof:
          'const dollyIn = reducedMotion ? 0 : easeInOutCubic(progress(t, 0, timeline.dollyMs));',
      },
      {
        item: 'camera',
        channel: 'camera',
        at: UNBOX,
        proof: 'vfx?.cameraKick({ shake: burst.shake, fov: burst.fovKick });',
      },
    ],
    scope: 'The burst escalates with rarity; hit-stop and the FOV kick grow with it.',
    reduced:
      'No hop, spin, squash, dolly, lid shake or flight: the crate rests centre stage, the rays fade up, the burst is a flare of light, and the item appears on its pedestal with its rewards.',
  },
  crateCollect: {
    credits: [
      {
        item: 'sound',
        channel: 'audio',
        at: CRATE_VIEW,
        proof: "this.stinger('collect', playing.opened.roll.rarity, 1, 0);",
      },
      { item: 'sound', channel: 'audio', at: REVEAL_CARD, proof: "feedback: 'confirm'," },
      { item: 'hapticOrShake', channel: 'haptics', at: CUES, proof: CONFIRM_CUE },
      {
        item: 'squashOvershoot',
        channel: 'ui',
        at: PRESSABLE,
        proof: 'export const PRESSED_SCALE = 0.96;',
      },
      { item: 'numberPop', channel: 'ui', at: PLAQUE, proof: "'hud.wallet.gain'" },
      {
        item: 'particles',
        channel: 'ui',
        at: PLAQUE,
        proof: 'sparkle(into, rectOf(target), line.currency);',
      },
    ],
    scope:
      'Every roll carries a coin line, so each collect flies at least one value into the HUD and sparkles where it lands.',
    reduced:
      'The card skips its flight and the wallet lands at once; the press still answers, the Collect stinger and the confirm haptic stay.',
  },
  upgradeBuy: {
    credits: [
      { item: 'sound', channel: 'audio', at: UPGRADE_CHIME, proof: 'export const PURCHASE_CHIME' },
      { item: 'sound', channel: 'audio', at: UPGRADES_PANEL, proof: "feedback: 'confirm'," },
      {
        item: 'hapticOrShake',
        channel: 'haptics',
        at: UPGRADE_CHIME,
        proof: 'PURCHASE_HAPTIC: HapticPattern = [12, 58, 14, 66, 30]',
      },
      {
        item: 'squashOvershoot',
        channel: 'ui',
        at: UPGRADES_PANEL,
        proof: 'medal.jump(MEDAL_SQUASH);',
      },
      {
        item: 'lightResponse',
        channel: 'ui',
        at: UPGRADES_PANEL,
        proof: 'glow.jump(LEVEL_UP_GLOW);',
      },
      {
        item: 'lightResponse',
        channel: 'ui',
        at: UI_CSS,
        proof: '.cp-upgrade.is-celebrating .cp-upgrade-glint {',
      },
      {
        item: 'numberPop',
        channel: 'ui',
        at: UI_CSS,
        proof: '.cp-upgrade.is-celebrating .cp-upgrade-pop {',
      },
    ],
    scope: 'Plays when the server confirms the level; a refusal shows its reason instead.',
    reduced:
      'The row turns calm: it flares without the glint sweep or medallion squash and the new value fades in place; the chime and haptic stay.',
  },
  firstUpgradeNudge: {
    credits: [
      {
        item: 'sound',
        channel: 'audio',
        at: UPGRADE_HINT,
        proof: "if (hasBeenActivated(navigator)) feedback(ctx, 'open');",
      },
      { item: 'sound', channel: 'audio', at: CUES, proof: OPEN_CUE },
      { item: 'hapticOrShake', channel: 'haptics', at: CUES, proof: OPEN_CUE },
      {
        item: 'squashOvershoot',
        channel: 'ui',
        at: UPGRADE_HINT,
        proof: 'const drop = new SpringValue(0, SPRINGS.bouncy, (value) => {',
      },
      {
        item: 'lightResponse',
        channel: 'ui',
        at: UPGRADE_HINT,
        proof: "restartAnimation(notice, 'is-glinting');",
      },
      {
        item: 'lightResponse',
        channel: 'ui',
        at: UPGRADE_HINT,
        proof: "restartAnimation(trigger, 'is-beckoning');",
      },
    ],
    scope:
      'Before the page has had a gesture the browser blocks audio and vibrate(), so the sound and haptic wait for the first touch.',
    reduced:
      'The line appears without its drop or glint and the Upgrades button keeps a steady glow instead of its pulse; the sound and haptic stay.',
  },
  ascensionEntry: {
    credits: [
      {
        item: 'sound',
        channel: 'audio',
        at: ASCEND,
        proof: 'for (const sound of cue.sounds) audio?.playImpact(sound);',
      },
      {
        item: 'hapticOrShake',
        channel: 'haptics',
        at: ASCEND,
        proof: 'if (cue.haptic !== null) this.options.haptic?.(cue.haptic);',
      },
      { item: 'hapticOrShake', channel: 'ui', at: ASCEND, proof: "'--cp-ascend-shake'" },
      {
        item: 'particles',
        channel: 'ui',
        at: ASCEND,
        proof: 'makeSparks(sparkCount(options.goldBars), options.seed ?? options.goldBars)',
      },
      { item: 'squashOvershoot', channel: 'ui', at: ASCEND_PLAN, proof: 'stampSlam(stamped)' },
      {
        item: 'lightResponse',
        channel: 'ui',
        at: ASCEND,
        proof: "el.style.setProperty('--cp-ascend-flash', pose.flash.toFixed(3));",
      },
      {
        item: 'numberPop',
        channel: 'ui',
        at: ASCEND,
        proof: 'const shown = Math.round(this.options.goldBars * pose.count);',
      },
      {
        item: 'timeManipulation',
        channel: 'ui',
        at: ASCEND,
        proof: "const stampReal = this.beatAt('stamp') + this.timeline.hitStopMs;",
      },
      {
        item: 'camera',
        channel: 'camera',
        at: ASCEND,
        proof: 'const depth = pose.sink * SINK_DEPTH * 100;',
      },
    ],
    reduced:
      'No sink, slam, shake, sparks, hit-stop or rise: the curtain fades in over a dimmed table, the Gold Bars appear at their final value with the beat sounds and haptics, and the curtain fades out on the next venue.',
  },
};

/** The distinct checklist items an interaction delivers today. */
export function juiceItemsOf(row: Pick<AuditableRow, 'credits'>): ReadonlySet<JuiceItem> {
  return new Set(row.credits.map((credit) => credit.item));
}

/** A row as the audit reads it: effect names are plain strings so a stale one can be caught. */
export interface AuditableRow {
  readonly credits: readonly {
    readonly item: JuiceItem;
    readonly effect?: string;
    readonly at: string;
    readonly proof: string;
  }[];
  readonly reduced: string;
  readonly followUp?: {
    readonly owners: readonly string[];
    readonly adds: readonly JuiceItem[];
    readonly effects?: readonly string[];
    readonly plan: string;
  };
}

/**
 * Every way a table breaks the checklist, one message per problem; empty when it holds. An
 * interaction under the minimum passes only with a follow-up that names its owner and would
 * lift it over the bar, and a follow-up on one already over the bar is stale.
 */
export function auditJuice(
  table: Readonly<Record<string, AuditableRow>>,
  effects: Readonly<Record<string, EffectJuice>> = EFFECT_JUICE,
): string[] {
  const problems: string[] = [];
  const effectNamed = (name: string): EffectJuice | undefined =>
    Object.hasOwn(effects, name) ? effects[name] : undefined;
  for (const [name, row] of Object.entries(table)) {
    const items = juiceItemsOf(row);
    for (const credit of row.credits) {
      if (!Object.hasOwn(JUICE_ITEMS, credit.item)) {
        problems.push(`${name}: "${credit.item}" is not a checklist item`);
      }
      if (credit.effect === undefined) continue;
      const effect = effectNamed(credit.effect);
      if (!effect) {
        problems.push(`${name}: names effect "${credit.effect}", which does not exist`);
      } else if (!effect.items.includes(credit.item)) {
        problems.push(`${name}: effect "${credit.effect}" does not deliver ${credit.item}`);
      }
    }
    if (row.reduced.trim().length === 0) problems.push(`${name}: has no reduced-motion variant`);
    const follow = row.followUp;
    if (!follow) {
      if (items.size < JUICE_MINIMUM) {
        problems.push(
          `${name}: delivers ${items.size} checklist items (${[...items].join(', ')}), under ${JUICE_MINIMUM}, with no follow-up`,
        );
      }
      continue;
    }
    if (items.size >= JUICE_MINIMUM) {
      problems.push(`${name}: already delivers ${items.size} items, so its follow-up is stale`);
    }
    if (follow.owners.length === 0) problems.push(`${name}: follow-up names no owning path`);
    if (follow.plan.trim().length === 0) problems.push(`${name}: follow-up has no plan`);
    for (const item of follow.adds) {
      if (items.has(item)) problems.push(`${name}: follow-up adds ${item}, which it already has`);
    }
    const promised = new Set<JuiceItem>([...items, ...follow.adds]);
    if (promised.size < JUICE_MINIMUM) {
      problems.push(`${name}: its follow-up only reaches ${promised.size} items`);
    }
    for (const effectName of follow.effects ?? []) {
      if (!effectNamed(effectName)) {
        problems.push(`${name}: follow-up names effect "${effectName}", which does not exist`);
      }
    }
  }
  return problems;
}
