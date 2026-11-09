import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTexture, DataUtils, Scene, Texture } from 'three/webgpu';
import {
  ENVIRONMENT_HANDOFF,
  SUNSET_HDRI,
  decodeFallbackEnvironment,
  installVenueEnvironment,
  type EnvironmentLoader,
  type EnvironmentPrefilter,
  type VenueEnvironment,
} from './environment.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SUNSET_HDRI', () => {
  it('points at the pre-graded 512 px CC0 asset with its sun bearing inside one turn', () => {
    expect(SUNSET_HDRI.url).toMatch(/venice_sunset_512\.hdr/);
    expect(Math.abs(SUNSET_HDRI.sunYaw)).toBeLessThan(Math.PI);
  });

  it('inlines its fallback so boot needs no request', () => {
    expect(SUNSET_HDRI.fallback).toMatch(/^data:[^,]*;base64,/);
  });
});

describe('decodeFallbackEnvironment', () => {
  it('decodes the 32 px fallback with a full mip chain down to 1×1', () => {
    const fallback = decodeFallbackEnvironment(SUNSET_HDRI.fallback);
    expect(fallback.image.width).toBe(32);
    expect(fallback.image.height).toBe(16);
    expect(fallback.generateMipmaps).toBe(false);
    const sizes = (fallback.mipmaps as { width: number; height: number }[]).map((m) => [
      m.width,
      m.height,
    ]);
    expect(sizes).toEqual([
      [32, 16],
      [16, 8],
      [8, 4],
      [4, 2],
      [2, 1],
      [1, 1],
    ]);
    fallback.dispose();
  });

  it('keeps the sun where the full HDRI has it', () => {
    const fallback = decodeFallbackEnvironment(SUNSET_HDRI.fallback);
    const data = fallback.image.data as Uint16Array;
    let brightest = { column: -1, luminance: -1 };
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const i = (y * 32 + x) * 4;
        const luminance =
          DataUtils.fromHalfFloat(data[i] ?? 0) +
          DataUtils.fromHalfFloat(data[i + 1] ?? 0) +
          DataUtils.fromHalfFloat(data[i + 2] ?? 0);
        if (luminance > brightest.luminance) brightest = { column: x, luminance };
      }
    }
    const sunColumn = Math.floor((SUNSET_HDRI.sunYaw / (2 * Math.PI) + 0.5) * 32);
    expect(Math.abs(brightest.column - sunColumn)).toBeLessThanOrEqual(1);
    fallback.dispose();
  });

  it('rejects a fallback that was bundled as a URL instead of inlined', () => {
    expect(() => decodeFallbackEnvironment('/assets/venice_sunset_32.hdr')).toThrow(/data URL/);
  });
});

