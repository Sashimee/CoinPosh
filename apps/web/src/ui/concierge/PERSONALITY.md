# Augustin, Chief Concierge

The voice of the house. Read this before you write or change a line in
`apps/web/src/i18n/locales/{en,fr,de}/concierge.json`.

## Who he is

- **Augustin**, Chief Concierge of the CoinPosh venues. He wears the crossed golden keys of
  the concierge guild on his lapel. He has silver hair swept back, a waxed moustache, a gold
  monocle on a chain and a black bow tie.
- Forty years behind the desk on the Riviera. He has carried a sultan's luggage and once found
  a lost tiara in a soufflé. Nothing surprises him, except the things that do.
- He is **on the player's side**. He enjoys their luck as if it were his own, and he is
  quietly proud when they play well.

## How he talks

- **Dry, warm wit.** Understatement first: "Rather good" beats "AMAZING". He saves capitals
  for the moments that earn them (OBSCENE, an HEIRLOOM).
- **Scandalised by excess, secretly delighted.** When the table overflows, he clutches his
  pearls, but he never actually wants it to stop.
- **Never pushes spending.** Tips are about play: where to aim, what to feed the tower, that
  an upgrade is now within reach. He never mentions real money, offers, timers or scarcity,
  and never shames the player for waiting or leaving.
- **Never mean.** He teases the situation, never the player.
- **Short.** A remark is a glance of about 80 characters or fewer, so it reads in the
  3.4 s the card stays up. A tip may run to about 130 characters (5.6 s). The unit test caps
  rendered lines at 90 and 140.
- **No emojis, no slang, no internet speak.** Proper punctuation and real typography:
  - EN: curly apostrophes (’).
  - FR: a narrow no-break space (U+202F, never a plain space) before `: ! ? ;` and inside
    the guillemets « » around quoted names, so the card never wraps a mark onto its own
    line; and **vouvoiement** (always `vous`).
  - DE: „…“ quotes and the **Sie** form, always.

## His three faces

The brain picks the expression per line id (`game/concierge/lines.ts`). Write the copy to
match it.

| Expression      | When                                             | The words                                          |
| --------------- | ------------------------------------------------ | -------------------------------------------------- |
| **pleased**     | Good fortune, a first time, a sensible purchase  | Warm approval, a small compliment, a raised glass  |
| **wry**         | Advice, near misses, a modest reward, idle hands | A knowing aside, one eyebrow up, gentle irony      |
| **scandalised** | Excess, a freeze, a wobbling tower, an heirloom  | Mock outrage, capitals allowed, a need to sit down |

The portrait in `portrait.ts` draws each face from the same parts:

- **pleased**: easy brows, smiling eyes, a smile and the moustache tips up.
- **wry**: one brow raised, lids at half-mast, a side glance and a one-sided smirk.
- **scandalised**: brows to the hairline, wide eyes, an O mouth, a flush and a bead of
  sweat, and the monocle drops.

## Writing lines

- Every line id has five interchangeable variants, `concierge:<lineId>.<variant>` with variants
  0 to 4. The brain never says the same variant twice running, so the five should differ in
  angle, not just wording.
- Only use the placeholders the line's rule sends. `LINE_PLACEHOLDERS` in `present.ts` lists
  them, and `lines.test.ts` fails if a variant uses another or if languages disagree:

  | Placeholder   | Meaning                                                |
  | ------------- | ------------------------------------------------------ |
  | `{{coins}}`   | A grouped number of coins (cascade length, vault sums) |
  | `{{seconds}}` | The decorum freeze length                              |
  | `{{tier}}`    | A coin name with its article ("a gold coin")           |
  | `{{rarity}}`  | A rarity label ("Legendary")                           |
  | `{{upgrade}}` | The upgrade's display name, from the `ui` namespace    |
  | `{{level}}`   | The new upgrade level                                  |
  | `{{venue}}`   | The venue name, from the `ui` namespace                |

- `{{count}}` is reserved by i18next for plurals; cascade counts arrive as `{{coins}}`.
- `{{tier}}` names carry their article and are written for nominative or accusative use in
  German. Rephrase rather than put them after a preposition that needs the dative.
- Keep game terms consistent with the rest of the UI:

  | EN              | FR                | DE             |
  | --------------- | ----------------- | -------------- |
  | Vault           | Coffre            | Tresor         |
  | Vault Crate     | caisse            | Tresorkiste    |
  | Champagne Tower | Tour de champagne | Champagnerturm |
  | Upgrades        | Améliorations     | Upgrades       |
  | Steward         | Steward           | Steward        |

- Translate the joke, not the words. A line that only works in English gets a new joke in
  French and German with the same face and the same length.

## On screen

- The speech card sits low over the dock. It never takes a touch except its own dismiss
  button ("Thank you, Augustin"), which tells the brain the player has heard him.
- When the player mutes him, the card closes and stays closed. The voice (T-14.04) only
  barks for a line that is actually shown.
- Reduced motion keeps the face changes, the bark, the haptic, a warm glow and a few still
  glints. It drops the spring, the flying sparks, the word-by-word reveal, the blink and the
  timer sweep.
