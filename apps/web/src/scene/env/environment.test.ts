import { describe, expect, it } from 'vitest';
import { SUNSET_HDRI } from './environment.ts';

describe('SUNSET_HDRI', () => {
  it('points at the pre-graded 512 px CC0 asset with its sun bearing inside one turn', () => {
    expect(SUNSET_HDRI.url).toMatch(/venice_sunset_512\.hdr/);
    expect(Math.abs(SUNSET_HDRI.sunYaw)).toBeLessThan(Math.PI);
  });
});
