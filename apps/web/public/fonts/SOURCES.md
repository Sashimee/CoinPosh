# CoinPosh webfonts

Both families are licensed under the **SIL Open Font License 1.1**; the licence text ships beside
the files. Neither declares a Reserved Font Name. The files here are subsets of the upstream
fonts, made with the commands below (P-425, 2026-11-14).

| File                                  | Family             | Weight / style | Licence                              |
| ------------------------------------- | ------------------ | -------------- | ------------------------------------ |
| `cormorant-garamond-600.woff2`        | Cormorant Garamond | 600 normal     | [OFL 1.1](OFL-CormorantGaramond.txt) |
| `cormorant-garamond-700.woff2`        | Cormorant Garamond | 700 normal     | [OFL 1.1](OFL-CormorantGaramond.txt) |
| `cormorant-garamond-700-italic.woff2` | Cormorant Garamond | 700 italic     | [OFL 1.1](OFL-CormorantGaramond.txt) |
| `manrope-500.woff2`                   | Manrope            | 500 normal     | [OFL 1.1](OFL-Manrope.txt)           |
| `manrope-700.woff2`                   | Manrope            | 700 normal     | [OFL 1.1](OFL-Manrope.txt)           |

## Sources

The variable fonts in [google/fonts](https://github.com/google/fonts) at commit
[`cc39c4c2c304bc368c9b7c311ea2bcc6013299fe`](https://github.com/google/fonts/tree/cc39c4c2c304bc368c9b7c311ea2bcc6013299fe/ofl):

| Source                                                     | SHA-256                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `ofl/cormorantgaramond/CormorantGaramond[wght].ttf`        | `b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0` |
| `ofl/cormorantgaramond/CormorantGaramond-Italic[wght].ttf` | `0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d` |
| `ofl/cormorantgaramond/OFL.txt`                            | `60700d351cac4650c51f3f9db318d2a420f8b45052dba2715eb5fec41f0f6956` |
| `ofl/manrope/Manrope[wght].ttf`                            | `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6` |
| `ofl/manrope/OFL.txt`                                      | `58172e0c0fac2cda8a37b348164bb55e44b0e69051e557e92b1d3f6910141f7b` |

## Subset

Latin with every French and German letter (Latin-1, Œ œ Ÿ, ẞ), the typographer's punctuation the
three locales use (curly and low quotes, guillemets, dashes, ellipsis, middle dot, the French
narrow no-break space), € ™ × → − ≈ ≤ ≥. OpenType features kept: `kern`, `liga`, `calt`, `case`,
`locl`, `ccmp`, `mark`, `mkmk`, and the figure sets `lnum`, `pnum`, `tnum`, so
`font-variant-numeric: tabular-nums lining-nums` keeps the Vault odometer's columns even. Hinting
is dropped (every target renders woff2 unhinted at these sizes).

Made with fontTools 4.60.1 and brotli 1.1.0. For each row, with `SOURCE_DATE_EPOCH=1794614400`
so a rerun gives the same bytes:

```sh
fonttools varLib.instancer --quiet --update-name-table -o static.ttf "<source>.ttf" wght=<weight>
pyftsubset static.ttf --output-file=<file>.woff2 --flavor=woff2 \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+0178,U+02C6,U+02DA,U+02DC,U+1E9E,U+2009-200A,U+2011,U+2013-2014,U+2018-201A,U+201C-201E,U+2022,U+2026,U+202F,U+2030,U+2039-203A,U+2044,U+20AC,U+2122,U+2190-2193,U+2212,U+2248,U+2264-2265" \
  --layout-features="ccmp,locl,mark,mkmk,kern,liga,clig,calt,case,lnum,pnum,tnum" \
  --no-hinting --desubroutinize --name-IDs="0,1,2,3,4,5,6,13,14" --name-languages=0x409 \
  --drop-tables+=STAT,DSIG
```

`<source>` is `CormorantGaramond[wght]` (600, 700), `CormorantGaramond-Italic[wght]` (700) or
`Manrope[wght]` (500, 700). The five files total 85.3 kB; `e2e/bundle-size.ts` gates them
against `BUNDLE_BUDGETS.fonts` in `e2e/budgets.ts`.
