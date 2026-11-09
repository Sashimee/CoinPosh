import { COIN } from '../coin.ts';
import { DROP_ZONE } from '../table/layout.ts';

/**
 * Contact Fusion, physical side. How long the contact must last and how many coins
 * fuse are economy rules (FusionRules, from packages/economy); these values only
 * decide what counts as touching and where the new coin appears.
 *
 * - touchGap 1 mm: every coin carries a 0.3 mm contact skin (COIN_MATERIAL), so two
 *   coins resting against each other sit about 0.6 mm apart. On PusherTable its
 *   separation pass (TABLE_SOLVER.separationSlop) keeps them within 0.2 mm of
 *   overlap; MechanicsRig, where the mechanics tests run, has no such pass and leaves
 *   that to the solver, so a pair there can sit a little deeper. 1 mm counts every
 *   resting contact, flat or edge on, while two coins a visible hair apart do not fuse.
 * - graceTicks 3 (50 ms): a pile under the pusher jostles, and a pair that bounces
 *   apart for a tick or two is still, to the player, three coins that sat together.
 *   Longer than that and the coins visibly separated, so the clock starts over.
 * - spawnLift 1.5 mm: the fused coin appears this far above the highest of its
 *   inputs, at their centroid, and settles with a soft clack instead of being planted
 *   into the coins around it. The renderer plays the hop; the sim only lands it.
 * - sampleTicks 3: a pair is looked at only on the ticks its lower id is due, every
 *   third tick (20 Hz), which splits the contact search over three ticks to keep it in
 *   the step budget. A contact is seen up to 2 ticks late (33 ms) and a fusion fires up
 *   to 2 ticks after its window, which no player can tell. The grace is stretched by
 *   the period, so a pair found apart on one look, however briefly, is forgiven.
 *
 * Which coins may fuse at all (P-222). Without a rule, the opening heap's second layer,
 * which rests on the coins below it from the first tick, fused away 24 of 100 coins at
 * 1.4 s, and fresh drops fused where they landed before they could add to the pile.
 *
 * - spawnGraceTicks 60 (1 s): a coin that enters the table during play (a drop, a
 *   fused coin, a coin a topple releases) sits out of fusion for its first second. A
 *   chute drop lands and settles in about half that, so it joins the heap first and
 *   then charges up with its neighbours; a fused coin hops, lands and is seen before
 *   it can chain. The 1 s also covers the server's minFusionMsAfterSpawn (250 ms).
 * - settledShift 2.6 mm (one coin thickness): a coin laid before the first tick (the
 *   opening heap, a restored table) is settled and never fuses on age alone, since
 *   the heap is laid touching and would otherwise all fuse the moment a grace ran out.
 *   It joins play once its height has changed by more than a coin's thickness from
 *   where it was laid: it slid off the coins under it (3.2 mm), tumbled off the upper
 *   tier (35 mm) or was shoved up onto another coin. Sliding across its own floor does
 *   not count, so the pusher packing the bottom sheet, or the upper tier riding the
 *   block, does not wake the whole heap. Seeded runs at 1 drop/s onto the 100-coin
 *   silver heap: no heap coin fuses in the first 8 s, the first fusion (three copper
 *   drops) comes at 4 to 8 s, and 12 to 18 fusions fire in the first minute.
 */
export const FUSION_TUNING = {
  touchGap: 0.001,
  graceTicks: 3,
  spawnLift: 0.0015,
  sampleTicks: 3,
  spawnGraceTicks: 60,
  settledShift: 2 * COIN.halfThickness,
} as const;

/** Where the Champagne Tower pedestal stands on the upper tier, in metres. */
export interface TowerPlacement {
  readonly x: number;
  readonly z: number;
}

