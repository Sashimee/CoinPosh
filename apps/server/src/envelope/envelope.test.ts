import {
  RATE_ENVELOPE_METRIC_IDS,
  rateEnvelope,
  rateEnvelopeFor,
  upgradeLines,
  venues,
  type RateEnvelopeLimits,
  type RateEnvelopeMetricId,
  type RateEnvelopeTable,
} from '@coinposh/economy';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { PlayerDO } from '../do/PlayerDO.ts';
import { ENVELOPE_POLICY, RateEnvelope } from './envelope.ts';

const T0 = 1_800_000_000_000;

/**
 * Test-only limits, chosen small so the window arithmetic is easy to read. Production
 * limits come from the economy config; these tests pin the mechanism, not the numbers.
 */
const LIMITS: RateEnvelopeLimits = {
  drops: { windowMs: 1_000, max: 5 },
  falls: { windowMs: 10_000, max: 20 },
  fallValue: { windowMs: 10_000, max: 100 },
  fusions: { windowMs: 60_000, max: 3 },
  crates: { windowMs: 60_000, max: 2 },
};

function inFreshDo<T>(run: (sql: SqlStorage, ctx: DurableObjectState) => T): Promise<T> {
  const stub = env.PLAYER.get(env.PLAYER.idFromName(`envelope-${crypto.randomUUID()}`));
  return runInDurableObject(stub, (_instance: PlayerDO, ctx) => run(ctx.storage.sql, ctx));
}

function one(metric: RateEnvelopeMetricId, amount = 1) {
  return [{ metric, amount }];
}

function fall(value: number) {
  return [
    { metric: 'falls', amount: 1 },
    { metric: 'fallValue', amount: value },
  ] as const;
}

