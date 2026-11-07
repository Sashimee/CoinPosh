import { describe, expect, it } from 'vitest';
import { StateHasher } from './hash.ts';

describe('StateHasher', () => {
  it('is a pure function of the words fed to it', () => {
    const digest = () => new StateHasher().int(3600).float(0.1).bool(true).digest();
    expect(digest()).toBe(digest());
    expect(digest()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('pins the digest of an empty and a known input', () => {
    expect(new StateHasher().digest()).toMatchInlineSnapshot(`"ab3e7c0ba183f3bb"`);
    expect(
      new StateHasher()
        .uint32(1)
        .int(-5)
        .float(-0.25)
        .vec3({ x: 1, y: 2, z: 3 })
        .quat({ x: 0, y: 0, z: 0, w: 1 })
        .bool(false)
        .digest(),
    ).toMatchInlineSnapshot(`"5157350a59490ecb"`);
  });

  it('separates values that differ by a single ulp', () => {
    const a = new StateHasher().float(0.1).digest();
    const b = new StateHasher().float(0.1 + Number.EPSILON / 16).digest();
    expect(0.1 + Number.EPSILON / 16).not.toBe(0.1);
    expect(a).not.toBe(b);
  });

  it('distinguishes +0 from -0 because Rapier state can carry either', () => {
    expect(new StateHasher().float(0).digest()).not.toBe(new StateHasher().float(-0).digest());
  });

  it('is sensitive to order and length', () => {
    expect(new StateHasher().uint32(1).uint32(2).digest()).not.toBe(
      new StateHasher().uint32(2).uint32(1).digest(),
    );
    expect(new StateHasher().uint32(0).digest()).not.toBe(
      new StateHasher().uint32(0).uint32(0).digest(),
    );
    expect(new StateHasher().digest()).not.toBe(new StateHasher().uint32(0).digest());
  });

  it('hashes integers beyond 32 bits by both halves', () => {
    expect(new StateHasher().int(4294967296).digest()).not.toBe(new StateHasher().int(0).digest());
    expect(new StateHasher().int(-1).digest()).not.toBe(new StateHasher().int(4294967295).digest());
  });

  it('fails loudly on non-finite floats and unsafe integers', () => {
    expect(() => new StateHasher().float(Number.NaN)).toThrow(/diverged/);
    expect(() => new StateHasher().float(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => new StateHasher().int(0.5)).toThrow(RangeError);
    expect(() => new StateHasher().int(9007199254740992)).toThrow(RangeError);
  });
});