function pendingLoader(width = 512) {
  const hdri = new DataTexture(new Uint8Array(width * (width / 2) * 4), width, width / 2);
  let settle: (texture: Texture) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const load = vi.fn<EnvironmentLoader>(
    () =>
      new Promise<Texture>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
  );
  return {
    hdri,
    load,
    resolve: () => {
      settle(hdri);
    },
    reject: (error: Error) => {
      fail(error);
    },
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function frames(environment: VenueEnvironment, count: number, dt: number) {
  for (let i = 0; i < count; i += 1) environment.advance(dt);
}

function install(
  scene: Scene,
  loader: ReturnType<typeof pendingLoader>,
  prefilter: EnvironmentPrefilter | 'renderer' = vi.fn<EnvironmentPrefilter>(),
) {
  return installVenueEnvironment(scene, {
    hdri: SUNSET_HDRI,
    sunYaw: 0,
    load: loader.load,
    ...(prefilter === 'renderer' ? {} : { prefilter }),
  });
}

describe('installVenueEnvironment', () => {
  it('lights the scene from the fallback before the HDRI loader settles', () => {
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    expect(loader.load).toHaveBeenCalledWith(SUNSET_HDRI);
    expect(scene.environmentNode).toBe(environment.node);
    expect(scene.environment).toBeNull();
    expect(scene.environmentRotation.y).toBeCloseTo(SUNSET_HDRI.sunYaw);
    expect(environment.blend).toBe(0);
    expect(environment.hdri).toBeNull();
    environment.dispose();
  });

  it('waits for the HDRI and the settle window, then crossfades and resolves hdri', async () => {
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    frames(environment, 120, 1 / 60);
    expect(environment.blend).toBe(0);

    loader.resolve();
    await flush();
    expect(environment.hdri).toBe(loader.hdri);
    environment.advance(1 / 60);
    expect(environment.blend).toBe(0);

    environment.advance(2.5);
    expect(environment.blend).toBeCloseTo(
      ENVIRONMENT_HANDOFF.maxFadeStep / ENVIRONMENT_HANDOFF.fadeSeconds,
    );

    frames(environment, Math.ceil(ENVIRONMENT_HANDOFF.fadeSeconds * 60) + 1, 1 / 60);
    expect(environment.blend).toBe(1);
    await expect(environment.ready).resolves.toBe('hdri');
    expect(scene.environmentNode).toBe(environment.node);
    environment.dispose();
  });

  it('pre-filters the HDRI once, into the 256 px PMREM texture the materials already bind', async () => {
    const scene = new Scene();
    const loader = pendingLoader();
    const prefilter = vi.fn<EnvironmentPrefilter>();
    const environment = install(scene, loader, prefilter);
    loader.resolve();
    await flush();
    frames(environment, ENVIRONMENT_HANDOFF.settleFrames + 60, 1 / 60);
    expect(prefilter).toHaveBeenCalledTimes(1);
    const [source, target] = prefilter.mock.calls[0] ?? [];
    expect(source).toBe(loader.hdri);
    expect(target?.texture.isPMREMTexture).toBe(true);
    expect(target?.width).toBe(256);
    expect(target?.texture.mipmaps.map((m: { width: number }) => m.width)).toEqual([
      256, 128, 64, 32, 16, 8,
    ]);
    frames(environment, 120, 1 / 60);
    expect(prefilter).toHaveBeenCalledTimes(1);
    environment.dispose();
  });

  it('fails loudly when no rendered frame has supplied a renderer to pre-filter with', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader, 'renderer');
    loader.resolve();
    await flush();
    frames(environment, ENVIRONMENT_HANDOFF.settleFrames + 60, 1 / 60);
    await expect(environment.ready).resolves.toBe('fallback');
    const call: unknown[] = logged.mock.calls[0] ?? [];
    const [message, error] = call;
    expect(message).toMatch(/could not be pre-filtered/);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/before a frame renders/);
    environment.dispose();
  });

  it('logs and stays on the fallback when the HDRI would pre-filter to another cube size', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scene = new Scene();
    const loader = pendingLoader(2048);
    const prefilter = vi.fn<EnvironmentPrefilter>();
    const environment = install(scene, loader, prefilter);
    loader.resolve();
    await flush();
    frames(environment, ENVIRONMENT_HANDOFF.settleFrames + 120, 1 / 60);
    expect(prefilter).not.toHaveBeenCalled();
    await expect(environment.ready).resolves.toBe('fallback');
    const call: unknown[] = logged.mock.calls[0] ?? [];
    const [message, error] = call;
    expect(message).toMatch(/could not be pre-filtered/);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/512 px cube/);
    expect(environment.blend).toBe(0);
    environment.dispose();
  });

  it('holds the fallback for the minimum frame count even when the time has passed', async () => {
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    loader.resolve();
    await flush();
    frames(environment, ENVIRONMENT_HANDOFF.settleFrames - 1, 1);
    expect(environment.hdri).toBe(loader.hdri);
    environment.advance(1 / 60);
    expect(environment.blend).toBe(0);
    environment.advance(1 / 60);
    expect(environment.blend).toBeGreaterThan(0);
    environment.dispose();
  });

  it('logs the failure loudly and stays on the fallback', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    const failure = new Error('404');
    loader.reject(failure);
    await expect(environment.ready).resolves.toBe('fallback');
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/HDRI did not load/), failure);
    frames(environment, 120, 1 / 60);
    expect(environment.blend).toBe(0);
    expect(scene.environmentNode).toBe(environment.node);
    environment.dispose();
  });

  it('disposes a texture that arrives after dispose and resolves fallback', async () => {
    const dispose = vi.spyOn(Texture.prototype, 'dispose');
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    environment.dispose();
    expect(scene.environmentNode).toBeNull();
    expect(dispose.mock.contexts).toContain(environment.fallback);
    await expect(environment.ready).resolves.toBe('fallback');
    loader.resolve();
    await flush();
    expect(dispose.mock.contexts).toContain(loader.hdri);
    expect(environment.hdri).toBeNull();
  });

  it('does not log a failure that lands after dispose', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    environment.dispose();
    loader.reject(new Error('aborted'));
    await flush();
    expect(logged).not.toHaveBeenCalled();
  });
});