describe('RateEnvelope sliding window', () => {
  it('admits up to the limit, then rejects with the wait until a slot frees', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      const admitted = [0, 100, 200, 300, 400].map(
        (offset) => envelope.admit(one('drops'), T0 + offset, `coin_${offset}`).admitted,
      );
      const rejected = envelope.admit(one('drops'), T0 + 500, 'coin_500');
      return { admitted, rejected, usage: envelope.usage('drops', T0 + 500) };
    });
    expect(result.admitted).toEqual([true, true, true, true, true]);
    expect(result.rejected).toEqual({
      admitted: false,
      metric: 'drops',
      used: 5,
      limit: LIMITS.drops,
      retryAfterMs: 500,
      flagged: false,
    });
    expect(result.usage).toBe(5);
  });

  it('frees capacity exactly as each event leaves the window', async () => {
    const verdicts = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      for (let i = 0; i < 5; i++) envelope.admit(one('drops'), T0 + i * 100, null);
      return {
        stillInside: envelope.admit(one('drops'), T0 + 999, null).admitted,
        oldestGone: envelope.admit(one('drops'), T0 + 1_000, null).admitted,
        nextStillFull: envelope.admit(one('drops'), T0 + 1_050, null).admitted,
        secondGone: envelope.admit(one('drops'), T0 + 1_100, null).admitted,
      };
    });
    expect(verdicts).toEqual({
      stillInside: false,
      oldestGone: true,
      nextStillFull: false,
      secondGone: true,
    });
  });

  it('defeats the fixed-window boundary burst: no 1 s span ever holds more than the limit', async () => {
    const admittedAt = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      const times: number[] = [];
      for (const at of [T0 + 990, T0 + 995, T0 + 999, T0 + 1_000, T0 + 1_001, T0 + 1_005]) {
        for (let burst = 0; burst < 5; burst++) {
          if (envelope.admit(one('drops'), at, null).admitted) times.push(at);
        }
      }
      return times;
    });
    expect(admittedAt).toHaveLength(5);
    expect(new Set(admittedAt)).toEqual(new Set([T0 + 990]));
  });

  it('caps a perfect-play drop bot at the envelope over a long run without flagging it', async () => {
    const result = await inFreshDo((sql) => {
      const bot = new RateEnvelope(sql, LIMITS);
      const botAdmits: number[] = [];
      for (let ms = 0; ms < 20_000; ms += 50) {
        if (bot.admit(one('drops'), T0 + ms, null).admitted) botAdmits.push(ms);
      }
      return { botAdmits, botUnranked: bot.unranked(), flags: bot.flags().length };
    });
    const honest = await inFreshDo((sql) => {
      const player = new RateEnvelope(sql, LIMITS);
      let rejected = 0;
      for (let ms = 0; ms < 20_000; ms += 250) {
        if (!player.admit(one('drops'), T0 + ms, null).admitted) rejected++;
      }
      return { rejected, unranked: player.unranked() };
    });

    for (const start of result.botAdmits) {
      const inside = result.botAdmits.filter((ms) => ms >= start && ms < start + 1_000);
      expect(inside.length).toBeLessThanOrEqual(LIMITS.drops.max);
    }
    expect(result.botAdmits).toHaveLength(LIMITS.drops.max * 20);
    expect(result).toMatchObject({ botUnranked: false, flags: 0 });
    expect(honest).toEqual({ rejected: 0, unranked: false });
  });

  it('rate-limits a burst of queued drops but never unranks the player for it', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      const flush = Array.from({ length: 12 }, (_, i) =>
        envelope.admit(one('drops'), T0 + i, `queued_${i}`),
      );
      const jitter = [0, 3, 4, 6].map((offset) =>
        envelope.admit(one('drops'), T0 + 1_000 + offset, null),
      );
      return {
        admitted: flush.filter((verdict) => verdict.admitted).length,
        refused: flush.find((verdict) => !verdict.admitted),
        jitterAdmitted: jitter.every((verdict) => verdict.admitted),
        unranked: envelope.unranked(),
        flags: envelope.flags(),
      };
    });
    expect(result.admitted).toBe(LIMITS.drops.max);
    expect(result.refused).toEqual({
      admitted: false,
      metric: 'drops',
      used: LIMITS.drops.max,
      limit: LIMITS.drops,
      retryAfterMs: 995,
      flagged: false,
    });
    expect(result.jitterAdmitted).toBe(true);
    expect(result.unranked).toBe(false);
    expect(result.flags).toEqual([]);
  });

  it('keeps metrics independent: a drop flood does not spend the fusion budget', async () => {
    const verdict = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      for (let i = 0; i < 10; i++) envelope.admit(one('drops'), T0, null);
      return envelope.admit(one('fusions'), T0, 'coin_fused');
    });
    expect(verdict).toEqual({ admitted: true });
  });
});

describe('RateEnvelope multi-metric claims', () => {
  it('admits a fall only when both its count and its stored value fit', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      const first = envelope.admit(fall(90), T0, 'coin_a');
      const tooRich = envelope.admit(fall(20), T0 + 1, 'coin_b');
      const fits = envelope.admit(fall(10), T0 + 2, 'coin_c');
      return {
        first,
        tooRich,
        fits,
        falls: envelope.usage('falls', T0 + 2),
        value: envelope.usage('fallValue', T0 + 2),
      };
    });
    expect(result.first.admitted).toBe(true);
    expect(result.tooRich).toMatchObject({
      admitted: false,
      metric: 'fallValue',
      used: 90,
      flagged: true,
    });
    expect(result.fits.admitted).toBe(true);
    expect(result.falls).toBe(2);
    expect(result.value).toBe(100);
  });

  it('records nothing for a rejected claim, so a refused claim never eats budget', async () => {
    const usage = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      envelope.admit(fall(95), T0, null);
      for (let i = 0; i < 30; i++) envelope.admit(fall(10), T0 + i, null);
      return {
        falls: envelope.usage('falls', T0 + 30),
        value: envelope.usage('fallValue', T0 + 30),
      };
    });
    expect(usage).toEqual({ falls: 1, value: 95 });
  });

  it('sums repeated charges of one metric within a claim before checking', async () => {
    const verdict = await inFreshDo((sql) =>
      new RateEnvelope(sql, LIMITS).admit(
        [
          { metric: 'crates', amount: 1 },
          { metric: 'crates', amount: 1 },
          { metric: 'crates', amount: 1 },
        ],
        T0,
        null,
      ),
    );
    expect(verdict).toMatchObject({ admitted: false, metric: 'crates', used: 0 });
  });

  it('never fits a single charge larger than the whole envelope', async () => {
    const verdict = await inFreshDo((sql) =>
      new RateEnvelope(sql, LIMITS).admit(fall(101), T0, 'coin_whale'),
    );
    expect(verdict).toMatchObject({ admitted: false, metric: 'fallValue', retryAfterMs: null });
  });

  it('treats a zero charge (a side-gutter fall pays nothing) as free', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      envelope.admit(fall(100), T0, null);
      return envelope.admit(fall(0), T0 + 1, null);
    });
    expect(result.admitted).toBe(true);
  });
});

