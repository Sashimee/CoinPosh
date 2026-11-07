import { describe, expect, it } from 'vitest';
import { environmentYaw, SUNSET_HDRI } from './environment.ts';

describe('SUNSET_HDRI', () => {
  it('points at the bundled KTX2 asset with its sun bearing inside one turn', () => {
    expect(SUNSET_HDRI.url).toMatch(/venice_sunset_512\.ktx2/);
    expect(Math.abs(SUNSET_HDRI.sunYaw)).toBeLessThan(Math.PI);
  });
});

describe('environmentYaw', () => {
  it('turns the HDRI so its sun lands on the venue sun bearing', () => {
    const venueSun = -2.0;
    const yaw = environmentYaw(SUNSET_HDRI, venueSun);
    expect(SUNSET_HDRI.sunYaw - yaw).toBeCloseTo(venueSun, 10);
    expect(environmentYaw(SUNSET_HDRI, SUNSET_HDRI.sunYaw)).toBe(0);
  });
});
