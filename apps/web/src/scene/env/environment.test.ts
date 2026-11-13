import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataUtils, Scene, Texture, type DataTexture } from 'three/webgpu';
import {
  ENVIRONMENT_HANDOFF,
  FALLBACK_LEVEL,
  SUNSET_HDRI,
  createEnvironmentTexture,
  installVenueEnvironment,
  prefilterHdriInWorker,
  type EnvironmentLoader,
  type EnvironmentUploader,
  type PrefilteredEnvironment,
  type VenueEnvironment,
} from './environment.ts';
import { encodeRadiance } from './hdri/bake.ts';
import { PREFILTERED_ENVIRONMENT, type PrefilterReply } from './prefilter.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

interface Level {
  data: Uint16Array;
  width: number;
  height: number;
}

function levelOf(map: DataTexture, k: number): Level {
  const level = (map.mipmaps as Level[])[k];
  if (!level) throw new Error(`The environment texture has no level ${String(k)}`);
  return level;
}

function luminanceAt(level: Level, x: number, y: number): number {
  const i = (y * level.width + x) * 4;
  return (
    DataUtils.fromHalfFloat(level.data[i] ?? 0) +
    DataUtils.fromHalfFloat(level.data[i + 1] ?? 0) +
    DataUtils.fromHalfFloat(level.data[i + 2] ?? 0)
  );
}

function meanLuminance(level: Level): number {
  let sum = 0;
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) sum += luminanceAt(level, x, y);
  }
  return sum / (level.width * level.height);
}

function brightestColumn(level: Level): number {
  let brightest = { column: -1, luminance: -1 };
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const luminance = luminanceAt(level, x, y);
      if (luminance > brightest.luminance) brightest = { column: x, luminance };
    }
  }
  return brightest.column;
}

function radianceDataUrl(width: number, height: number): string {
  const file = encodeRadiance({ width, height, data: new Float32Array(width * height * 4) });
  return `data:image/vnd.radiance;base64,${Buffer.from(file).toString('base64')}`;
}

