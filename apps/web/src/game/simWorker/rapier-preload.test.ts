import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RAPIER_COMPAT_MODULE,
  RAPIER_WASM_NAME,
  streamRapierWasm,
} from '@coinposh/sim/rapier-wasm';
import { describe, expect, it } from 'vitest';

const INDEX_HTML = new URL('../../../index.html', import.meta.url);
const WASM_PRELOAD = /<link\b[^>]*\btype="application\/wasm"[^>]*>/g;

function preloadHrefs(): string[] {
  const html = readFileSync(INDEX_HTML, 'utf8');
  return [...html.matchAll(WASM_PRELOAD)].map(([tag]) => {
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href === undefined) throw new Error(`index.html wasm preload has no href: ${tag}`);
    return href;
  });
}

/** The -compat entry module the sim worker bundles, resolved the way @coinposh/sim resolves it. */
function workerRapierModule(): string {
  const simEntry = createRequire(import.meta.url).resolve('@coinposh/sim/rapier-wasm');
  const rapierMain = createRequire(simEntry).resolve('@dimforge/rapier3d-deterministic-compat');
  return realpathSync(join(dirname(rapierMain), 'rapier.mjs'));
}

describe("index.html's Rapier wasm preload", () => {
  it('names the file the build emits for the worker, so both requests share one URL', () => {
    const hrefs = preloadHrefs();
    expect(hrefs).toHaveLength(1);
    const href = hrefs[0] ?? '';
    expect(href.split('/').at(-1)).toBe(RAPIER_WASM_NAME);

    const preloaded = realpathSync(fileURLToPath(new URL(href, INDEX_HTML)));
    const rapierModule = workerRapierModule();
    expect(RAPIER_COMPAT_MODULE.test(rapierModule)).toBe(true);
    expect(preloaded).toBe(realpathSync(join(dirname(rapierModule), RAPIER_WASM_NAME)));

    let streamed: Uint8Array | undefined;
    streamRapierWasm(readFileSync(rapierModule, 'utf8'), (wasm) => {
      streamed = wasm;
      return '""';
    });
    expect(Buffer.from(streamed ?? []).equals(readFileSync(preloaded))).toBe(true);
  });
});
