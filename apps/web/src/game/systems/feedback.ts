import { Vector3 } from 'three/webgpu';
import type { AudioEngine } from '../../audio/index.ts';
import { CONTACT_ACCENT, type Vfx } from '../../vfx/index.ts';
import type { Bus } from '../../app/bus.ts';
import { RIVIERA_TABLE } from '../../scene/venues/riviera/layout.ts';
import type { GameEvents, TablePoint } from './events.ts';
import type { TableBounds } from './tableWatch.ts';

export type FeedbackVfx = Pick<
  Vfx,
  'contactSparks' | 'fusion' | 'cascade' | 'numberPop' | 'cameraKick'
>;
export type FeedbackAudio = Pick<
  AudioEngine,
  'playImpact' | 'comboStep' | 'setComboTier' | 'duckMusic'
>;

export interface FeedbackTargets {
  /** Read on every event, so effects that come up after the systems still get what follows. */
  readonly vfx: () => FeedbackVfx | null;
  readonly audio: () => FeedbackAudio | null;
  /** The HUD element credited coins fly into: the Vault plaque. */
  readonly vault: Element;
  readonly bounds?: TableBounds;
}

/**
 * The closing speed the audio treats as its hardest hit (IMPACT_VELOCITY_CEIL in
 * audio/synth/impactSpec.ts), which a contact at full strength is voiced at.
 */
const HARDEST_IMPACT_METRES_PER_S = 2.8;

/**
 * A coin tipping over the brass lip: loud enough to clink and, just past the accent line, to
 * flash, so a fall is never silent even when the server pays nothing for it.
 */
const LIP_STRENGTH = CONTACT_ACCENT + 0.1;

/**
 * What the player sees and hears for each thing the gameplay glue reports. Only `credited`
 * values fly to the Vault as money: they are what the server paid. Returns the unsubscribe.
 */
export function wireFeedback(events: Bus<GameEvents>, targets: FeedbackTargets): () => void {
  const { vfx, audio, vault } = targets;
  const bounds = targets.bounds ?? RIVIERA_TABLE;
  const at = (point: TablePoint): Vector3 => new Vector3(point.x, point.y, point.z);
  const pan = (x: number): number => Math.max(-1, Math.min(1, x / bounds.fieldHalfWidth));
  const lip: TablePoint = { x: 0, y: 0, z: bounds.fieldFrontZ };
  let lastFrontFall = lip;
  const offs = [
    events.on('coin:contact', ({ position, strength, surface }) => {
      audio()?.playImpact({
        material: surface,
        velocity: strength * HARDEST_IMPACT_METRES_PER_S,
        pan: pan(position.x),
      });
      vfx()?.contactSparks(at(position), { strength, surface });
    }),
    events.on('coin:fusion', ({ sources, center, tier }) => {
      const strike = (): void => {
        audio()?.playImpact({
          material: 'metal',
          velocity: HARDEST_IMPACT_METRES_PER_S,
          pan: pan(center.x),
        });
      };
      const effects = vfx();
      if (effects) {
        effects.fusion({ sources: sources.map(at), center: at(center), tier, onImpact: strike });
      } else {
        strike();
      }
    }),
    events.on('coin:fell', ({ edge, position }) => {
      if (edge !== 'front') return;
      lastFrontFall = position;
      audio()?.playImpact({
        material: 'metal',
        velocity: LIP_STRENGTH * HARDEST_IMPACT_METRES_PER_S,
        pan: pan(position.x),
      });
      vfx()?.contactSparks(at(position), { strength: LIP_STRENGTH, surface: 'metal' });
    }),
    events.on('cascade:step', ({ count }) => {
      audio()?.comboStep(count);
    }),
    events.on('cascade:tier', ({ tier, rank }) => {
      audio()?.setComboTier(rank);
      vfx()?.cascade(tier, { origin: at(lastFrontFall) });
    }),
    events.on('cascade:end', () => {
      audio()?.setComboTier(0);
    }),
    events.on('value:credited', ({ amount, tier, position }) => {
      vfx()?.numberPop(amount, at(position ?? lip), vault, tier ? { tier } : {});
    }),
    events.on('nudge', ({ strength }) => {
      audio()?.playImpact({
        material: 'wood',
        velocity: (0.4 + 0.6 * strength) * HARDEST_IMPACT_METRES_PER_S,
        pan: 0,
      });
      vfx()?.cameraKick({ shake: 0.2 + 0.3 * strength });
    }),
    events.on('concierge:freeze', () => {
      audio()?.duckMusic();
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
