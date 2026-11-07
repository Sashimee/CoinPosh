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
