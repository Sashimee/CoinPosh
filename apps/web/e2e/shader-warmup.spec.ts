import type { Page } from '@playwright/test';
import { QUALITY_STORAGE_KEY, type StoredQuality } from '../src/scene/quality/storage.ts';
import { bootGame, expect, probe, tapDrop, test } from './fixtures.ts';

/**
 * P-580: the effects' programs link in a warmup frame at boot and again after a tier change or
 * a renderer rebuild, so no fusion, OBSCENE or crate burst stalls the main thread on a link.
 * Since P-628 the boot warmup is the frame after play starts: the first fusion needs coins in
 * contact and a fall, so it always comes later, and the test checks that it does.
 *
 * An init script counts every WebGL2 `linkProgram` with its fragment shader, and each effect is
 * told apart by constants only its material compiles to (src/vfx/flash.ts, shockwave.ts and
 * particles/material.ts). The first test also requires every effect to have linked by that frame,
 * so a fingerprint that stops matching fails here instead of passing silently.
 */

const VFX_FINGERPRINTS = {
  flash: ['* -42.0 )', '* -60.0 )'],
  shockwave: ['smoothstep( 0.94, 1.0,', '* 0.22 )'],
  sparks: ['vec3( 1.0, 0.5, 0.3 )'],
  foil: ['smoothstep( 0.86, 1.0,'],
} as const;

type VfxProgram = keyof typeof VFX_FINGERPRINTS;
const VFX_PROGRAMS = Object.keys(VFX_FINGERPRINTS) as VfxProgram[];

const TAPS = 60;
/** About a thumb's pace, and long enough for each drop to land on a SwiftShader frame. */
const TAP_SPACING_MS = 250;
/** Long enough for the last tap's fusion and its effects to draw. */
const EFFECTS_SETTLE_MS = 1500;
const WARMED_MARK = 'coinposh:vfx:warmed';
const PLAYABLE_MARK = 'coinposh:boot:playable';

interface LinkRecord {
  readonly at: number;
  readonly fragment: string;
}

interface MultisampleRecord {
  readonly at: number;
  readonly samples: number;
}

interface GlLog {
  readonly links: LinkRecord[];
  readonly multisample: MultisampleRecord[];
  /** The sim's fusion count as each warmed mark was taken, or null before the probe exists. */
  readonly fusionsAtWarm: (number | null)[];
}

declare global {
  interface Window {
    __coinposhGl?: GlLog;
  }
}

async function recordGl(page: Page): Promise<void> {
  await page.addInitScript((warmedMark) => {
    const log: GlLog = { links: [], multisample: [], fusionsAtWarm: [] };
    window.__coinposhGl = log;
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntriesByName(warmedMark, 'mark')) {
        if (entry.entryType === 'mark') {
          log.fusionsAtWarm.push(window.__coinposh?.counts.simFusions ?? null);
        }
      }
    }).observe({ type: 'mark' });
    const gl = WebGL2RenderingContext.prototype;
    const fragments = new WeakMap<WebGLProgram, string>();
    const isFragment = new WeakSet<WebGLShader>();
    const sources = new WeakMap<WebGLShader, string>();
    // A copy taken before the patches below, so each wrapper calls the browser's own method.
    const original = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(gl),
    ) as WebGL2RenderingContext;
    gl.createShader = function (type) {
      const shader = original.createShader.call(this, type);
      if (shader && type === this.FRAGMENT_SHADER) isFragment.add(shader);
      return shader;
    };
    gl.shaderSource = function (shader, source) {
      sources.set(shader, source);
      original.shaderSource.call(this, shader, source);
    };
    gl.attachShader = function (program, shader) {
      if (isFragment.has(shader)) fragments.set(program, sources.get(shader) ?? '');
      original.attachShader.call(this, program, shader);
    };
    gl.linkProgram = function (program) {
      log.links.push({ at: performance.now(), fragment: fragments.get(program) ?? '' });
      original.linkProgram.call(this, program);
    };
    gl.renderbufferStorageMultisample = function (target, samples, format, width, height) {
      log.multisample.push({ at: performance.now(), samples });
      original.renderbufferStorageMultisample.call(this, target, samples, format, width, height);
    };
  }, WARMED_MARK);
}

function glLog(page: Page): Promise<GlLog> {
  return page.evaluate(() => {
    const log = window.__coinposhGl;
    if (!log) throw new Error('The WebGL2 recorder did not install before the game booted');
    return log;
  });
}

function vfxProgramOf(fragment: string): VfxProgram | null {
  return (
    VFX_PROGRAMS.find((name) => VFX_FINGERPRINTS[name].every((part) => fragment.includes(part))) ??
    null
  );
}

