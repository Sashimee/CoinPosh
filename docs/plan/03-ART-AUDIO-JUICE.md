# CoinPosh: Art, Audio and Juice Bible

## Visual principles
- **Physically based luxury**: brushed and polished metals (anisotropic gold),
  clearcoat lacquer, velvet (sheen), marble with subsurface veins, glass with
  transmission. Lighting is HDRI (CC0, Poly Haven) plus a key light and
  rim lights per venue.
- **AgX tonemapping**, gentle bloom on gold highlights, shallow DoF in reveal
  cinematics only, film grain at 2 %, warm vignette.
- **Procedural everything**: coins are lathe geometry with an embossed
  normal-map face generated in TSL (monogram "CP", laurel ring, reeded edge).
  Tables, ledges and props are built from code-driven parametric meshes. The
  only external files are CC0 HDRIs and textures (KTX2-compressed in the build).
- Every venue has a palette file `apps/web/src/scene/venues/<venue>/palette.ts`.
  The UI reads the same tokens, so the HUD tints with the venue.

### Riviera Yacht palette (vertical slice)
| Token | Hex | Use |
|---|---|---|
| `navy-lacquer` | `#0E1F3A` | table body, UI panels |
| `teak` | `#C9A27A` | deck, wood trims |
| `gold-brushed` | `#D4AF37` | coins, frames, primary accent |
| `champagne` | `#F3E5C0` | text, highlights |
| `coral-sunset` | `#FF7A59` | combo, CTAs |
| `sea-glass` | `#7FD1C7` | secondary accent, success |
| `ivory` | `#FFF8EC` | light UI surfaces |

### Rarity colors
Common `#E9E4D8` · Fine `#3CCB7F` · Rare `#3B82F6` · Exquisite `#A855F7` ·
Legendary `#F5B942` · Heirloom = animated prismatic TSL gradient.

## UI style
- Typography: a display serif (e.g. *Playfair Display* / *Cormorant*) for
  numbers and titles, plus a clean geometric sans (e.g. *Inter* / *Manrope*) for
  UI. Numbers use tabular figures and a rolling odometer animation.
- Panels are frosted lacquer glass with a 1 px gold hairline, an inner glow, and
  12–20 px radii.
- Every button has a press-down state (scale 0.96, shadow collapse), a haptic
  tick and a soft clack sound.
- Motion uses spring physics (Motion), never linear. Modals open from the
  object that triggered them (shared-layout transitions).

## Juice checklist (every interaction must hit ≥ 4 of these)
1. Sound (pitch-varied ±6 %, never the same twice in a row)
2. Haptic (mobile) / subtle camera micro-shake (desktop)
3. Particles (sparks, glints, confetti, dust)
4. Squash and stretch / overshoot spring
5. Light response (bloom pulse, emissive flash)
6. Number pop (floating value text with rarity color, arcs into the HUD)
7. Time manipulation (hit-stop 40–80 ms on big events, slow-mo on OBSCENE)
8. Camera (dolly-in on crate fall, FOV kick on fusion)

## Signature animations (each is its own task in the roadmap)
- **Coin drop**: spin-in from the aim cursor, motion blur trail, metallic clink on first contact.
- **Fusion**: three coins are sucked to a center point, white-gold flash, new
  coin pops up with a hop and a shockwave ring, tier-up chime.
- **Cascade ladder**: combo text stamps in with a serif flourish, and the
  ladder fills like a champagne flute.
- **Vault Crate unbox**: crate lands in the tray → camera dolly → lid shudders
  3× (each with rising rumble) → rarity-colored god-rays leak through the seams →
  burst with item spinning on a velvet pedestal → item flies into the inventory icon.
- **Safe**: dial spins with ratchet ticks, the bolt slides, the door swings with weight.
- **Scratch card**: GPU scratch mask (render-target brush) with foil flakes
  following the finger.
- **Gacha**: crank with resistance, capsule rattle, roll down a glass chute, twist-pop.
- **Ascension**: the table sinks into the floor, a curtain falls, a new venue rises (3 s cinematic).
- **Offline return**: the vault door opens on a coin avalanche, with an odometer roll-up of earnings.

## Audio
- **Procedural SFX engine** (`apps/web/src/audio/synth`): FM and modal synthesis
  for metal impacts. Coin-to-coin, coin-to-wood and coin-to-metal each get
  their own modal partials, with velocity mapped to gain and brightness. Pooled
  voices (max 24) with a priority system.
