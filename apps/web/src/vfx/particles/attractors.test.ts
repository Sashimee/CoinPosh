import { describe, expect, it } from 'vitest';
import { AttractorTable } from './attractors.ts';
import { ATTRACTOR_SLOTS } from './layout.ts';

function centreOf(table: AttractorTable, slot: number): number[] {
  return Array.from(table.positions.subarray(slot * 4, slot * 4 + 3));
}

describe('AttractorTable', () => {
  it('hands out free slots first and writes the centre into the shared table', () => {
    const table = new AttractorTable();
    const a = table.lease(0.5, 0.25, -1);
    const b = table.lease(2, 0, 0);
    expect([a.slot, b.slot]).toEqual([0, 1]);
    expect(centreOf(table, 0)).toEqual([0.5, 0.25, -1]);
    expect(centreOf(table, 1)).toEqual([2, 0, 0]);
    expect(table.held).toBe(2);
    table.release(a);
    expect(table.lease(3, 3, 3).slot).toBe(0);
  });

  it('steals the oldest slot when full, and the robbed lease releases nothing', () => {
    const table = new AttractorTable();
    const first = Array.from({ length: ATTRACTOR_SLOTS }, (_, i) => table.lease(i, 0, 0));
    const thief = table.lease(9, 9, 9);
    expect(thief.slot).toBe(0);
    const second = table.lease(8, 8, 8);
    expect(second.slot).toBe(1);

    for (const lease of first) table.release(lease);
    expect(table.held).toBe(2);
    expect(centreOf(table, 0)).toEqual([9, 9, 9]);

    const later = table.lease(7, 7, 7);
    expect([2, 3]).toContain(later.slot);
    expect(centreOf(table, 0)).toEqual([9, 9, 9]);
    expect(centreOf(table, 1)).toEqual([8, 8, 8]);

    table.release(thief);
    table.release(thief);
    expect(table.held).toBe(2);
  });

  it('clear frees every slot', () => {
    const table = new AttractorTable();
    for (let i = 0; i < 6; i++) table.lease(i, i, i);
    table.clear();
    expect(table.held).toBe(0);
    expect(table.lease(1, 1, 1).slot).toBe(0);
  });
});
