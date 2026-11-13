import { afterEach, describe, expect, it } from 'vitest';
import {
  Color,
  DirectionalLight,
  InstancedMesh,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { COIN_SHADOW_LAYER, CoinField } from './coin-field.ts';
import { NEAR_COIN_GEOMETRY } from './geometry.ts';
import { HIGHLIGHT_KNEE } from './materials.ts';
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

  it('caps highlights above the knee and lets only the sparkle tiers glint brighter', () => {
    for (const tier of COIN_TIER_IDS)
      expect(COIN_LOOKS[tier].highlightCeiling).toBeGreaterThan(HIGHLIGHT_KNEE);
    const bright = COIN_TIER_IDS.filter((t) => COIN_LOOKS[t].highlightCeiling > 2);
    expect(bright).toEqual(['diamond', 'heirloom']);
    for (const tier of bright) expect(COIN_LOOKS[tier].sparkle).toBeGreaterThan(0);
  });

  it('keeps silver neutral rather than blue-grey', () => {
    const silver = new Color(COIN_LOOKS.silver.metal);
    expect(silver.b - silver.r).toBeLessThanOrEqual(0.02);
    expect(
      Math.max(silver.r, silver.g, silver.b) - Math.min(silver.r, silver.g, silver.b),
    ).toBeLessThan(0.03);
  });
});