- **Musical juice**: combo tiers raise a pentatonic ladder in the venue's key,
  so cascades literally play a melody.
- **Music director**: per-venue CC0 lounge loops (jazz/bossa/house stems),
  ducking under reveal stingers. Intensity layers fade in with combo level.
- **Mixer**: master/music/SFX sliders, mono-safe, limiter on the master bus,
  and respect for the iOS silent switch via a Capacitor plugin (M7).

## Expansion systems (M10+)

Brief notes; each task's acceptance holds the detail. Every interaction still hits
≥ 4 items of the juice checklist and has a reduced-motion variant.

### Art
- **Prizes**: procedural, heavier-looking than coins. Watch (brushed steel case,
  sapphire-glass crystal with transmission), perfume (faceted glass, tinted
  liquid), cufflinks (enamel and gold), car keys (leather fob, chrome).
- **Coin variants**: proof = mirror field with frosted relief; foil = iridescent
  thin-film TSL; first-strike = crisp edge and a tiny star mark; misprint =
  off-centre strike. Each also has a colorblind glyph.
- **Trophy lounge**: walnut panelling, glass vitrines with soft spotlights, a
  velvet turntable for the item in hand. Lazy-loaded scene with its own quality tier.
- **Wine cellar**: vaulted brick, candle-warm light, dust on older bottles that
  thickens with age.
- **Table mechanics**: brass pegs with polished caps, back-wall targets with lit
  brass rims, lacquered turntables, leather conveyors, gilt sliding gates; the
  jackpot ball is dense polished obsidian with a gold band.
- **Ranks**: a heraldic crest per title, gaining detail with each grade.
- **Staff and pet**: small stylised figures at the table edge, low poly with
  velvet and wool sheens, idle loops, no uncanny faces.
- **Concierge**: a 2D illustrated portrait with a few expressions (pleased, wry,
  scandalised) and a speech card in the panel style.
- **Day/night and weather**: sky and key light follow the venue's local time;
  rain streaks, sea mist and snow as cheap screen-space layers.
- **Side games**: claw cabinet in chrome and glass; auction hall with gavel and
  paddle; treasure map on aged vellum; portfolio as a pink-paper ticker.
- **Empire map**: an illustrated globe; the private jet flies an arc between venues.
- **Society Pages**: newsprint serif masthead, halftone pictures from photo mode.
- **Layouts**: the left-hand HUD mirrors every anchor; the landscape tablet layout
  puts meters and drawers beside the table instead of over it.

### Juice
- **Prize fall**: hit-stop 60 ms, spotlight sweep, the prize spins into the
  collection icon with a number pop of its Collection Value.
- **Variant found**: a glint pass across the coin on mint, a stamped label in the
  rarity colour when banked.
- **Rank up**: the crest stamps in with a wax-seal shockwave and gold dust, and
  the title is announced in the display serif.
- **Targets**: rim flash and chime on entry; a coin shower rains from the back
  wall; a multiplier ring pulses around the table while it lasts.
- **Jackpot ball**: low rumble while it is on the table, camera dolly on fall,
  slow-mo and a confetti burst.
- **Weekly chest and calendar**: the lid creaks once per tier, a ribbon unties itself.
- **Director camera**: cuts only on the jackpot ball, a tower topple and OBSCENE,
  with a cooldown; reduced motion keeps the camera still and pulses a highlight ring.
- **Not added**: teetering "edge suspense" slow-mo (declined by the founder).

### Audio
- **Adaptive music**: tempo follows the drop rate within ±8 BPM of the loop's
  base, stems fade in by Cascade tier, and a jackpot sting ducks the loop.
- **Prizes**: each family has its own impact (glass ting, leather thud, key jangle).
- **Variants**: a high shimmer partial on top of the normal coin modes.
- **Concierge**: short wordless voice barks (pitched murmurs), never over stingers.
- **Staff and pet**: soft footsteps, a bark or a meow, a parrot whistle.
- **Sound packs** (cosmetic): alternate modal sets for coins (crystal, wood, chimes).
- **Jukebox**: unlockable CC0 tracks, each credited.
- **Haptics library**: one pattern per coin tier (heavier tiers, longer pulses),
  per prize family and per event, all behind the haptics-off setting.
