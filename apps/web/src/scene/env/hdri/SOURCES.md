# HDRI sources

Every file in this folder is CC0 (public domain). Keep this table in sync when adding one.

| File                   | Asset                            | Author    | Source                                | Licence                                | Retrieved  | SHA-256                                                            |
| ---------------------- | -------------------------------- | --------- | ------------------------------------- | -------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `venice_sunset_1k.hdr` | Venice Sunset (1k, Radiance HDR) | Greg Zaal | https://polyhaven.com/a/venice_sunset | CC0 1.0, https://polyhaven.com/license | 2026-11-07 | `92fe2b29b1957828fb8925a57633540bbba5bf380d9285ed553443e834249352` |

Download URL: `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/venice_sunset_1k.hdr`
(1,440,400 bytes). A low sun over open water, so gold trims pick up a hot specular and the
lagoon gives a cool lower hemisphere. It is used only for image-based lighting and
reflections; the visible sky and sea are procedural (`../sky.ts`, `../ocean.ts`), so 1k is
enough once PMREM-filtered. The sun sits at pixel column 614 of 1024.
