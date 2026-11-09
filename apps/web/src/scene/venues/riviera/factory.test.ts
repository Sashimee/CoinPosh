import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgXToneMapping,
  BufferGeometry,
  DataTexture,
  HalfFloatType,
  Material,
  Mesh,
  type MeshPhysicalNodeMaterial,
  LinearSRGBColorSpace,
  NoToneMapping,
  PCFShadowMap,
  Scene,
  SRGBColorSpace,
  Texture,
  type Object3D,
} from 'three/webgpu';
import { texture } from 'three/tsl';
import {
  ENVIRONMENT_HANDOFF,
  type HdriAsset,
  type PrefilteredEnvironment,
} from '../../env/environment.ts';
import { PREFILTERED_ENVIRONMENT } from '../../env/prefilter.ts';
import type { LookRenderer } from '../../post/look.ts';
import {
  createRivieraVenue,
  RIVIERA_RENDER_LOOK,
  type RivieraVenue,
  type RivieraVenueOptions,
} from './index.ts';

function fakeRenderer(): LookRenderer {
  return {
    toneMapping: NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: LinearSRGBColorSpace,
    shadowMap: { enabled: false, type: null },
  };
}

function fakeEnvironment() {
  const { width, height, levels } = PREFILTERED_ENVIRONMENT;
  const result: PrefilteredEnvironment = {
    width,
    height,
    levels: Array.from(
      { length: levels },
      (_, k) => new Uint16Array((width >> k) * (height >> k) * 4),
    ),
  };
  const calls: HdriAsset[] = [];
  let settle: (loaded: PrefilteredEnvironment) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const load = vi.fn((hdri: HdriAsset) => {
    calls.push(hdri);
    return new Promise<PrefilteredEnvironment>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
  });
  return {
    result,
    calls,
    load,
    resolve: () => {
      settle(result);
    },
    reject: (error: Error) => {
      fail(error);
    },
  };
}

const uploader = () => ({ initTexture: vi.fn() });

/** Steps the environment past its settle window, which is when it starts loading. */
function settleEnvironment(venue: RivieraVenue, renderer = uploader()) {
  for (let i = 0; i < ENVIRONMENT_HANDOFF.settleFrames; i += 1) {
    venue.environment.advance(ENVIRONMENT_HANDOFF.settleSeconds, renderer);
  }
  return renderer;
}

async function build(options: RivieraVenueOptions = {}, renderer: LookRenderer | null = null) {
  const scene = new Scene();
  const environment = fakeEnvironment();
  const venue = await createRivieraVenue(scene, renderer, {
    reducedMotion: false,
    loadEnvironment: environment.load,
    ...options,
  });
  const backdrop = venue.root.getObjectByName('riviera-backdrop');
  if (!backdrop) throw new Error('Riviera venue has no backdrop group');
  return { scene, renderer, environment, venue, backdrop };
}

