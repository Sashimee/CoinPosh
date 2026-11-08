import { RARITIES, type Rarity } from '@coinposh/shared';
import type { Bus } from '../../app/bus.ts';
import type { AudioEngine, DuckOptions, ImpactEvent } from '../../audio/index.ts';
import type { CrateEvents, CrateStingerCue } from './events.ts';

export type CrateAudioPort = Pick<AudioEngine, 'duckMusic' | 'playImpact'>;

function rank(rarity: Rarity | null): number {
  return rarity === null ? 0 : RARITIES.indexOf(rarity);
}

/** Duck depth for a reveal: the rarer the crate, the further the music steps back. */
export function stingerDuck(rarity: Rarity | null, seconds: number): DuckOptions {
  return { depthDb: -8 - rank(rarity) * 2.5, attack: 0.04, hold: seconds, release: 0.9 };
}

/** The thuds and clacks under each stinger cue, voiced by the engine's modal impacts. */
export function stingerImpacts(
  cue: CrateStingerCue,
  rarity: Rarity | null,
  step: number,
): readonly ImpactEvent[] {
  const weight = rank(rarity);
  switch (cue) {
    case 'arrive':
      return [{ material: 'wood', velocity: 1.6 }];
    case 'teeter':
      return [{ material: 'wood', velocity: 0.5 }];
    case 'fall':
      return [{ material: 'wood', velocity: 2.2 }];
    case 'land':
      return [
        { material: 'wood', velocity: 2.4 },
        { material: 'metal', velocity: 0.9 },
      ];
    case 'shudder':
      return [{ material: 'metal', velocity: 0.5 + step * 0.35, pan: step % 2 === 0 ? 0.3 : -0.3 }];
    case 'rays':
      return [];
    case 'burst':
      return [
        { material: 'metal', velocity: 1.8 + weight * 0.2 },
        { material: 'coin', velocity: 1.4 + weight * 0.25, pan: -0.4 },
        { material: 'coin', velocity: 1.4 + weight * 0.25, pan: 0.4 },
      ];
    case 'collect':
      return [{ material: 'coin', velocity: 1.2 }];
  }
}

/** Wires crate stingers to the audio engine. Returns the unsubscribe. */
export function bindCrateAudio(events: Bus<CrateEvents>, audio: CrateAudioPort): () => void {
  return events.on('crate:stinger', ({ cue, rarity, step, duckSeconds }) => {
    if (duckSeconds > 0) audio.duckMusic(stingerDuck(rarity, duckSeconds));
    for (const impact of stingerImpacts(cue, rarity, step)) audio.playImpact(impact);
  });
}