describe('CoinField', () => {
  it('builds one near and one far instanced mesh per tier plus contact occlusion and a shadow caster', () => {
    const coins = field({ capacity: 4 });
    expect(coins.object.children).toHaveLength(COIN_TIER_IDS.length * 2 + 2);
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

  it('has no face texture to lend before its first bake', () => {
    const coins = field({ capacity: 1 });
    for (const tier of COIN_TIER_IDS) expect(coins.faceTexture(tier)).toBeNull();
  });

  it('rejects bad capacities, counts and ids without touching the current set', () => {
    expect(() => new CoinField({ capacity: -1 })).toThrow(/capacity/);
    expect(() => new CoinField({ capacity: 1, radius: 0 })).toThrow(/radius/);
    const coins = field({
      capacity: { copper: 2, silver: 0, gold: 2, platinum: 0, diamond: 0, heirloom: 0 },
    });
    expect(coins.capacity('copper')).toBe(2);
    const q = [0, 0, 0, 1];
    const three = [0, 0, -3, 0, 0, -3, 0, 0, -3];
    coins.setTransforms('gold', [0, 0, -3], q, 1, [7]);

    const rejected: [string, () => void, RegExp][] = [
      [
        'over capacity',
        () => {
          coins.setTransforms('copper', three, [...q, ...q, ...q], 3, [1, 2, 3]);
        },
        /capacity/,
      ],
      [
        'zero-capacity tier',
        () => {
          coins.setTransforms('silver', [0, 0, 0], q, 1, [1]);
        },
        /capacity/,
      ],
      [
        'short positions',
        () => {
          coins.setTransforms('copper', [0, 0, 0], [...q, ...q], 2, [1, 2]);
        },
        /need/,
      ],
      [
        'short ids',
        () => {
          coins.setTransforms('gold', [0, 0, 0], q, 1, []);
        },
        /need/,
      ],
      [
        'NaN id',
        () => {
          coins.setTransforms('gold', [0, 0, 0], q, 1, [Number.NaN]);
        },
        /id at 0/,
      ],
      [
        'fractional id',
        () => {
          coins.setTransforms('gold', [0, 0, 0], q, 1, [1.5]);
        },
        /id at 0/,
      ],
      [
        'duplicate id',
        () => {
          coins.setTransforms('gold', [0, 0, 0, 1, 0, 0], [...q, ...q], 2, [4, 4]);
        },
        /twice/,
      ],
    ];
    for (const [label, call, message] of rejected) {
      expect(call, label).toThrow(message);
    }
    expect(coins.count('gold')).toBe(1);
    expect(coins.idAt('gold', 0)).toBe(7);
    expect(coins.idAt('gold', 1)).toBeUndefined();
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

  it('lays one contact disc flat under each coin, vanishing as the coin stands on its rim', () => {
    const coins = field({ capacity: 2, radius: 0.5 });
    const flat = [0, 0, 0, 1];
    const onRim = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    coins.setTransforms('gold', [1, 0.05, -3, -0.5, 0.5, -3], [...flat, ...onRim], 2, [1, 2]);
    coins.update(lookingDownMinusZ(), 720);
    const contact = coins.object.getObjectByName('coins-contact-occlusion');
    if (!(contact instanceof InstancedMesh)) throw new Error('no contact occlusion mesh');
    expect(contact.count).toBe(2);
    expect(contact.visible).toBe(true);
    const m = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();
    contact.getMatrixAt(0, m);
    m.decompose(position, new Quaternion(), scale);
    expect(scale.x).toBeCloseTo(0.5, 6);
    expect(position.x).toBeCloseTo(1, 6);
    expect(position.y).toBeLessThan(0.05);
    expect(position.y).toBeGreaterThan(0);
    contact.getMatrixAt(1, m);
    m.decompose(position, new Quaternion(), scale);
    expect(scale.x).toBeCloseTo(0, 6);
    expect(coins.contactMesh.geometry.getAttribute('contactStrength').getX(0)).toBe(1);
  });

  describe('contact discs under moving coins', () => {
    const flat = [0, 0, 0, 1];
    const contactOf = (coins: CoinField): InstancedMesh => coins.contactMesh;
    const strengthAt = (coins: CoinField, k: number): number =>
      contactOf(coins).geometry.getAttribute('contactStrength').getX(k);

    it('drops the disc of a falling coin and eases it back in once the coin lands', () => {
      const coins = field({ capacity: 2, radius: 0.5 });
      const camera = lookingDownMinusZ();
      const frame = (fallingY: number): void => {
        coins.setTransforms('gold', [-1, 0, -3, 1, fallingY, -3], [...flat, ...flat], 2, [1, 2]);
        coins.update(camera, 720);
      };
      frame(0.6);
      expect(contactOf(coins).count).toBe(2);

      frame(0.3);
      expect(contactOf(coins).count).toBe(1);
      expect(coins.stats.drawCalls).toBe(2);

      frame(0.3);
      expect(contactOf(coins).count).toBe(2);
      const landed = strengthAt(coins, 1);
      expect(landed).toBeGreaterThan(0);
      expect(landed).toBeLessThan(0.3);
      const m = new Matrix4();
      const scale = new Vector3();
      contactOf(coins).getMatrixAt(1, m);
      m.decompose(new Vector3(), new Quaternion(), scale);
      expect(scale.x).toBeLessThan(0.5 * 0.65);

      for (let i = 0; i < 30; i += 1) frame(0.3);
      expect(strengthAt(coins, 1)).toBe(1);
      contactOf(coins).getMatrixAt(1, m);
      m.decompose(new Vector3(), new Quaternion(), scale);
      expect(scale.x).toBeCloseTo(0.5, 6);
    });

    it('keeps the disc of a coin sliding sideways on the pusher', () => {
      const coins = field({ capacity: 1, radius: 0.5 });
      const camera = lookingDownMinusZ();
      for (const x of [0, 0.2, 0.4]) {
        coins.setTransforms('gold', [x, 0, -3], flat, 1, [1]);
        coins.update(camera, 720);
      }
      expect(contactOf(coins).count).toBe(1);
      expect(strengthAt(coins, 0)).toBe(1);
    });

    it('starts a coin dropped in after the first frame without a disc', () => {
      const coins = field({ capacity: 2, radius: 0.5 });
      const camera = lookingDownMinusZ();
      coins.setTransforms('gold', [0, 0, -3], flat, 1, [1]);
      coins.update(camera, 720);
      coins.setTransforms('gold', [0, 0, -3, 0.5, 1, -3], [...flat, ...flat], 2, [1, 2]);
      coins.update(camera, 720);
      expect(contactOf(coins).count).toBe(1);
    });

    it('skips culled coins and draws no contact call when every coin is culled', () => {
      const coins = field({ capacity: 2, radius: 0.5 });
      coins.setTransforms('gold', [0, 0, -3, 0, 0, 10], [...flat, ...flat], 2, [1, 2]);
      coins.update(lookingDownMinusZ(), 720);
      expect(contactOf(coins).count).toBe(1);

      coins.setTransforms('gold', [0, 0, 10], flat, 1, [2]);
      const stats = coins.update(lookingDownMinusZ(), 720);
      expect(stats.culled).toBe(1);
      expect(stats.drawCalls).toBe(0);
      expect(contactOf(coins).visible).toBe(false);
    });

    it('re-uploads nothing while the coins and the camera hold still', () => {
      const coins = field({ capacity: 1, radius: 0.5 });
      const camera = lookingDownMinusZ();
      coins.setTransforms('gold', [0, 0, -3], flat, 1, [1]);
      coins.update(camera, 720);
      const version = contactOf(coins).instanceMatrix.version;
      coins.setTransforms('gold', [0, 0, -3], flat, 1, [1]);
      const stats = coins.update(camera, 720);
      expect(contactOf(coins).instanceMatrix.version).toBe(version);
      expect(stats.drawCalls).toBe(2);

      camera.position.x = 0.1;
      camera.updateMatrixWorld();
      coins.update(camera, 720);
      expect(contactOf(coins).instanceMatrix.version).toBe(version + 1);
    });
  });

  it('partitions coins into near, far and culled with one draw call per populated mesh', () => {
    const coins = field({ capacity: 4, radius: 0.5 });
    const q = [0, 0, 0, 1];
    coins.setTransforms('gold', [0, 0, -3, 0, 0, -400, 0, 0, 10], [...q, ...q, ...q], 3, [1, 2, 3]);
    coins.setTransforms('copper', [0, 0, -400], q, 1, [1]);
    const stats = coins.update(lookingDownMinusZ(), 720);
    expect(stats).toEqual({ near: 1, far: 2, culled: 1, drawCalls: 4 });
    expect(coins.mesh('gold', 'near').count).toBe(1);
    expect(coins.mesh('gold', 'far').count).toBe(1);
    expect(coins.mesh('copper', 'far').visible).toBe(true);
    expect(coins.mesh('silver', 'near').visible).toBe(false);
  });

  it('writes the coin transform scaled by the coin radius and keeps its seed across LODs', () => {
    const coins = field({ capacity: 3, radius: 0.4 });
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
    const r = [rotation.x, rotation.y, rotation.z, rotation.w];
    const q = [0, 0, 0, 1];
    const ids = [10, 11, 12];
    coins.setTransforms('silver', [0, 0, 500, 0, 0, 20, 1, 0.5, -4], [...q, ...q, ...r], 3, ids);
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
    actual.elements.forEach((value, i) => {
      expect(value).toBeCloseTo(expected.elements[i] ?? Number.NaN, 5);
    });

    const seed = mesh.geometry.getAttribute('coinSeed').getX(0);
    coins.setTransforms('silver', [0, 0, 500, 0, 0, 20, 1, 0.5, -400], [...q, ...q, ...r], 3, ids);
    coins.update(lookingDownMinusZ(), 720);
    expect(coins.mesh('silver', 'far').geometry.getAttribute('coinSeed').getX(0)).toBe(seed);
  });

  describe('keys per-coin state by coin id, not slot', () => {
    const q = [0, 0, 0, 1];
    const seedOf = (coins: CoinField, level: 'near' | 'far', k: number): number =>
      coins.mesh('gold', level).geometry.getAttribute('coinSeed').getX(k);

    it('keeps each coin its seed when slots are compacted, reordered or reused', () => {
      const coins = field({ capacity: 3, radius: 0.5 });
      coins.setTransforms(
        'gold',
        [0, 0, -3, 0.3, 0, -3, 0.6, 0, -3],
        [...q, ...q, ...q],
        3,
        [41, 42, 43],
      );
      coins.update(lookingDownMinusZ(), 720);
      const byId = new Map([41, 42, 43].map((id, k) => [id, seedOf(coins, 'near', k)]));
      expect(new Set(byId.values()).size).toBe(3);

      coins.setTransforms('gold', [0.6, 0, -3, 0.3, 0, -3], [...q, ...q], 2, [43, 42]);
      coins.update(lookingDownMinusZ(), 720);
      expect([seedOf(coins, 'near', 0), seedOf(coins, 'near', 1)]).toEqual([
        byId.get(43),
        byId.get(42),
      ]);

      coins.setTransforms('gold', [0, 0, -3, 0.3, 0, -3], [...q, ...q], 2, [99, 42]);
      coins.update(lookingDownMinusZ(), 720);
      expect(seedOf(coins, 'near', 0)).not.toBe(byId.get(43));
      expect(seedOf(coins, 'near', 1)).toBe(byId.get(42));
    });

    it('keeps each coin its LOD level inside the hysteresis band when slots shuffle', () => {
      const lod = { nearPixelRadius: 40, hysteresis: 0.2 };
      const coins = field({ capacity: 2, radius: 1, lod });
      const camera = lookingDownMinusZ();
      const height = 720;
      const ppu = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      const distanceFor = (px: number): number => (1.01 * ppu) / px;
      const close = -distanceFor(lod.nearPixelRadius * 1.5);
      const far = -distanceFor(lod.nearPixelRadius * 0.5);
      const band = -distanceFor(lod.nearPixelRadius);

      coins.setTransforms('gold', [0, 0, close, 0, 0, far], [...q, ...q], 2, [1, 2]);
      expect(coins.update(camera, height)).toMatchObject({ near: 1, far: 1 });

      // Both coins now sit inside the band: each must hold the level it already had, even
      // though the sim handed them over in swapped slots.
      coins.setTransforms('gold', [0.2, 0, band, -0.2, 0, band], [...q, ...q], 2, [2, 1]);
      coins.update(camera, height);
      const near = coins.mesh('gold', 'near');
      const farMesh = coins.mesh('gold', 'far');
      expect(near.count).toBe(1);
      expect(farMesh.count).toBe(1);
      const position = new Vector3();
      const matrix = new Matrix4();
      near.getMatrixAt(0, matrix);
      expect(position.setFromMatrixPosition(matrix).x).toBeCloseTo(-0.2, 5);
      farMesh.getMatrixAt(0, matrix);
      expect(position.setFromMatrixPosition(matrix).x).toBeCloseTo(0.2, 5);
    });

    it("gives a new coin in a reused slot a fresh LOD decision, not the old occupant's", () => {
      const lod = { nearPixelRadius: 40, hysteresis: 0.2 };
      const coins = field({ capacity: 1, radius: 1, lod });
      const camera = lookingDownMinusZ();
      const height = 720;
      const ppu = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      const at = (px: number): number => -(1.01 * ppu) / px;

      coins.setTransforms('gold', [0, 0, at(lod.nearPixelRadius * 2)], q, 1, [5]);
      expect(coins.update(camera, height).near).toBe(1);

      coins.setTransforms('gold', [0, 0, at(lod.nearPixelRadius * 0.9)], q, 1, [6]);
      expect(coins.update(camera, height)).toMatchObject({ near: 0, far: 1 });

      coins.setTransforms('gold', [0, 0, at(lod.nearPixelRadius * 0.9)], q, 1, [6]);
      coins.setTransforms('gold', [0, 0, at(lod.nearPixelRadius * 1.1)], q, 1, [6]);
      expect(coins.update(camera, height)).toMatchObject({ near: 0, far: 1 });
    });
  });

  it('reuses its stats object instead of allocating one per frame', () => {
    const coins = field({ capacity: 2 });
    const first = coins.update(lookingDownMinusZ(), 720);
    coins.setTransforms('gold', [0, 0, -3], [0, 0, 0, 1], 1, [1]);
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
    coins.setTransforms('gold', [0, 0, -3, 0, 0, 10], [...q, ...q], 2, [1, 2]);
    coins.setTransforms('copper', [0, 0, -400], q, 1, [1]);
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
    expect(coins.object.children).toHaveLength(COIN_TIER_IDS.length * 2 + 1);
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
      const ids: number[] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          positions.push(-4.5 + (col + 0.5) * 0.5, 0.045, -9.2 + (row + 0.5) * 0.5);
          quaternions.push(0, 0, 0, 1);
          ids.push(row * columns + col);
        }
      }
      coins.setTransforms('copper', positions, quaternions, columns * rows, ids);
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
  });
});
