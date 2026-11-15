import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EconomyConfig, FirstTicketRule } from '../types.ts';
import { validateEconomyConfig } from '../validate.ts';
import { crateRewards, crateSpawn, firstTicketBonus } from './drops.ts';
import { economyConfig } from './index.ts';

const ROLLABLE_TICKETS: readonly number[] = [
  ...new Set(Object.values(crateRewards).map((r) => r.tickets)),
];

interface Open {
  readonly rolled: number;
  readonly bonus: number;
}

/** Opens crates in order, each paying its roll plus the guarantee, as server and Demo do. */
function openAll(rule: FirstTicketRule, rolls: readonly number[]): Open[] {
  let ticketsBefore = 0;
  return rolls.map((rolled, opensBefore) => {
    const bonus = firstTicketBonus(rule, { opensBefore, ticketsBefore }, rolled);
    ticketsBefore += rolled + bonus;
    return { rolled, bonus };
  });
}

function withFirstTicket(firstTicket: FirstTicketRule): EconomyConfig {
  return { ...economyConfig, crateSpawn: { ...economyConfig.crateSpawn, firstTicket } };
}

const rules = fc.record({
  byCrate: fc.integer({ min: 1, max: 8 }),
  amount: fc.integer({ min: 1, max: 3 }),
});
const rollSequences = fc.array(fc.constantFrom(...ROLLABLE_TICKETS), {
  minLength: 1,
  maxLength: 24,
});

describe('crateSpawn.firstTicket', () => {
  it('pays a first Ticket within the first 3 Vault Crates of a session (P-737)', () => {
    expect(validateEconomyConfig(economyConfig)).toEqual([]);
    expect(crateSpawn.firstTicket.byCrate).toBeGreaterThanOrEqual(1);
    expect(crateSpawn.firstTicket.byCrate).toBeLessThanOrEqual(3);
    expect(crateSpawn.firstTicket.amount).toBeGreaterThanOrEqual(1);
  });

  it('turns crate 1 of a fresh session, the scripted crate that rolls none, into a Ticket', () => {
    expect(crateRewards[crateSpawn.ftueScriptedRarity].tickets).toBe(0);
    const [first] = openAll(crateSpawn.firstTicket, [
      crateRewards[crateSpawn.ftueScriptedRarity].tickets,
    ]);
    expect(first).toEqual({ rolled: 0, bonus: crateSpawn.firstTicket.amount });
  });

  it.each([
    [{ byCrate: 0, amount: 1 }, 'crateSpawn.firstTicket.byCrate'],
    [{ byCrate: 1.5, amount: 1 }, 'crateSpawn.firstTicket.byCrate'],
    [{ byCrate: 3, amount: 0 }, 'crateSpawn.firstTicket.amount'],
    [{ byCrate: 3, amount: -1 }, 'crateSpawn.firstTicket.amount'],
    [{ byCrate: 3, amount: 0.5 }, 'crateSpawn.firstTicket.amount'],
  ])('rejects %o', (rule, path) => {
    expect(validateEconomyConfig(withFirstTicket(rule)).map((issue) => issue.path)).toEqual([path]);
  });

  it('every session holds a Ticket by crate byCrate, whatever the rolls', () => {
    fc.assert(
      fc.property(rules, rollSequences, (rule, rolls) => {
        const opens = openAll(rule, rolls);
        const firstPaid = opens.findIndex((open) => open.rolled + open.bonus > 0);
        if (rolls.length >= rule.byCrate) {
          expect(firstPaid).toBeGreaterThanOrEqual(0);
          expect(firstPaid).toBeLessThan(rule.byCrate);
        }
      }),
    );
  });

  it('adds at most one grant, only on crate byCrate, and only when nothing paid a Ticket yet', () => {
    fc.assert(
      fc.property(rules, rollSequences, (rule, rolls) => {
        const opens = openAll(rule, rolls);
        const granted = opens.flatMap((open, i) => (open.bonus > 0 ? [i] : []));
        expect(granted.length).toBeLessThanOrEqual(1);
        for (const i of granted) {
          expect(i).toBe(rule.byCrate - 1);
          expect(opens[i]?.bonus).toBe(rule.amount);
          expect(opens.slice(0, i + 1).every((open) => open.rolled === 0)).toBe(true);
        }
        const anyRolledEarly = rolls.slice(0, rule.byCrate).some((rolled) => rolled > 0);
        if (anyRolledEarly) expect(granted).toEqual([]);
      }),
    );
  });

  it('never takes from a roll: a session pays exactly its rolls plus the one grant', () => {
    fc.assert(
      fc.property(rules, rollSequences, (rule, rolls) => {
        const opens = openAll(rule, rolls);
        const paid = opens.reduce((sum, open) => sum + open.rolled + open.bonus, 0);
        const rolled = rolls.reduce((sum, n) => sum + n, 0);
        const bonus = opens.reduce((sum, open) => sum + open.bonus, 0);
        expect(opens.every((open) => open.bonus >= 0)).toBe(true);
        expect(paid).toBe(rolled + bonus);
        expect(bonus === 0 || bonus === rule.amount).toBe(true);
      }),
    );
  });

  it('leaves a history that already paid a Ticket alone', () => {
    fc.assert(
      fc.property(
        rules,
        fc.nat({ max: 20 }),
        fc.integer({ min: 1, max: 5 }),
        (rule, opensBefore, ticketsBefore) => {
          expect(firstTicketBonus(rule, { opensBefore, ticketsBefore }, 0)).toBe(0);
        },
      ),
    );
  });
});