describe('createEnvironmentTexture', () => {
  it('allocates the pre-filtered HDRI size and levels from the first frame', () => {
    const map = createEnvironmentTexture(SUNSET_HDRI.fallback);
    expect(map.image.width).toBe(PREFILTERED_ENVIRONMENT.width);
    expect(map.image.height).toBe(PREFILTERED_ENVIRONMENT.height);
    expect(map.generateMipmaps).toBe(false);
    expect(map.source.dataReady).toBe(true);
    const sizes = (map.mipmaps as Level[]).map((m) => [m.width, m.height, m.data.length]);
    expect(sizes).toEqual([
      [512, 256, 512 * 256 * 4],
      [256, 128, 256 * 128 * 4],
      [128, 64, 128 * 64 * 4],
      [64, 32, 64 * 32 * 4],
      [32, 16, 32 * 16 * 4],
      [16, 8, 16 * 8 * 4],
    ]);
    map.dispose();
  });

  it('holds the 32 px fallback at its level and its blur in the next, zeros above', () => {
    const map = createEnvironmentTexture(SUNSET_HDRI.fallback);
    const levels = map.mipmaps as Level[];
    expect(FALLBACK_LEVEL).toBe(4);
    levels.slice(0, FALLBACK_LEVEL).forEach((level) => {
      expect(level.data.every((v) => v === 0)).toBe(true);
    });
    const fallback = levelOf(map, FALLBACK_LEVEL);
    const blur = levelOf(map, FALLBACK_LEVEL + 1);
    expect(meanLuminance(fallback)).toBeGreaterThan(0);
    expect(meanLuminance(blur)).toBeCloseTo(meanLuminance(fallback), 1);
    let fallbackPeak = 0;
    let blurPeak = 0;
    for (let y = 0; y < 16; y += 1)
      for (let x = 0; x < 32; x += 1)
        fallbackPeak = Math.max(fallbackPeak, luminanceAt(fallback, x, y));
    for (let y = 0; y < 8; y += 1)
      for (let x = 0; x < 16; x += 1) blurPeak = Math.max(blurPeak, luminanceAt(blur, x, y));
    expect(blurPeak).toBeLessThan(fallbackPeak);
    map.dispose();
  });

  it('keeps the sun where the full HDRI has it, sharp and blurred', () => {
    const map = createEnvironmentTexture(SUNSET_HDRI.fallback);
    const turn = SUNSET_HDRI.sunYaw / (2 * Math.PI) + 0.5;
    expect(
      Math.abs(brightestColumn(levelOf(map, FALLBACK_LEVEL)) - Math.floor(turn * 32)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(brightestColumn(levelOf(map, FALLBACK_LEVEL + 1)) - Math.floor(turn * 16)),
    ).toBeLessThanOrEqual(1);
    map.dispose();
  });

  it('rejects a fallback that was bundled as a URL instead of inlined', () => {
    expect(() => createEnvironmentTexture('/assets/venice_sunset_32.hdr')).toThrow(/data URL/);
  });

  it('rejects a fallback that does not fit the fallback level', () => {
    expect(() => createEnvironmentTexture(radianceDataUrl(64, 32))).toThrow(
      /fallback is 64×32, not 32×16/,
    );
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

const SETTLE_FRAMES = Math.max(
  ENVIRONMENT_HANDOFF.settleFrames,
  Math.ceil(ENVIRONMENT_HANDOFF.settleSeconds / ENVIRONMENT_HANDOFF.maxFadeStep) + 1,
);

function settle(environment: VenueEnvironment, renderer: EnvironmentUploader | null = null) {
  frames(environment, SETTLE_FRAMES, ENVIRONMENT_HANDOFF.maxFadeStep, renderer);
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
    expect(environment.source).toBe('fallback');
    expect(environment.blend).toBe(0);
    expect(environment.map.name).toBe('venue-environment');
    expect((environment.map.mipmaps as Level[]).map((m) => m.width)).toEqual([
      512, 256, 128, 64, 32, 16,
    ]);
    environment.dispose();
  });

  it('starts the load once, only after both the settle frames and the settle time', () => {
    const loader = pendingLoader();
    const environment = install(new Scene(), loader);
    frames(environment, ENVIRONMENT_HANDOFF.settleFrames - 1, 1);
    expect(loader.load).not.toHaveBeenCalled();
    settle(environment);
    expect(loader.load).toHaveBeenCalledOnce();
    const [hdri, signal] = loader.load.mock.calls[0] ?? [];
    expect(hdri).toBe(SUNSET_HDRI);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    const fast = pendingLoader();
    const quick = install(new Scene(), fast);
    frames(quick, ENVIRONMENT_HANDOFF.settleFrames * 4, 1 / 1000);
    expect(fast.load).not.toHaveBeenCalled();
    frames(quick, Math.ceil(ENVIRONMENT_HANDOFF.settleSeconds * 60) + 1, 1 / 60);
    expect(fast.load).toHaveBeenCalledTimes(1);
    frames(quick, 120, 1 / 60);
    expect(fast.load).toHaveBeenCalledTimes(1);
    environment.dispose();
    quick.dispose();
  });

  it('does not count boot stalls toward the settle time', () => {
    const loader = pendingLoader();
    const environment = install(new Scene(), loader);
    frames(environment, ENVIRONMENT_HANDOFF.settleFrames * 2, 1.5);
    expect(loader.load).not.toHaveBeenCalled();
    const counted = ENVIRONMENT_HANDOFF.settleFrames * 2 * ENVIRONMENT_HANDOFF.maxFadeStep;
    const remaining = Math.ceil(
      (ENVIRONMENT_HANDOFF.settleSeconds - counted) / ENVIRONMENT_HANDOFF.maxFadeStep,
    );
    frames(environment, remaining - 2, ENVIRONMENT_HANDOFF.maxFadeStep);
    expect(loader.load).not.toHaveBeenCalled();
    frames(environment, 3, ENVIRONMENT_HANDOFF.maxFadeStep);
    expect(loader.load).toHaveBeenCalledOnce();
    environment.dispose();
  });

  it('uploads the delivered levels into the same texture, then pulls focus and resolves hdri', async () => {
    const scene = new Scene();
    const loader = pendingLoader();
    const renderer = uploader();
    const environment = install(scene, loader);
    const target = environment.map;
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
    expect(environment.map).toBe(target);
    expect(environment.source).toBe('hdri');
    expect(target.version).toBeGreaterThan(version);
    expect(target.image.data).toBe(result.levels[0]);
    const uploaded = (target.mipmaps as Level[]).map((m) => m.data);
    expect(uploaded).toHaveLength(result.levels.length);
    uploaded.forEach((data, k) => {
      expect(data).toBe(result.levels[k]);
    });
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
    const boot = environment.map.image.data;
    settle(environment);
    loader.resolve();
    await flush();
    frames(environment, 30, 1 / 60);
    expect(environment.blend).toBe(0);
    expect(environment.source).toBe('fallback');
    expect(environment.map.image.data).toBe(boot);
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
    const boot = environment.map.mipmaps;
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
    expect(environment.source).toBe('fallback');
    expect(environment.map.mipmaps).toBe(boot);
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

  it('aborts the in-flight load on dispose and drops levels that arrive after it', async () => {
    const dispose = vi.spyOn(Texture.prototype, 'dispose');
    const scene = new Scene();
    const loader = pendingLoader();
    const renderer = uploader();
    const environment = install(scene, loader);
    settle(environment, renderer);
    const signal = loader.load.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    environment.dispose();
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe('AbortError');
    expect(scene.environmentNode).toBeNull();
    expect(dispose.mock.contexts).toContain(environment.map);
    await expect(environment.ready).resolves.toBe('fallback');
    loader.resolve();
    await flush();
    frames(environment, 10, 1 / 60, renderer);
    expect(renderer.initTexture).not.toHaveBeenCalled();
  });

  it('does not log the abort that its own dispose causes', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const environment = installVenueEnvironment(new Scene(), {
      hdri: SUNSET_HDRI,
      sunYaw: 0,
      load: prefilterHdriInWorker,
    });
    const workers = stubWorkers();
    settle(environment);
    expect(workers).toHaveLength(1);
    environment.dispose();
    await flush();
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
    expect(logged).not.toHaveBeenCalled();
  });
});

class FakeWorker extends EventTarget {
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    super();
  }

  reply(data: PrefilterReply) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function stubWorkers(): FakeWorker[] {
  const workers: FakeWorker[] = [];
  vi.stubGlobal('document', { baseURI: 'https://coinposh.test/game/' });
  vi.stubGlobal(
    'Worker',
    class extends FakeWorker {
      constructor(url: URL, options: WorkerOptions) {
        super(url, options);
        workers.push(this);
      }
    },
  );
  return workers;
}

describe('prefilterHdriInWorker', () => {
  it('resolves the worker reply and terminates the worker', async () => {
    const workers = stubWorkers();
    const pending = prefilterHdriInWorker(SUNSET_HDRI, new AbortController().signal);
    const worker = workers[0];
    expect(worker?.options.type).toBe('module');
    expect(worker?.postMessage).toHaveBeenCalledExactlyOnceWith({
      url: new URL(SUNSET_HDRI.url, 'https://coinposh.test/game/').href,
    });
    const result = prefiltered();
    worker?.reply({ ok: true, ...result, levels: [...result.levels] });
    await expect(pending).resolves.toMatchObject({ width: 512, height: 256 });
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });

  it('rejects with the worker message when the pre-filter fails', async () => {
    const workers = stubWorkers();
    const pending = prefilterHdriInWorker(SUNSET_HDRI, new AbortController().signal);
    workers[0]?.reply({ ok: false, message: 'HTTP 404' });
    await expect(pending).rejects.toThrow(/environment worker failed: HTTP 404/);
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('rejects and terminates when the worker chunk does not start', async () => {
    const workers = stubWorkers();
    const pending = prefilterHdriInWorker(SUNSET_HDRI, new AbortController().signal);
    workers[0]?.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow(/did not start \(error\)/);
    expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('rejects and terminates when the worker reply cannot be deserialized', async () => {
    const workers = stubWorkers();
    const pending = prefilterHdriInWorker(SUNSET_HDRI, new AbortController().signal);
    const worker = workers[0];
    worker?.dispatchEvent(new MessageEvent('messageerror'));
    await expect(pending).rejects.toThrow(/reply could not be deserialized/);
    expect(worker?.terminate).toHaveBeenCalledOnce();
    worker?.reply({ ok: false, message: 'late' });
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the worker mid-filter when the signal aborts, and ignores a late reply', async () => {
    const workers = stubWorkers();
    const controller = new AbortController();
    const pending = prefilterHdriInWorker(SUNSET_HDRI, controller.signal);
    const worker = workers[0];
    expect(worker?.terminate).not.toHaveBeenCalled();
    const reason = new DOMException('disposed', 'AbortError');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(worker?.terminate).toHaveBeenCalledOnce();
    worker?.reply({ ok: false, message: 'late' });
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });

  it('rejects with an AbortError when the abort reason is not an Error', async () => {
    stubWorkers();
    const controller = new AbortController();
    const pending = prefilterHdriInWorker(SUNSET_HDRI, controller.signal);
    controller.abort('gone');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('starts no worker for a signal that is already aborted', async () => {
    const workers = stubWorkers();
    const controller = new AbortController();
    controller.abort(new DOMException('disposed', 'AbortError'));
    await expect(prefilterHdriInWorker(SUNSET_HDRI, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(workers).toHaveLength(0);
  });
});
