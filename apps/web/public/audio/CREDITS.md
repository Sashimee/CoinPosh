# CoinPosh audio credits

Every sound in CoinPosh is either synthesized in code or licensed **CC0 1.0** (public domain
dedication). No other licence is accepted for audio in this directory or in the build.

## Music

| Title                                           | Venue         | Author                | Source                                                                                                                 | Licence                                                       |
| ----------------------------------------------- | ------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Riviera Lounge (keys, bass, drums, vibes stems) | Riviera Yacht | CoinPosh contributors | Original composition, rendered procedurally at runtime from `apps/web/src/audio/music/riviera.ts` and `instruments.ts` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

Riviera Lounge is an original 8-bar bossa loop in D major at 92 BPM, composed for CoinPosh. It
ships as code, not as an audio file: the stems are rendered once on the player's device with an
`OfflineAudioContext`. The CoinPosh contributors waive all copyright and related rights to the
composition and its rendered stems under CC0 1.0.

## Sound effects

| Sound                                                | Source                                                   | Licence           |
| ---------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| Coin-on-coin, coin-on-wood and coin-on-metal impacts | Modal synthesis in `apps/web/src/audio/synth/`           | CC0 1.0, original |
| Cascade combo ladder and tier flourishes             | FM synthesis in `apps/web/src/audio/combo/`              | CC0 1.0, original |
| Room reverb impulse responses                        | Generated noise in `apps/web/src/audio/synth/buffers.ts` | CC0 1.0, original |

## Third-party CC0 files

None yet. Before adding a file here, confirm the CC0 1.0 dedication on the original source page
and add a row:

| File | Title | Author | Source URL | Licence | Retrieved |
| ---- | ----- | ------ | ---------- | ------- | --------- |