/**
 * Champagne Tower. The pedestal is a short brass plinth fixed to the cabinet over the
 * upper tier, its foot sunk into the pusher top like the backboard so the block slides
 * underneath. Drops at its x land on it; the coins riding the pusher bump into it
 * every cycle. A coin that comes to rest over the top of the stack is taken off the
 * table and stacked: the stack is a logical column of coins with a fixed collider of
 * its height, not loose bodies, because a free column of thin cylinders jitters and
 * collapses on its own long before it reads as a tower.
 *
 * Wobble is a damped two-axis oscillator on the sideways sway of the top of the
 * stack. Its frequency falls with height like a pendulum's (ω ∝ 1/√h), so the same
 * knock sways a tall tower further and slower: a short stack shivers at about 4 Hz,
 * a tall one rolls at about 1.3 Hz. It is knocked by coins landing on top (by their
 * slide and, through how far off centre they land, by their fall) and by coins
 * running into the side of the stack or the pedestal. Sway beyond `slipSway` makes the
 * coins slip on each other, which leaves a permanent lean. The tower topples when the
 * centre of mass of the stack, its lean and half its sway (the column tilts about its
 * base), passes the rim of the bottom coin.
 *
 * Values, in metres and seconds:
 *
 * - placement x 0.1, z DROP_ZONE.z: right of centre, in line with the drop chute, so
 *   feeding it is a deliberate choice and the centre lane stays free. 35 mm of clear
 *   floor separates it from the backboard and from the pusher lip at full retraction,
 *   more than a coin's width, so coins flow around it instead of jamming.
 * - pedestalRadius 16 mm, pedestalHeight 6 mm: a lip 2.5 mm wider than a coin all
 *   round, so a neat stack reads as sitting on a plinth, and tall enough that a single
 *   layer of coins on the tier hits the plinth while a heaped pile reaches the stack.
 * - captureHeight 2 mm, minFaceUp 0.9 (about 26°): a coin is taken onto the stack
 *   when its centre is over the top coin, it is within 2 mm of resting on it and it
 *   lies within 26° of flat. A coin landing on its rim slides off first.
 * - alignment 0.65: a captured coin settles two thirds of the way onto the coin
 *   below, so a sloppy feed still stacks neatly but leaves a third of its offset
 *   in the stack. Accuracy builds a tall tower; carelessness tips it.
 * - maxCoins 36: the top of a full stack is 100 mm above the tier, under the 120 mm
 *   drop height. A coin landing on a full tower topples it.
 * - swayHz 4 at refCoins 4, damping 0.06: the sway of a short stack rings down in
 *   about 0.7 s, a tall one's in about 2 s, like a struck glass rather than a spring.
 * - landSlideGain 0.25, landThudGain 0.15: a chute drop arrives at about 1.5 m/s; one
 *   landing 4 mm off centre kicks the top of a 20-coin stack about 6 mm sideways.
 *   The kick uses the coin's fastest fall while near the tower, not its speed when
 *   it comes to rest, which is nearly zero.
 * - sideGain 0.5, pedestalGain 0.08: the pile under the pusher meets the stack at
 *   the pusher's few cm/s; a heap shoving the stack every cycle walks it toward the
 *   slip limit, while coins only knocking the plinth make it shiver.
 * - slipSway 2 mm, creep 0.08: sway past 2 mm at the top shifts the coins; 8% of
 *   the excess each tick becomes lean, so a tower that keeps being shaken tilts a
 *   little further with every knock until it goes.
 * - minToppleCoins 3: a stack of one or two coins cannot tip over.
 * - Measured on MechanicsRig (tower.test.ts), not on PusherTable, which cannot remove
 *   a captured coin yet and whose separation pass does not see the pedestal or the
 *   stack; rerun these there once it can. One drop every 1/3 s: fed down the
 *   axis the tower builds to the full 36 and the 37th coin tips it; fed within ±4 mm
 *   it topples at 18 to 25 coins, within ±7 mm at 18 to 34. The released cascade
 *   litters the tier, and the next tower, knocked by that litter, goes sooner.
 * - toppleSlope 1 (45°), toppleCooldownTicks 90: the released coins start as the
 *   stack leaning 45° toward the fall, sheared so no two overlap, and slide and tumble
 *   off the plinth onto the tier; nothing is stacked for 1.5 s, so the cascade
 *   spilling over the pedestal is not caught again.
 */
export const TOWER_TUNING = {
  placement: { x: 0.1, z: DROP_ZONE.z } satisfies TowerPlacement,
  pedestalRadius: 0.016,
  pedestalHeight: 0.006,
  pedestalEmbed: 0.003,
  captureHeight: 0.002,
  minFaceUp: 0.9,
  alignment: 0.65,
  maxCoins: 36,
  swayHz: 4,
  refCoins: 4,
  damping: 0.06,
  landSlideGain: 0.25,
  landThudGain: 0.15,
  sideGain: 0.5,
  pedestalGain: 0.08,
  slipSway: 0.002,
  creep: 0.08,
  supportRadius: COIN.radius,
  minToppleCoins: 3,
  toppleSlope: 1,
  toppleCooldownTicks: 90,
} as const;