function expectBackdropFollows(
  backdrop: Object3D,
  pose: { roll: number; pitch: number; heave: number },
) {
  expect(backdrop.rotation.x).toBeCloseTo(-pose.pitch, 12);
  expect(backdrop.rotation.y).toBe(0);
  expect(backdrop.rotation.z).toBeCloseTo(-pose.roll, 12);
  expect(backdrop.position.y).toBeCloseTo(-pose.heave, 12);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRivieraVenue', () => {
  it('installs its environment, adds the root and leaves the grade to the post pipeline', async () => {
    const { scene, environment, venue } = await build({ shadows: true });
    expect(venue.look).toEqual({ exposure: 0.85, environmentIntensity: 0.32, shadows: true });
    expect(scene.environmentIntensity).toBe(1);
    expect(environment.load).not.toHaveBeenCalled();
    expect(scene.environmentNode?.name).toBe('venue-environment');
    expect(venue.environment.node).toBe(scene.environmentNode);
    expect(venue.environment.hdri.type).toBe(HalfFloatType);
    expect(scene.children).toContain(venue.root);
    expect(venue.quality).toBe('high');
    venue.dispose();
  });

  it('starts loading the bundled HDRI only once play has settled, then hands off to it', async () => {
    const { environment, venue } = await build();
    const renderer = settleEnvironment(venue);
    expect(environment.load).toHaveBeenCalledTimes(1);
    expect(environment.calls[0]?.url).toMatch(/venice_sunset_512\.hdr/);
    environment.resolve();
    await Promise.resolve();
    for (let i = 0; i < 60; i += 1) venue.environment.advance(1 / 60, renderer);
    expect(renderer.initTexture).toHaveBeenCalledExactlyOnceWith(venue.environment.hdri);
    await expect(venue.environmentReady).resolves.toBe('hdri');
    venue.dispose();
  });

  it('resolves playable before the HDRI loader settles, lit by the inlined fallback', async () => {
    const scene = new Scene();
    const environment = fakeEnvironment();
    let venueReady = false;
    const created = createRivieraVenue(scene, null, {
      reducedMotion: false,
      loadEnvironment: environment.load,
    }).then((venue) => {
      venueReady = true;
      return venue;
    });
    const venue = await created;
    expect(venueReady).toBe(true);
    expect(environment.load).not.toHaveBeenCalled();
    expect(scene.children).toContain(venue.root);
    expect(scene.environmentNode?.name).toBe('venue-environment');
    settleEnvironment(venue);
    let environmentSettled = false;
    void venue.environmentReady.then(() => {
      environmentSettled = true;
    });
    await Promise.resolve();
    expect(environmentSettled).toBe(false);
    environment.resolve();
    venue.dispose();
    await expect(venue.environmentReady).resolves.toBe('fallback');
  });

  it('applies its look to a renderer it is handed, for harnesses without the post pipeline', async () => {
    const renderer = fakeRenderer();
    const { scene, venue } = await build({}, renderer);
    expect(renderer.toneMapping).toBe(AgXToneMapping);
    expect(renderer.toneMappingExposure).toBe(RIVIERA_RENDER_LOOK.exposure);
    expect(renderer.outputColorSpace).toBe(SRGBColorSpace);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(PCFShadowMap);
    expect(scene.environmentIntensity).toBe(RIVIERA_RENDER_LOOK.environmentIntensity);
    venue.dispose();
  });

  it('builds a shadowless look and venue when shadows are off', async () => {
    const renderer = fakeRenderer();
    const { venue } = await build({ shadows: false }, renderer);
    expect(venue.look.shadows).toBe(false);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(venue.lighting.key.castShadow).toBe(false);
    venue.dispose();
  });

  it('clamps the frame delta to [0, 0.25] s and treats non-finite deltas as zero', async () => {
    const { venue } = await build();
    venue.update(-1);
    expect(venue.waveTime).toBe(0);
    venue.update(10);
    expect(venue.waveTime).toBeCloseTo(0.25, 12);
    venue.update(Number.NaN);
    venue.update(Number.POSITIVE_INFINITY);
    expect(venue.waveTime).toBeCloseTo(0.25, 12);
    venue.update(0.1);
    expect(venue.waveTime).toBeCloseTo(0.35, 12);
    venue.dispose();
  });

  it('slows the sea to 0.3× and freezes the deck under reduced motion', async () => {
    const { venue, backdrop } = await build({ reducedMotion: true });
    for (let i = 0; i < 20; i += 1) {
      const pose = venue.update(0.1);
      expect(pose).toEqual({ roll: 0, pitch: 0, heave: 0 });
    }
    expect(venue.waveTime).toBeCloseTo(0.6, 9);
    expectBackdropFollows(backdrop, { roll: 0, pitch: 0, heave: 0 });
    venue.dispose();
  });

  it('counter-moves the sky and sea against the deck pose so the horizon rolls', async () => {
    const { venue, backdrop } = await build();
    let moved = false;
    for (let i = 0; i < 40; i += 1) {
      const pose = venue.update(0.1);
      expectBackdropFollows(backdrop, pose);
      if (
        Math.abs(pose.roll) > 1e-4 &&
        Math.abs(pose.pitch) > 1e-4 &&
        Math.abs(pose.heave) > 1e-4
      ) {
        moved = true;
      }
    }
    expect(moved).toBe(true);
    expect(venue.waveTime).toBeCloseTo(4, 9);
    venue.dispose();
  });

  it('toggles reduced motion at runtime', async () => {
    const { venue, backdrop } = await build();
    venue.update(1);
    venue.setReducedMotion(true);
    expect(venue.sway.intensity).toBe(0);
    const before = venue.waveTime;
    expect(venue.update(0.2)).toEqual({ roll: 0, pitch: 0, heave: 0 });
    expect(venue.waveTime - before).toBeCloseTo(0.06, 12);
    expectBackdropFollows(backdrop, { roll: 0, pitch: 0, heave: 0 });
    venue.setReducedMotion(false);
    expect(venue.sway.intensity).toBe(1);
    const after = venue.waveTime;
    venue.update(0.2);
    expect(venue.waveTime - after).toBeCloseTo(0.2, 12);
    venue.dispose();
  });

  it('dispose removes the root, clears its environment and frees the GPU resources', async () => {
    const materialDispose = vi.spyOn(Material.prototype, 'dispose');
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const textureDispose = vi.spyOn(Texture.prototype, 'dispose');
    const { scene, environment, venue } = await build();
    const renderer = settleEnvironment(venue);
    venue.dispose();
    expect(scene.children).not.toContain(venue.root);
    expect(scene.environmentNode).toBeNull();
    expect(materialDispose).toHaveBeenCalled();
    expect(geometryDispose).toHaveBeenCalled();
    expect(
      textureDispose.mock.contexts.some((t) => (t as Texture).name === 'venue-hdri-fallback'),
    ).toBe(true);
    expect(textureDispose.mock.contexts).toContain(venue.environment.hdri);
    environment.resolve();
    await venue.environmentReady;
    await Promise.resolve();
    venue.environment.advance(1 / 60, renderer);
    expect(renderer.initTexture).not.toHaveBeenCalled();
    expect(textureDispose.mock.contexts.some((t) => (t as Texture).name === 'baked-noise')).toBe(
      true,
    );
  });

  it('leaves a scene environment node it did not set in place on dispose', async () => {
    const { scene, venue } = await build();
    const other = texture(new DataTexture(new Uint8Array(4), 1, 1)).rgb;
    scene.environmentNode = other;
    venue.dispose();
    expect(scene.environmentNode).toBe(other);
  });

  it('keeps playing on the fallback and logs loudly when the HDRI fails to load', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { scene, environment, venue } = await build();
    settleEnvironment(venue);
    const failure = new Error('HDRI 404');
    environment.reject(failure);
    await expect(venue.environmentReady).resolves.toBe('fallback');
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/HDRI did not load/), failure);
    expect(scene.children).toContain(venue.root);
    expect(scene.environmentNode?.name).toBe('venue-environment');
    venue.dispose();
  });

  it('drops the deck clearcoat on the low tier and keeps it on high', async () => {
    for (const [quality, clearcoat] of [
      ['low', 0],
      ['high', 0.12],
    ] as const) {
      const { venue } = await build({ quality });
      const deck = venue.root.getObjectByName('deck-teak');
      if (!(deck instanceof Mesh)) throw new Error('Riviera venue has no deck-teak mesh');
      expect(venue.quality).toBe(quality);
      expect((deck.material as MeshPhysicalNodeMaterial).clearcoat).toBeCloseTo(clearcoat, 6);
      venue.dispose();
    }
  });

  it('drops the marble clearcoat and the felt sheen on the low tier', async () => {
    const materialOf = (venue: RivieraVenue, name: string): MeshPhysicalNodeMaterial => {
      const mesh = venue.root.getObjectByName(name);
      if (!(mesh instanceof Mesh)) throw new Error(`Riviera venue has no ${name} mesh`);
      return mesh.material as MeshPhysicalNodeMaterial;
    };
    for (const [quality, clearcoat, sheen] of [
      ['low', 0, 0],
      ['high', 0.5, 0.35],
    ] as const) {
      const { venue } = await build({ quality });
      expect(materialOf(venue, 'table-marble').clearcoat).toBeCloseTo(clearcoat, 6);
      expect(materialOf(venue, 'pusher-marble').clearcoat).toBeCloseTo(clearcoat, 6);
      const felt = materialOf(venue, 'table-floor');
      expect(felt.sheen).toBeCloseTo(sheen, 6);
      expect(felt.sheenNode === null).toBe(quality === 'low');
      venue.dispose();
    }
  });
});
