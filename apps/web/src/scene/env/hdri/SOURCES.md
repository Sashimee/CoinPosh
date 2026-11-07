# HDRI sources

Every file in this folder is CC0 (public domain). Keep this table in sync when adding one.

| File                     | Derived from                     | Author    | Source                                | Licence                                | Retrieved  | SHA-256 (shipped file)                                             |
| ------------------------ | -------------------------------- | --------- | ------------------------------------- | -------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `venice_sunset_512.ktx2` | Venice Sunset (1k, Radiance HDR) | Greg Zaal | https://polyhaven.com/a/venice_sunset | CC0 1.0, https://polyhaven.com/license | 2026-11-07 | `80db1605e653be325e289f217651f25f6d3f14e36540b04bc108f41999db07eb` |

## Source

`https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr` (1,440,400 bytes,
SHA-256 `92fe2b29b1957828fb8925a57633540bbba5bf380d9285ed553443e834249352`). The source is not
committed; download it to derive the shipped file again.

A low sun over open water, so gold trims pick up a hot specular and the lagoon gives a cool
lower hemisphere. It is used only for image-based lighting and reflections; the visible sky and
sea are procedural (`../sky.ts`, `../ocean.ts`), so 512 px is enough once PMREM-filtered. The
sun sits at column 614.5 of 1024 in the source (307.25 of 512).

## Derivation

From `apps/web`:

```sh
node src/scene/env/hdri/derive-environment.mjs /path/to/venice_sunset_1k.hdr \
  src/scene/env/hdri/venice_sunset_512.ktx2
```

1. Verifies the source SHA-256 above.
2. Applies the environment grade offline (`../radiance.ts`): linear tint `[1.15, 0.86, 0.72]`,
   then clips each texel's brightest channel to radiance 6, keeping hue (1,054 texels clipped).
   The runtime applies no grade.
3. Box-downsamples 1024x512 to 512x256 and flips rows to three's bottom-up layout
   (`KTXorientation: ru`).
4. Packs RGBA16F with the 3 lowest mantissa bits rounded off, zstd level 19, in a KTX2
   container (348,654 bytes). It needs no Basis transcoder; `KTX2Loader` inflates it directly.
