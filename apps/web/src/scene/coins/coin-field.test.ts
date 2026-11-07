import { afterEach, describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import { CoinField } from './coin-field.ts';
import { COIN_LOOKS, COIN_TIER_IDS, isCoinTierId } from './tiers.ts';

const fields: CoinField[] = [];
function field(...args: ConstructorParameters<typeof CoinField>): CoinField {
  const created = new CoinField(...args);
  fields.push(created);
  return created;
}
afterEach(() => {
  for (const f of fields.splice(0)) f.dispose();
});

function lookingDownMinusZ(): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 1, 0.1, 500);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

describe('tiers', () => {
  it('defines a look for every tier and recognises only those ids', () => {
    for (const tier of COIN_TIER_IDS) expect(COIN_LOOKS[tier]).toBeDefined();
    expect(isCoinTierId('heirloom')).toBe(true);
    expect(isCoinTierId('bronze')).toBe(false);
    expect(COIN_LOOKS.gold.metal).toBe('#D4AF37');
    expect(COIN_TIER_IDS.filter((t) => COIN_LOOKS[t].prismatic)).toEqual(['heirloom']);
  });
});

describe('CoinField', () => {
  it('builds one near and one far instanced mesh per tier', () => {
    const coins = field({ capacity: 4 });
    expect(coins.object.children).toHaveLength(COIN_TIER_IDS.length * 2);
    for (const tier of COIN_TIER_IDS) {
      const near = coins.mesh(tier, 'near');
      const far = coins.mesh(tier, 'far');
      expect(near.isInstancedMesh).toBe(true);
      expect(near.material).toBe(far.material);
      expect(near.geometry.getIndex()?.count ?? 0).toBeGreaterThan(
        far.geometry.getIndex()?.count ?? 0,
      );
    }
  });

  it('rejects bad capacities, counts and slots', () => {
    expect(() => new CoinField({ capacity: -1 })).toThrow(/capacity/);
    expect(() => new CoinField({ capacity: 1, radius: 0 })).toThrow(/radius/);
    const coins = field({
      capacity: { copper: 2, silver: 0, gold: 1, platinum: 0, diamond: 0, heirloom: 0 },
    });
    expect(coins.capacity('copper')).toBe(2);
    expect(() => {
      coins.setCount('copper', 3);
    }).toThrow(/capacity/);
    expect(() => {
      coins.setCount('silver', 1);
    }).toThrow(/capacity/);
    expect(() => {
      coins.setTransform('gold', 1, 0, 0, 0, 0, 0, 0, 1);
    }).toThrow(/capacity/);
    expect(() => {
      coins.setTransforms('copper', [0, 0, 0], [0, 0, 0, 1], 2);
    }).toThrow(/need/);
  });

  it('draws nothing until coins are counted in', () => {
    const coins = field({ capacity: 8 });
    expect(coins.update(lookingDownMinusZ(), 720)).toEqual({
      near: 0,
      far: 0,
      culled: 0,
      drawCalls: 0,
    });
    for (const child of coins.object.children) expect(child.visible).toBe(false);
  });

  it('partitions coins into near, far and culled with one draw call per populated mesh', () => {
    const coins = field({ capacity: 4, radius: 0.5 });
    const q = [0, 0, 0, 1];
    coins.setTransforms('gold', [0, 0, -3, 0, 0, -400, 0, 0, 10], [...q, ...q, ...q], 3);
    coins.setTransforms('copper', [0, 0, -400], q, 1);
    const stats = coins.update(lookingDownMinusZ(), 720);
    expect(stats).toEqual({ near: 1, far: 2, culled: 1, drawCalls: 3 });
    expect(coins.mesh('gold', 'near').count).toBe(1);
    expect(coins.mesh('gold', 'far').count).toBe(1);
    expect(coins.mesh('copper', 'far').visible).toBe(true);
    expect(coins.mesh('silver', 'near').visible).toBe(false);
  });

  it('writes the slot transform scaled by the coin radius and a stable per-slot seed', () => {
    const coins = field({ capacity: 3, radius: 0.4 });
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    coins.setCount('silver', 3);
    coins.setTransform('silver', 0, 0, 0, 500, 0, 0, 0, 1);
    coins.setTransform('silver', 1, 0, 0, 20, 0, 0, 0, 1);
    coins.setTransform('silver', 2, 1, 2, -6, rotation.x, rotation.y, rotation.z, rotation.w);
    coins.update(lookingDownMinusZ(), 720);

    const mesh = coins.mesh('silver', 'near');
    expect(mesh.count).toBe(1);
    const actual = new Matrix4();
    mesh.getMatrixAt(0, actual);
    const expected = new Matrix4().compose(
      new Vector3(1, 2, -6),
      rotation,
      new Vector3(0.4, 0.4, 0.4),
    );
    actual.elements.forEach((v, i) => {
      expect(v).toBeCloseTo(expected.elements[i] ?? Number.NaN, 5);
    });

    const seed = mesh.geometry.getAttribute('coinSeed').getX(0);
    coins.setTransform('silver', 2, 1, 2, -400, rotation.x, rotation.y, rotation.z, rotation.w);
    coins.update(lookingDownMinusZ(), 720);
    expect(coins.mesh('silver', 'far').geometry.getAttribute('coinSeed').getX(0)).toBe(seed);
  });
});
