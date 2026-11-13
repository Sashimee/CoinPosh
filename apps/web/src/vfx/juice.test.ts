import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASCEND_JUICE } from './cinematics/ascend/plan.ts';
import { UNBOX_JUICE } from './cinematics/unbox/plan.ts';
import {
  auditJuice,
  type AuditableRow,
  EFFECT_JUICE,
  INTERACTION_JUICE,
  JUICE_MINIMUM,
  juiceItemsOf,
  SLICE_INTERACTIONS,
} from './juice.ts';

const REPO = new URL('../../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, REPO), 'utf8');

const rows = Object.entries(INTERACTION_JUICE);

const fullRow: AuditableRow = {
  credits: [
    { item: 'sound', at: 'a.ts', proof: 'x' },
    { item: 'hapticOrShake', at: 'a.ts', proof: 'x' },
    { item: 'particles', at: 'a.ts', proof: 'x' },
    { item: 'lightResponse', at: 'a.ts', proof: 'x' },
  ],
  reduced: 'A still glint.',
};

describe('slice interaction juice', () => {
  it('covers every slice interaction from the T-1.18 sweep', () => {
    expect(Object.keys(INTERACTION_JUICE).sort()).toEqual([...SLICE_INTERACTIONS].sort());
    expect(SLICE_INTERACTIONS).toEqual(
      expect.arrayContaining([
        'tapAim',
        'drop',
        'pour',
        'nudge',
        'contact',
        'fusionCompact',
        'fusionFull',
        'cascadeChic',
        'cascadeLavish',
        'cascadeOpulent',
        'cascadeDecadent',
        'obscene',
        'numberPop',
        'crateSpawn',
        'crateFall',
        'crateUnbox',
        'crateCollect',
        'upgradeBuy',
        'firstUpgradeNudge',
        'ascensionEntry',
      ]),
    );
  });

  it('holds every interaction to the checklist minimum or to an owned follow-up', () => {
    expect(auditJuice(INTERACTION_JUICE)).toEqual([]);
  });

  it('only lists follow-ups for interactions that are truly short', () => {
    const short = rows.filter(([, row]) => juiceItemsOf(row).size < JUICE_MINIMUM);
    expect(short.map(([name]) => name).sort()).toEqual(['drop', 'nudge', 'tapAim']);
    for (const [, row] of short) {
      expect(row.followUp).toBeDefined();
    }
  });

  it('points every credit at code that still delivers it', () => {
    for (const [name, row] of rows) {
      for (const credit of row.credits) {
        const where = `${name} ${credit.item} at ${credit.at}`;
        expect(existsSync(new URL(credit.at, REPO)), where).toBe(true);
        expect(read(credit.at), where).toContain(credit.proof);
      }
    }
  });

  it('names follow-up owners that exist and POLISH items that are queued', () => {
    const polish = read('docs/plan/POLISH.md');
    for (const [name, row] of rows) {
      const follow = row.followUp;
      if (!follow) continue;
      for (const owner of follow.owners) {
        expect(existsSync(new URL(owner, REPO)), `${name} owner ${owner}`).toBe(true);
      }
      if (follow.tracked !== undefined) {
        expect(polish, `${name} ${follow.tracked}`).toMatch(new RegExp(`\\b${follow.tracked}\\b`));
      }
    }
  });

  it('matches the cinematics own juice accounting', () => {
    expect([...juiceItemsOf(INTERACTION_JUICE.crateUnbox)].sort()).toEqual(
      [...UNBOX_JUICE.items].sort(),
    );
    expect([...juiceItemsOf(INTERACTION_JUICE.ascensionEntry)].sort()).toEqual(
      [...ASCEND_JUICE.items].sort(),
    );
  });

  it('keeps the camera out of cascades below OPULENT', () => {
    expect(juiceItemsOf(INTERACTION_JUICE.cascadeChic).has('camera')).toBe(false);
    expect(juiceItemsOf(INTERACTION_JUICE.cascadeLavish).has('camera')).toBe(false);
    expect(juiceItemsOf(INTERACTION_JUICE.cascadeOpulent).has('camera')).toBe(true);
    expect(juiceItemsOf(INTERACTION_JUICE.cascadeDecadent).has('camera')).toBe(true);
  });
});

describe('auditJuice', () => {
  it('passes a row at the minimum', () => {
    expect(auditJuice({ ok: fullRow })).toEqual([]);
  });

  it('fails a row under the minimum with no follow-up', () => {
    const thin: AuditableRow = { ...fullRow, credits: fullRow.credits.slice(0, 3) };
    expect(auditJuice({ thin })).toEqual([expect.stringMatching(/^thin: delivers 3 /)]);
  });

  it('does not count the same item twice toward the minimum', () => {
    const repeated: AuditableRow = {
      ...fullRow,
      credits: [...fullRow.credits.slice(0, 3), { item: 'sound', at: 'b.ts', proof: 'y' }],
    };
    expect(auditJuice({ repeated })).toEqual([expect.stringMatching(/delivers 3 /)]);
  });

  it('fails a credit that names an effect that does not exist', () => {
    const ghost: AuditableRow = {
      ...fullRow,
      credits: [
        ...fullRow.credits,
        { item: 'particles', effect: 'sparkleBomb', at: 'a.ts', proof: 'x' },
      ],
    };
    expect(auditJuice({ ghost })).toEqual([
      'ghost: names effect "sparkleBomb", which does not exist',
    ]);
  });

  it('fails a credit for an item its effect does not deliver', () => {
    const overclaim: AuditableRow = {
      ...fullRow,
      credits: [
        ...fullRow.credits,
        { item: 'camera', effect: 'numberPop', at: 'a.ts', proof: 'x' },
      ],
    };
    expect(auditJuice({ overclaim })).toEqual([
      'overclaim: effect "numberPop" does not deliver camera',
    ]);
  });

  it('does not treat inherited object keys as effects', () => {
    const proto: AuditableRow = {
      ...fullRow,
      credits: [
        ...fullRow.credits,
        { item: 'particles', effect: 'toString', at: 'a.ts', proof: 'x' },
      ],
    };
    expect(auditJuice({ proto })).toEqual(['proto: names effect "toString", which does not exist']);
  });

  it('fails a row with no reduced-motion variant', () => {
    expect(auditJuice({ bare: { ...fullRow, reduced: '  ' } })).toEqual([
      'bare: has no reduced-motion variant',
    ]);
  });

  it('accepts a short row whose follow-up would lift it over the bar', () => {
    const owed: AuditableRow = {
      ...fullRow,
      credits: fullRow.credits.slice(0, 2),
      followUp: { owners: ['x.ts'], adds: ['particles', 'camera'], plan: 'Wire it.' },
    };
    expect(auditJuice({ owed })).toEqual([]);
  });

  it('rejects follow-ups that pad, fall short, lack an owner or name a missing effect', () => {
    const base = fullRow.credits.slice(0, 2);
    expect(
      auditJuice({
        stale: { ...fullRow, followUp: { owners: ['x.ts'], adds: ['camera'], plan: 'p' } },
        short: {
          ...fullRow,
          credits: base,
          followUp: { owners: ['x.ts'], adds: ['camera'], plan: 'p' },
        },
        dup: {
          ...fullRow,
          credits: base,
          followUp: { owners: ['x.ts'], adds: ['sound', 'camera', 'particles'], plan: 'p' },
        },
        orphan: {
          ...fullRow,
          credits: base,
          followUp: { owners: [], adds: ['camera', 'particles'], plan: 'p' },
        },
        missing: {
          ...fullRow,
          credits: base,
          followUp: {
            owners: ['x.ts'],
            adds: ['camera', 'particles'],
            effects: ['nudgeDust'],
            plan: 'p',
          },
        },
      }),
    ).toEqual([
      'stale: already delivers 4 items, so its follow-up is stale',
      'short: its follow-up only reaches 3 items',
      'dup: follow-up adds sound, which it already has',
      'orphan: follow-up names no owning path',
      'missing: follow-up names effect "nudgeDust", which does not exist',
    ]);
  });

  it('checks effects against the table it is given', () => {
    const credit = { item: 'particles' as const, effect: 'dropTrail', at: 'a.ts', proof: 'x' };
    const row: AuditableRow = { ...fullRow, credits: [...fullRow.credits, credit] };
    expect(auditJuice({ row }, EFFECT_JUICE)).toEqual([]);
    expect(auditJuice({ row }, {})).toEqual([
      'row: names effect "dropTrail", which does not exist',
    ]);
  });
});
