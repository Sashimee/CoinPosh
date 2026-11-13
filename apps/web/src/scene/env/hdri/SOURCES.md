# HDRI sources

Every file in this folder is CC0 (public domain). Keep this table in sync when adding one.

| File                    | Asset                                   | Author    | Source                                | Licence                                | Retrieved  | SHA-256                                                            |
| ----------------------- | --------------------------------------- | --------- | ------------------------------------- | -------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `venice_sunset_512.hdr` | Venice Sunset, graded, 512×256 RLE RGBE | Greg Zaal | https://polyhaven.com/a/venice_sunset | CC0 1.0, https://polyhaven.com/license | 2026-11-07 | `799addb3ce4ee333a8cfc9e849c3f5942c40000af0847e69deeffc5be84cae88` |
| `venice_sunset_32.ts`   | Venice Sunset, graded, 32×16 RLE RGBE   | Greg Zaal | derived from `venice_sunset_512.hdr`  | CC0 1.0, https://polyhaven.com/license | 2026-11-09 | `b3eebc2dc9f6b50473ce124a65e67dcf0c54fa16ce8dd7ff760a53987999e4ea` |

## Derivation

The shipped file is baked offline from Poly Haven's 1k Radiance original, which is not kept
in the repo:

- Source: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr`
  (1,440,400 bytes, SHA-256
  `92fe2b29b1957828fb8925a57633540bbba5bf380d9285ed553443e834249352`).
- Bake, from `apps/web`:
  `node src/scene/env/hdri/bake-hdri.mjs venice_sunset_1k.hdr src/scene/env/hdri/venice_sunset_512.hdr 1`.
  It applies
  `VENICE_SUNSET_GRADE` from `bake.ts` (linear tint `1.15, 0.86, 0.72`, then every texel's
  brightest channel capped at 6 with hue kept, so the photographed sun cannot add a second,
  unshadowed sun after GGX pre-filtering), halves the image once with a 2×2 box filter in
  linear light and writes run-length-encoded RGBE (373,447 bytes, 294 KB gzipped).

A low sun over open water, so gold trims pick up a hot specular and the lagoon gives a cool
lower hemisphere. It is used only for image-based lighting and reflections; the visible sky
and sea are procedural (`../sky.ts`, `../ocean.ts`), so 512 px is enough once pre-filtered.
The sun sits at pixel column 307 of 512.

### Boot fallback

`venice_sunset_32.ts` is the shipped 512 px file halved four more times with the same box
filter, written as a 1,887-byte RGBE file inlined as a base64 data URL (the SHA-256 above is
of the RGBE bytes). It lights the venue from the first frame, sampled directly with a CPU mip
chain, while a worker fetches the 512 px file a few frames into play and GGX pre-filters it
into an equirect mip chain (`../prefilter.ts`). Rebuild, from `apps/web`:
`node src/scene/env/hdri/bake-fallback.mjs src/scene/env/hdri/venice_sunset_512.hdr src/scene/env/hdri/venice_sunset_32.ts 4`.