describe('RateEnvelope flags and the shadow pool', () => {
  it('soft-flags an over-envelope claim with the evidence and moves the player to unranked', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      envelope.admit(one('crates'), T0, 'crate_1');
      envelope.admit(one('crates'), T0 + 1, 'crate_2');
      const before = envelope.unranked();
      envelope.admit(one('crates'), T0 + 2, 'crate_3');
      return { before, after: envelope.unranked(), flags: envelope.flags() };
    });
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
    expect(result.flags).toEqual([
      {
        at: T0 + 2,
        metric: 'crates',
        amount: 1,
        used: 2,
        max: LIMITS.crates.max,
        windowMs: LIMITS.crates.windowMs,
        ref: 'crate_3',
        lastAt: T0 + 2,
        count: 1,
        maxExcess: 1,
      },
    ]);
  });

  it('writes at most one flag row per metric per window under a 10,000-claim flood', async () => {
    const durationMs = 10_000;
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      let refused = 0;
      for (let i = 0; i < 10_000; i++) {
        const at = T0 + Math.floor((i * durationMs) / 10_000);
        const metric: RateEnvelopeMetricId = i % 2 === 0 ? 'crates' : 'fusions';
        if (!envelope.admit(one(metric), at, `claim_${i}`).admitted) refused++;
      }
      return { refused, flags: envelope.flags() };
    });
    expect(result.refused).toBe(10_000 - LIMITS.crates.max - LIMITS.fusions.max);
    expect(result.flags.map(({ metric }) => metric).sort()).toEqual(['crates', 'fusions']);
    expect(result.flags.reduce((sum, flag) => sum + flag.count, 0)).toBe(result.refused);
  });

  it('keeps flag rows bounded while a fall bot is held at the cap for 60 s', async () => {
    const durationMs = 60_000;
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      let refused = 0;
      for (let ms = 0; ms < durationMs; ms += 5) {
        if (!envelope.admit(fall(1), T0 + ms, `fall_${ms}`).admitted) refused++;
      }
      const rows = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM envelope_flags').one().n;
      return { refused, rows, flags: envelope.flags(), unranked: envelope.unranked() };
    });
    expect(result.refused).toBeGreaterThan(10_000);
    expect(result.rows).toBeLessThanOrEqual(Math.ceil(durationMs / LIMITS.falls.windowMs));
    expect(result.flags.every(({ metric }) => metric === 'falls')).toBe(true);
    expect(result.flags.reduce((sum, flag) => sum + flag.count, 0)).toBe(result.refused);
    expect(result.unranked).toBe(true);
  });

  it('keeps the first refusal of each window as evidence and flags again in the next window', async () => {
    const flags = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      envelope.admit(one('crates', 2), T0, 'crate_ok');
      envelope.admit(one('crates'), T0 + 1, 'crate_first');
      envelope.admit(one('crates', 2), T0 + 2, 'crate_repeat');
      envelope.admit(one('fusions', 4), T0 + 3, 'fusion_burst');
      envelope.admit(one('crates', 3), T0 + 1 + LIMITS.crates.windowMs, 'crate_next_window');
      return envelope.flags().map(({ metric, ref, at, lastAt, count, maxExcess }) => ({
        metric,
        ref,
        at,
        lastAt,
        count,
        maxExcess,
      }));
    });
    expect(flags).toEqual([
      { metric: 'crates', ref: 'crate_first', at: T0 + 1, lastAt: T0 + 2, count: 2, maxExcess: 2 },
      {
        metric: 'fusions',
        ref: 'fusion_burst',
        at: T0 + 3,
        lastAt: T0 + 3,
        count: 1,
        maxExcess: 1,
      },
      {
        metric: 'crates',
        ref: 'crate_next_window',
        at: T0 + 1 + LIMITS.crates.windowMs,
        lastAt: T0 + 1 + LIMITS.crates.windowMs,
        count: 1,
        maxExcess: 1,
      },
    ]);
  });

  it('keeps flags append-only so a later bug cannot launder a cheater back to ranked', async () => {
    await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      envelope.admit(fall(500), T0, 'coin_forged');
      expect(() => sql.exec('DELETE FROM envelope_flags')).toThrow(/append-only/);
      for (const rewrite of [
        "UPDATE envelope_flags SET metric = 'crates'",
        'UPDATE envelope_flags SET ref = NULL',
        'UPDATE envelope_flags SET amount = 0',
        'UPDATE envelope_flags SET window_start = window_start + 1',
        'UPDATE envelope_flags SET count = 1',
        'UPDATE envelope_flags SET max_excess = 0',
        'UPDATE envelope_flags SET last_at = last_at - 1',
      ]) {
        expect(() => sql.exec(rewrite)).toThrow(/append-only/);
      }
      expect(envelope.unranked()).toBe(true);
      expect(envelope.flags()).toMatchObject([{ ref: 'coin_forged', count: 1, amount: 500 }]);
    });
  });

  it('persists usage and flags across Durable Object restarts', async () => {
    const stub = env.PLAYER.get(env.PLAYER.idFromName(`envelope-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (_instance: PlayerDO, ctx) => {
      const envelope = new RateEnvelope(ctx.storage.sql, LIMITS);
      for (let i = 0; i < 3; i++) envelope.admit(one('crates'), T0, null);
    });
    const after = await runInDurableObject(stub, (_instance: PlayerDO, ctx) => {
      const envelope = new RateEnvelope(ctx.storage.sql, LIMITS);
      return {
        usage: envelope.usage('crates', T0 + 10),
        verdict: envelope.admit(one('crates'), T0 + 10, null).admitted,
        unranked: envelope.unranked(),
        count: envelope.flags()[0]?.count,
      };
    });
    expect(after).toEqual({ usage: 2, verdict: false, unranked: true, count: 2 });
  });

  it('rolls a flag back with the claim transaction it belonged to', async () => {
    const unranked = await inFreshDo((sql, ctx) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      expect(() =>
        ctx.storage.transactionSync(() => {
          envelope.admit(fall(500), T0, null);
          throw new Error('request aborted');
        }),
      ).toThrow('request aborted');
      return envelope.unranked();
    });
    expect(unranked).toBe(false);
  });
});

describe('RateEnvelope uses server time only', () => {
  it('does not reopen the window when the server clock steps backwards', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      for (let i = 0; i < 5; i++) envelope.admit(one('drops'), T0 + 10_000, null);
      return {
        rewound: envelope.admit(one('drops'), T0, null),
        farRewound: envelope.admit(one('drops'), 0, null).admitted,
        later: envelope.admit(one('drops'), T0 + 11_000, null).admitted,
      };
    });
    expect(result.rewound).toMatchObject({
      admitted: false,
      used: 5,
      retryAfterMs: LIMITS.drops.windowMs,
    });
    expect(result.farRewound).toBe(false);
    expect(result.later).toBe(true);
  });

  it('recovers within one window after a forward skew is corrected, however large the skew', async () => {
    const skewMs = 60 * 60 * 1_000;
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      const skewed = Array.from(
        { length: 7 },
        (_, i) => envelope.admit(one('drops'), T0 + skewMs + i, null).admitted,
      );
      const corrected = envelope.admit(one('drops'), T0, null);
      const honest: boolean[] = [];
      for (let ms = LIMITS.drops.windowMs; ms < 20_000; ms += 250) {
        honest.push(envelope.admit(one('drops'), T0 + ms, null).admitted);
      }
      const stamps = sql
        .exec<{ at: number }>("SELECT at FROM envelope_events WHERE metric = 'drops'")
        .toArray()
        .map(({ at }) => at);
      return { skewed, corrected, honest, stamps };
    });
    expect(result.skewed.filter(Boolean)).toHaveLength(LIMITS.drops.max);
    expect(result.corrected).toMatchObject({
      admitted: false,
      used: LIMITS.drops.max,
      retryAfterMs: LIMITS.drops.windowMs,
    });
    expect(result.honest.every(Boolean)).toBe(true);
    expect(Math.max(...result.stamps)).toBeLessThanOrEqual(T0 + 20_000);
  });

  it('stamps every admitted event with the real server time', async () => {
    const stamps = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      envelope.admit(one('drops'), T0 + 5_000, null);
      envelope.admit(one('crates'), T0 + 5_000, null);
      envelope.admit(one('drops'), T0 + 5_200, null);
      envelope.admit(one('crates'), T0 + 5_300, null);
      return sql
        .exec<{ metric: string; at: number }>('SELECT metric, at FROM envelope_events ORDER BY id')
        .toArray()
        .map(({ metric, at }) => [metric, at - T0]);
    });
    expect(stamps).toEqual([
      ['drops', 5_000],
      ['crates', 5_000],
      ['drops', 5_200],
      ['crates', 5_300],
    ]);
  });

  it('keeps flagging a claim bot through a forward skew without adding a row per refusal', async () => {
    const skewMs = 60 * 60 * 1_000;
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      let refused = 0;
      for (let i = 0; i < 1_000; i++) {
        if (!envelope.admit(one('crates'), T0 + skewMs + i, `skewed_${i}`).admitted) refused++;
      }
      for (let ms = 0; ms < 2 * LIMITS.crates.windowMs; ms += 100) {
        if (!envelope.admit(one('crates'), T0 + ms, `corrected_${ms}`).admitted) refused++;
      }
      return { refused, flags: envelope.flags() };
    });
    expect(result.flags.length).toBeLessThanOrEqual(2);
    expect(result.flags[0]).toMatchObject({ ref: 'skewed_2', at: T0 + skewMs + 2 });
    expect(result.flags.reduce((sum, flag) => sum + flag.count, 0)).toBe(result.refused);
  });

  it('reports a retry time from the real clock that is admitted when honoured after a step back', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      for (let i = 0; i < 5; i++) envelope.admit(one('drops'), T0 + 10_000, null);
      const rewound = envelope.admit(one('drops'), T0, null);
      if (rewound.admitted || rewound.retryAfterMs === null) throw new Error('expected a wait');
      return {
        early: envelope.admit(one('drops'), T0 + rewound.retryAfterMs - 1, null).admitted,
        onTime: envelope.admit(one('drops'), T0 + rewound.retryAfterMs, null).admitted,
      };
    });
    expect(result).toEqual({ early: false, onTime: true });
  });

  it('refuses non-integer, negative or non-finite times instead of guessing', async () => {
    await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => envelope.admit(one('drops'), bad, null)).toThrow(RangeError);
      }
    });
  });

  it('prunes aged events so a long session keeps storage bounded', async () => {
    const rows = await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      for (let ms = 0; ms < 60_000; ms += 200) envelope.admit(one('drops'), T0 + ms, null);
      return sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM envelope_events WHERE metric = 'drops'")
        .one().n;
    });
    expect(rows).toBeLessThanOrEqual(LIMITS.drops.max);
  });
});

describe('RateEnvelope limits from the economy config', () => {
  const BASE_TABLE: RateEnvelopeTable = {
    levels: {},
    venue: venues[0].id,
    charms: 0,
    albumBonus: 0,
  };

  it('meters exactly the metrics the economy config defines, each with a policy', () => {
    expect(Object.keys(ENVELOPE_POLICY).sort()).toEqual([...RATE_ENVELOPE_METRIC_IDS].sort());
  });

  it('enforces rateEnvelopeFor(table) on a base table, to the unit', async () => {
    const result = await inFreshDo((sql) => {
      const envelope = RateEnvelope.forTable(sql, BASE_TABLE);
      const { max } = rateEnvelope.crates;
      const admitted = Array.from(
        { length: max + 1 },
        (_, i) => envelope.admit(one('crates'), T0 + i, `crate_${i}`).admitted,
      );
      return { admitted, flags: envelope.flags() };
    });
    expect(result.admitted.filter(Boolean)).toHaveLength(rateEnvelope.crates.max);
    expect(result.admitted.at(-1)).toBe(false);
    expect(result.flags).toMatchObject([
      {
        metric: 'crates',
        max: rateEnvelope.crates.max,
        windowMs: rateEnvelope.crates.windowMs,
      },
    ]);
  });

  it('stretches with the table: a maxed upgrade line lifts the drop envelope', async () => {
    const dropLine = upgradeLines.find((line) => line.effect.stat === 'dropRate');
    if (dropLine === undefined) throw new Error('The economy config has no dropRate line.');
    const upgraded: RateEnvelopeTable = {
      ...BASE_TABLE,
      levels: { [dropLine.id]: dropLine.maxLevel },
    };
    const expected = rateEnvelopeFor(upgraded).drops.max;
    expect(expected).toBeGreaterThan(rateEnvelope.drops.max);
    const admitted = await inFreshDo((sql) => {
      const envelope = RateEnvelope.forTable(sql, upgraded);
      let count = 0;
      for (let i = 0; i < expected + 50; i++) {
        if (envelope.admit(one('drops'), T0, null).admitted) count++;
      }
      return count;
    });
    expect(admitted).toBe(expected);
  });

  it('refuses a table the economy config does not know instead of guessing limits', async () => {
    await inFreshDo((sql) => {
      expect(() =>
        RateEnvelope.forTable(sql, { ...BASE_TABLE, levels: { forged_line: 1 } }),
      ).toThrow(RangeError);
      expect(() => RateEnvelope.forTable(sql, { ...BASE_TABLE, charms: -1 })).toThrow(RangeError);
    });
  });
});

describe('RateEnvelope input validation', () => {
  it('rejects limits that would disable or invert the envelope', async () => {
    await inFreshDo((sql) => {
      for (const metric of RATE_ENVELOPE_METRIC_IDS) {
        for (const broken of [
          { windowMs: 0, max: 1 },
          { windowMs: -5, max: 1 },
          { windowMs: 1.5, max: 1 },
          { windowMs: 1_000, max: 0 },
          { windowMs: 1_000, max: Number.POSITIVE_INFINITY },
          { windowMs: 1_000, max: Number.NaN },
        ]) {
          expect(() => new RateEnvelope(sql, { ...LIMITS, [metric]: broken })).toThrow(RangeError);
        }
      }
    });
  });

  it('rejects forged charges: negative, fractional, non-finite or unknown metrics', async () => {
    await inFreshDo((sql) => {
      const envelope = new RateEnvelope(sql, LIMITS);
      for (const amount of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => envelope.admit([{ metric: 'drops', amount }], T0, null)).toThrow(RangeError);
      }
      expect(() =>
        envelope.admit([{ metric: 'coins' as RateEnvelopeMetricId, amount: 1 }], T0, null),
      ).toThrow(/Unknown envelope metric/);
      expect(envelope.usage('drops', T0)).toBe(0);
    });
  });
});