/** The effect programs linked in `[from, to)`, in link order. */
function vfxLinks(log: GlLog, from: number, to = Infinity): VfxProgram[] {
  return log.links
    .filter((link) => link.at >= from && link.at < to)
    .map((link) => vfxProgramOf(link.fragment))
    .filter((name) => name !== null);
}

function markTimes(page: Page, name: string): Promise<number[]> {
  return page.evaluate(
    (mark) => performance.getEntriesByName(mark, 'mark').map((entry) => entry.startTime),
    name,
  );
}

function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

async function fusions(page: Page): Promise<number> {
  return (await probe(page)).counts.simFusions;
}

test.describe('shader warmup (P-580)', () => {
  test('every effect links in the frame after play starts, before the first fusion, and taps 1-60 link none of them', async ({
    page,
  }) => {
    await recordGl(page);
    await bootGame(page);
    const [playableAt] = await markTimes(page, PLAYABLE_MARK);
    if (playableAt === undefined) throw new Error(`The ${PLAYABLE_MARK} mark is missing`);
    await expect
      .poll(() => markTimes(page, WARMED_MARK), {
        message: 'the warmup frame ran once play started',
        timeout: 30_000,
      })
      .toHaveLength(1);
    const [warmedAt = Number.NaN] = await markTimes(page, WARMED_MARK);
    expect(warmedAt, 'P-628: the warmup frame no longer holds play back').toBeGreaterThan(
      playableAt,
    );

    const booted = await glLog(page);
    expect(booted.fusionsAtWarm, 'the effects were linked before any fusion fired').toEqual([0]);
    expect(
      new Set(vfxLinks(booted, 0, warmedAt)),
      'flash, ring, sparks and foil all linked by the warmup frame: a fingerprint that stops matching fails here',
    ).toEqual(new Set(VFX_PROGRAMS));

    for (let i = 0; i < TAPS; i += 1) {
      await tapDrop(page);
      await page.waitForTimeout(TAP_SPACING_MS);
    }
    await page.waitForTimeout(EFFECTS_SETTLE_MS);

    expect(await fusions(page), 'the taps fused coins, so the effects fired').toBeGreaterThan(0);
    expect(vfxLinks(await glLog(page), warmedAt), 'effect programs linked during taps').toEqual([]);
  });

  test('a tier change on a renderer rebuild warms the effects before the next fusion', async ({
    page,
  }) => {
    await recordGl(page);
    await bootGame(page);
    // SwiftShader always boots provisional `low` (FXAA) and saves nothing, so a saved benchmark
    // of `medium` (MSAA) is what the rebuilt renderer resolves to: a real tier change.
    const stored: StoredQuality = {
      backend: 'webgl2',
      benchTier: 'medium',
      benchmarkMs: 8,
      downgrade: null,
    };
    await page.evaluate(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [QUALITY_STORAGE_KEY, JSON.stringify(stored)] as const,
    );
    const lostAt = await now(page);
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#stage');
      const lose = canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!lose) throw new Error('#stage has no WebGL2 context with WEBGL_lose_context to lose');
      lose.loseContext();
    });

    // One warmup for the tier the rebuilt renderer applied, one for the renderer swap.
    await expect
      .poll(async () => (await markTimes(page, WARMED_MARK)).filter((at) => at > lostAt).length, {
        message: 'the rebuilt renderer warmed the effects for its tier and after the swap',
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(2);
    const rebuilt = await glLog(page);
    expect(
      rebuilt.multisample.some((entry) => entry.at < lostAt && entry.samples > 0),
      'the boot tier anti-aliases with FXAA',
    ).toBe(false);
    expect(
      rebuilt.multisample.some((entry) => entry.at > lostAt && entry.samples > 0),
      'the rebuilt renderer runs the medium tier, with MSAA',
    ).toBe(true);
    expect(
      new Set(vfxLinks(rebuilt, lostAt)),
      'the new context linked every effect program in a warmup frame',
    ).toEqual(new Set(VFX_PROGRAMS));

    const warmedAt = await now(page);
    const before = await fusions(page);
    for (let i = 0; i < TAPS && (await fusions(page)) === before; i += 1) {
      await tapDrop(page);
      await page.waitForTimeout(TAP_SPACING_MS);
    }
    expect(await fusions(page), 'a tap after the rebuild fused coins').toBeGreaterThan(before);
    await page.waitForTimeout(EFFECTS_SETTLE_MS);
    expect(
      vfxLinks(await glLog(page), warmedAt),
      'effect programs linked by the fusion after the tier change',
    ).toEqual([]);
  });
});
