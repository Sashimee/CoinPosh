import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataUtils, Scene, Texture } from 'three/webgpu';
import {
  ENVIRONMENT_HANDOFF,
  SUNSET_HDRI,
  decodeFallbackEnvironment,
  installVenueEnvironment,
  type EnvironmentLoader,
  type EnvironmentUploader,
  type PrefilteredEnvironment,
  type VenueEnvironment,
} from './environment.ts';
import { PREFILTERED_ENVIRONMENT } from './prefilter.ts';

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

function prefiltered(width: number = PREFILTERED_ENVIRONMENT.width): PrefilteredEnvironment {
  const height = width / 2;
  return {
    width,
    height,
    levels: Array.from(
      { length: PREFILTERED_ENVIRONMENT.levels },
      (_, k) => new Uint16Array((width >> k) * (height >> k) * 4),
    ),
  };
}

function pendingLoader() {
  let settle: (result: PrefilteredEnvironment) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const load = vi.fn<EnvironmentLoader>(
    () =>
      new Promise<PrefilteredEnvironment>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
  );
  return {
    load,
    resolve: (result: PrefilteredEnvironment = prefiltered()) => {
      settle(result);
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

function uploader() {
  return { initTexture: vi.fn<EnvironmentUploader['initTexture']>() };
}

function frames(
  environment: VenueEnvironment,
  count: number,
  dt: number,
  renderer: EnvironmentUploader | null = null,
) {
  for (let i = 0; i < count; i += 1) environment.advance(dt, renderer);
}

function settle(environment: VenueEnvironment, renderer: EnvironmentUploader | null = null) {
  frames(environment, ENVIRONMENT_HANDOFF.settleFrames, 1 / 4, renderer);
}

function install(scene: Scene, loader: ReturnType<typeof pendingLoader>) {
  return installVenueEnvironment(scene, { hdri: SUNSET_HDRI, sunYaw: 0, load: loader.load });
}

describe('installVenueEnvironment', () => {
  it('lights the scene from the fallback and leaves the HDRI load out of construction', () => {
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    expect(loader.load).not.toHaveBeenCalled();
    expect(scene.environmentNode).toBe(environment.node);
    expect(scene.environment).toBeNull();
    expect(scene.environmentRotation.y).toBeCloseTo(SUNSET_HDRI.sunYaw);
    expect(environment.blend).toBe(0);
    environment.dispose();
  });

  it('allocates the HDRI texture at its final size with no texels to upload', () => {
    const environment = install(new Scene(), pendingLoader());
    const { hdri, fallback } = environment;
    expect(hdri.source.dataReady).toBe(false);
    expect(hdri.version).toBeGreaterThan(0);
    expect(hdri.generateMipmaps).toBe(false);
    expect(hdri.flipY).toBe(fallback.flipY);
    expect(hdri.type).toBe(fallback.type);
    expect(hdri.mapping).toBe(fallback.mapping);
    expect((hdri.mipmaps as { width: number }[]).map((m) => m.width)).toEqual([
      512, 256, 128, 64, 32, 16,
    ]);
    environment.dispose();
  });

  it('starts the load once, only after both the settle frames and the settle time', () => {
    const loader = pendingLoader();
    const environment = install(new Scene(), loader);
    frames(environment, ENVIRONMENT_HANDOFF.settleFrames - 1, 1);
    expect(loader.load).not.toHaveBeenCalled();
    environment.advance(1 / 60);
    expect(loader.load).toHaveBeenCalledExactlyOnceWith(SUNSET_HDRI);

    const fast = pendingLoader();
    const quick = install(new Scene(), fast);
    frames(quick, ENVIRONMENT_HANDOFF.settleFrames * 4, 1 / 1000);
    expect(fast.load).not.toHaveBeenCalled();
    frames(quick, Math.ceil(ENVIRONMENT_HANDOFF.settleSeconds * 60), 1 / 60);
    expect(fast.load).toHaveBeenCalledTimes(1);
    frames(quick, 120, 1 / 60);
    expect(fast.load).toHaveBeenCalledTimes(1);
    environment.dispose();
    quick.dispose();
  });

  it('uploads the delivered levels in place, then crossfades and resolves hdri', async () => {
    const scene = new Scene();
    const loader = pendingLoader();
    const renderer = uploader();
    const environment = install(scene, loader);
    const target = environment.hdri;
    settle(environment, renderer);
    frames(environment, 120, 1 / 60, renderer);
    expect(environment.blend).toBe(0);
    expect(renderer.initTexture).not.toHaveBeenCalled();

    const result = prefiltered();
    loader.resolve(result);
    await flush();
    const version = target.version;
    environment.advance(1 / 60, renderer);
    expect(renderer.initTexture).toHaveBeenCalledExactlyOnceWith(target);
    expect(environment.hdri).toBe(target);
    expect(target.source.dataReady).toBe(true);
    expect(target.version).toBeGreaterThan(version);
    expect(target.image.data).toBe(result.levels[0]);
    expect((target.mipmaps as { data: Uint16Array }[]).map((m) => m.data)).toEqual(result.levels);
    expect(environment.blend).toBe(0);

    environment.advance(2.5, renderer);
    expect(environment.blend).toBeCloseTo(
      ENVIRONMENT_HANDOFF.maxFadeStep / ENVIRONMENT_HANDOFF.fadeSeconds,
    );
    frames(environment, Math.ceil(ENVIRONMENT_HANDOFF.fadeSeconds * 60) + 1, 1 / 60, renderer);
    expect(environment.blend).toBe(1);
    await expect(environment.ready).resolves.toBe('hdri');
    expect(renderer.initTexture).toHaveBeenCalledTimes(1);
    expect(scene.environmentNode).toBe(environment.node);
    environment.dispose();
  });

  it('holds the delivered levels until a frame supplies a renderer to upload with', async () => {
    const loader = pendingLoader();
    const environment = install(new Scene(), loader);
    settle(environment);
    loader.resolve();
    await flush();
    frames(environment, 30, 1 / 60);
    expect(environment.blend).toBe(0);
    expect(environment.hdri.source.dataReady).toBe(false);
    const renderer = uploader();
    frames(environment, 2, 1 / 60, renderer);
    expect(renderer.initTexture).toHaveBeenCalledTimes(1);
    expect(environment.blend).toBeGreaterThan(0);
    environment.dispose();
  });

  it('logs and stays on the fallback when the levels do not fit the allocated texture', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loader = pendingLoader();
    const renderer = uploader();
    const environment = install(new Scene(), loader);
    settle(environment, renderer);
    loader.resolve(prefiltered(1024));
    await flush();
    frames(environment, 120, 1 / 60, renderer);
    expect(renderer.initTexture).not.toHaveBeenCalled();
    await expect(environment.ready).resolves.toBe('fallback');
    expect(logged).toHaveBeenCalledOnce();
    const [message, error] = logged.mock.calls[0] as unknown[];
    expect(message).toMatch(/could not be uploaded/);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/1024×512 with 6 levels, not 512×256/);
    expect(environment.blend).toBe(0);
    expect(environment.hdri.source.dataReady).toBe(false);
    environment.dispose();
  });

  it('rejects a level with the wrong number of texels', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loader = pendingLoader();
    const environment = install(new Scene(), loader);
    settle(environment);
    const result = prefiltered();
    loader.resolve({ ...result, levels: [...result.levels.slice(0, 5), new Uint16Array(4)] });
    await flush();
    frames(environment, 2, 1 / 60, uploader());
    await expect(environment.ready).resolves.toBe('fallback');
    expect((logged.mock.calls[0]?.[1] as Error).message).toMatch(/level 5 has 4 values/);
    environment.dispose();
  });

  it('logs the failure loudly and stays on the fallback', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scene = new Scene();
    const loader = pendingLoader();
    const environment = install(scene, loader);
    settle(environment);
    const failure = new Error('404');
    loader.reject(failure);
    await expect(environment.ready).resolves.toBe('fallback');
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/HDRI did not load/), failure);
    frames(environment, 120, 1 / 60, uploader());
    expect(environment.blend).toBe(0);
    expect(scene.environmentNode).toBe(environment.node);
    environment.dispose();
  });

  it('treats a loader that throws synchronously as a failed load', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('Worker is not defined');
    const environment = installVenueEnvironment(new Scene(), {
      hdri: SUNSET_HDRI,
      sunYaw: 0,
      load: () => {
        throw failure;
      },
    });
    settle(environment);
    await expect(environment.ready).resolves.toBe('fallback');
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/HDRI did not load/), failure);
    environment.dispose();
  });

  it('drops levels that arrive after dispose and resolves fallback', async () => {
    const dispose = vi.spyOn(Texture.prototype, 'dispose');
    const scene = new Scene();
    const loader = pendingLoader();
    const renderer = uploader();
    const environment = install(scene, loader);
    settle(environment, renderer);
    environment.dispose();
    expect(scene.environmentNode).toBeNull();
    expect(dispose.mock.contexts).toContain(environment.fallback);
    expect(dispose.mock.contexts).toContain(environment.hdri);
    await expect(environment.ready).resolves.toBe('fallback');
    loader.resolve();
    await flush();
    frames(environment, 10, 1 / 60, renderer);
    expect(renderer.initTexture).not.toHaveBeenCalled();
  });

  it('does not log a failure that lands after dispose', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loader = pendingLoader();
    const environment = install(new Scene(), loader);
    settle(environment);
    environment.dispose();
    loader.reject(new Error('aborted'));
    await flush();
    expect(logged).not.toHaveBeenCalled();
  });
});
