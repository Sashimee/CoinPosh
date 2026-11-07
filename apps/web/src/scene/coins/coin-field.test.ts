import { afterEach, describe, expect, it } from 'vitest';
import { DirectionalLight, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import { COIN_SHADOW_LAYER, CoinField } from './coin-field.ts';
import { NEAR_COIN_GEOMETRY } from './geometry.ts';
import { DEFAULT_LOD_SETTINGS } from './lod.ts';
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
  it('builds one near and one far instanced mesh per tier plus one shadow caster', () => {
    const coins = field({ capacity: 4 });
    expect(coins.object.children).toHaveLength(COIN_TIER_IDS.length * 2 + 1);
    for (const tier of COIN_TIER_IDS) {
      const near = coins.mesh(tier, 'near');
      const far = coins.mesh(tier, 'far');
      expect(near.isInstancedMesh).toBe(true);
      expect(near.material).toBe(far.material);
      expect(near.castShadow).toBe(false);
      expect(far.castShadow).toBe(false);
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
    coins.setTransform('silver', 2, 1, 0.5, -4, rotation.x, rotation.y, rotation.z, rotation.w);
    coins.update(lookingDownMinusZ(), 720);

    const mesh = coins.mesh('silver', 'near');
    expect(mesh.count).toBe(1);
    const actual = new Matrix4();
    mesh.getMatrixAt(0, actual);
    const expected = new Matrix4().compose(
      new Vector3(1, 0.5, -4),
      rotation,
      new Vector3(0.4, 0.4, 0.4),
    );
    actual.elements.forEach((v, i) => {
      expect(v).toBeCloseTo(expected.elements[i] ?? Number.NaN, 5);
    });

    const seed = mesh.geometry.getAttribute('coinSeed').getX(0);
    coins.setTransform('silver', 2, 1, 0.5, -400, rotation.x, rotation.y, rotation.z, rotation.w);
    coins.update(lookingDownMinusZ(), 720);
    expect(coins.mesh('silver', 'far').geometry.getAttribute('coinSeed').getX(0)).toBe(seed);
  });

  it('seeds tint from caller ids so compacting slots keeps each coin its colour', () => {
    const coins = field({ capacity: 3, radius: 0.5 });
    const q = [0, 0, 0, 1];
    const seedOf = (slot: number): number =>
      coins.mesh('gold', 'near').geometry.getAttribute('coinSeed').getX(slot);

    coins.setTransforms(
      'gold',
      [0, 0, -3, 0.3, 0, -3, 0.6, 0, -3],
      [...q, ...q, ...q],
      3,
      [41, 42, 43],
    );
    coins.update(lookingDownMinusZ(), 720);
    const before = [seedOf(0), seedOf(1), seedOf(2)];

    coins.setTransforms('gold', [0.3, 0, -3, 0.6, 0, -3], [...q, ...q], 2, [42, 43]);
    coins.update(lookingDownMinusZ(), 720);
    expect([seedOf(0), seedOf(1)]).toEqual([before[1], before[2]]);

    coins.setTransforms('gold', [0.3, 0, -3, 0.6, 0, -3], [...q, ...q], 2);
    coins.update(lookingDownMinusZ(), 720);
    const slotSeed = (before[0] ?? 0) - 41;
    expect([seedOf(0), seedOf(1)]).toEqual([slotSeed, slotSeed + 1]);

    expect(() => {
      coins.setTransforms('gold', [0, 0, 0], q, 1, []);
    }).toThrow(/ids/);
    expect(() => {
      coins.setTransforms('gold', [0, 0, 0], q, 1, [Number.NaN]);
    }).toThrow(/id 0/);
  });

  it('reuses its stats object instead of allocating one per frame', () => {
    const coins = field({ capacity: 2 });
    const first = coins.update(lookingDownMinusZ(), 720);
    coins.setTransforms('gold', [0, 0, -3], [0, 0, 0, 1], 1);
    const second = coins.update(lookingDownMinusZ(), 720);
    expect(second).toBe(first);
    expect(second.near + second.far).toBe(1);
  });

  it('casts shadows from every coin, on-screen or not, through one far-LOD caster', () => {
    const coins = field({ capacity: 3, radius: 0.5 });
    const caster = coins.shadowCasterMesh;
    if (!caster) throw new Error('expected a shadow caster');
    expect(caster.castShadow).toBe(true);
    expect(caster.layers.isEnabled(COIN_SHADOW_LAYER)).toBe(true);
    expect(caster.layers.isEnabled(0)).toBe(false);
    expect(caster.geometry.getIndex()?.count).toBe(
      coins.mesh('gold', 'far').geometry.getIndex()?.count,
    );

    const q = [0, 0, 0, 1];
    coins.setTransforms('gold', [0, 0, -3, 0, 0, 10], [...q, ...q], 2);
    coins.setTransforms('copper', [0, 0, -400], q, 1);
    coins.update(lookingDownMinusZ(), 720);
    expect(caster.count).toBe(0);

    const light = new DirectionalLight();
    coins.castShadowsFrom(light);
    expect(light.shadow.camera.layers.isEnabled(COIN_SHADOW_LAYER)).toBe(true);
    expect(light.shadow.camera.layers.isEnabled(0)).toBe(true);
    const stats = coins.update(lookingDownMinusZ(), 720);
    expect(stats.culled).toBe(1);
    expect(caster.count).toBe(3);
    expect(caster.visible).toBe(true);
  });

  it('refuses a shadow light when built without a caster', () => {
    const coins = field({ capacity: 1, castShadow: false });
    expect(coins.shadowCasterMesh).toBeNull();
    expect(coins.object.children).toHaveLength(COIN_TIER_IDS.length * 2);
    expect(() => {
      coins.castShadowsFrom(new DirectionalLight());
    }).toThrow(/castShadow/);
  });

  // The lookdev pile framing: a 9 x 14 table of 0.42-radius coins seen from the player's seat.
  describe('at table framing', () => {
    const radius = 0.42;
    const columns = 18;
    const rows = 28;

    function tableCamera(aspect: number): PerspectiveCamera {
      const camera = new PerspectiveCamera(30, aspect, 0.05, 200);
      camera.position.set(0, 3.6, 7.2);
      camera.lookAt(0, 0, -2.2);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      return camera;
    }

    function tableField(): CoinField {
      const coins = field({ capacity: columns * rows, radius });
      const positions: number[] = [];
      const quaternions: number[] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          positions.push(-4.5 + (col + 0.5) * 0.5, 0.045, -9.2 + (row + 0.5) * 0.5);
          quaternions.push(0, 0, 0, 1);
        }
      }
      coins.setTransforms('copper', positions, quaternions, columns * rows);
      return coins;
    }

    const frameTriangleBudget = 500_000;
    const trianglesOf = (coins: CoinField, level: 'near' | 'far'): number =>
      (coins.mesh('copper', level).geometry.getIndex()?.count ?? 0) / 3;

    it.each([
      ['desktop', 1000, 700],
      ['phone portrait', 390, 844],
    ])('splits the table between both meshes within budget on %s', (_, width, height) => {
      const coins = tableField();
      const stats = coins.update(tableCamera(width / height), height);
      expect(stats.near).toBeGreaterThan(0);
      expect(stats.far).toBeGreaterThan(0);
      const triangles =
        stats.near * trianglesOf(coins, 'near') + stats.far * trianglesOf(coins, 'far');
      expect(triangles).toBeLessThan(frameTriangleBudget);
    });

    it('keeps reeds at least 3 css px apart on every near coin', () => {
      const coins = tableField();
      const height = 844;
      const camera = tableCamera(390 / height);
      coins.update(camera, height);
      const near = coins.mesh('copper', 'near');
      const ppu = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      const matrix = new Matrix4();
      const position = new Vector3();
      const minRadius =
        DEFAULT_LOD_SETTINGS.nearPixelRadius * (1 - DEFAULT_LOD_SETTINGS.hysteresis);
      for (let i = 0; i < near.count; i += 1) {
        near.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        const projected = (radius * ppu) / position.distanceTo(camera.position);
        expect(projected).toBeGreaterThanOrEqual(minRadius * 0.99);
        expect((2 * Math.PI * projected) / NEAR_COIN_GEOMETRY.reeds).toBeGreaterThanOrEqual(3);
      }
    });

    it('picks the same split whatever the device pixel ratio', () => {
      const a = tableField();
      const b = tableField();
      const camera = tableCamera(390 / 844);
      const css = { ...a.update(camera, 844) };
      expect(b.update(camera, 844)).toEqual(css);
    });
  });
});
