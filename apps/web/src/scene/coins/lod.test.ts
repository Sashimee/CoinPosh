import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera } from 'three/webgpu';
import { CoinLod, partitionByLod, pixelsPerUnit, type LodOutput, type LodSettings } from './lod.ts';

const settings: LodSettings = { nearPixelRadius: 20, hysteresis: 0.1 };

function output(capacity: number): LodOutput {
  return {
    near: new Uint32Array(capacity),
    far: new Uint32Array(capacity),
    nearCount: 0,
    farCount: 0,
  };
}

function view(ppu: number, frustum: Frustum | null = null) {
  return { cameraX: 0, cameraY: 0, cameraZ: 0, pixelsPerUnitAtUnitDistance: ppu, frustum };
}

describe('pixelsPerUnit', () => {
  it('maps a 90 degree vertical fov to half the viewport per unit at unit distance', () => {
    expect(pixelsPerUnit(90, 800)).toBeCloseTo(400, 6);
  });

  it('grows as the fov narrows', () => {
    expect(pixelsPerUnit(30, 800)).toBeGreaterThan(pixelsPerUnit(60, 800));
  });
});

describe('partitionByLod', () => {
  it('splits coins by projected radius', () => {
    const positions = new Float32Array([0, 0, -1, 0, 0, -10, 0, 0, -100]);
    const out = output(3);
    partitionByLod(
      { positions, count: 3, radius: 1, state: new Uint8Array(3) },
      view(100),
      settings,
      out,
    );
    expect([...out.near.subarray(0, out.nearCount)]).toEqual([0]);
    expect([...out.far.subarray(0, out.farCount)]).toEqual([1, 2]);
  });

  it('ignores slots beyond count', () => {
    const positions = new Float32Array([0, 0, -1, 0, 0, -1]);
    const out = output(2);
    partitionByLod(
      { positions, count: 1, radius: 1, state: new Uint8Array(2) },
      view(100),
      settings,
      out,
    );
    expect(out.nearCount + out.farCount).toBe(1);
  });

  it('holds the current level inside the hysteresis band', () => {
    const positions = new Float32Array([0, 0, -5]);
    const state = new Uint8Array([CoinLod.near]);
    const out = output(1);
    const atThreshold = 20 * 5;

    partitionByLod(
      { positions, count: 1, radius: 1, state },
      view(atThreshold * 0.95),
      settings,
      out,
    );
    expect(out.nearCount).toBe(1);

    partitionByLod(
      { positions, count: 1, radius: 1, state },
      view(atThreshold * 0.85),
      settings,
      out,
    );
    expect(out.farCount).toBe(1);
    expect(state[0]).toBe(CoinLod.far);

    partitionByLod(
      { positions, count: 1, radius: 1, state },
      view(atThreshold * 1.05),
      settings,
      out,
    );
    expect(out.farCount).toBe(1);

    partitionByLod(
      { positions, count: 1, radius: 1, state },
      view(atThreshold * 1.15),
      settings,
      out,
    );
    expect(out.nearCount).toBe(1);
    expect(state[0]).toBe(CoinLod.near);
  });

  it('decides a coin with no level yet on the plain threshold, without hysteresis bias', () => {
    const positions = new Float32Array([0, 0, -5, 0, 0, -5]);
    const state = new Uint8Array([CoinLod.unset, CoinLod.near]);
    const out = output(2);
    partitionByLod({ positions, count: 2, radius: 1, state }, view(20 * 5 * 0.95), settings, out);
    expect([...out.far.subarray(0, out.farCount)]).toEqual([0]);
    expect([...out.near.subarray(0, out.nearCount)]).toEqual([1]);
    expect([...state]).toEqual([CoinLod.far, CoinLod.near]);

    state[0] = CoinLod.unset;
    partitionByLod({ positions, count: 1, radius: 1, state }, view(20 * 5 * 1.02), settings, out);
    expect(out.nearCount).toBe(1);
    expect(state[0]).toBe(CoinLod.near);
  });

  it('culls coins entirely outside the frustum but keeps ones straddling a plane', () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const positions = new Float32Array([0, 0, -5, 0, 0, 5, 50, 0, -5, 0, 0, 0.5]);
    const out = output(4);
    partitionByLod(
      { positions, count: 4, radius: 1, state: new Uint8Array(4) },
      view(100, frustum),
      settings,
      out,
    );
    const visible = [
      ...out.near.subarray(0, out.nearCount),
      ...out.far.subarray(0, out.farCount),
    ].sort();
    expect(visible).toEqual([0, 3]);
  });
});
