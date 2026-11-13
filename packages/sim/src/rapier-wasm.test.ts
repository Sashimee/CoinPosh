import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RAPIER_COMPAT_MODULE, RAPIER_WASM_NAME, streamRapierWasm } from './rapier-wasm.ts';

const RAPIER_DIST = dirname(
  createRequire(import.meta.url).resolve('@dimforge/rapier3d-deterministic-compat'),
);
const RAPIER_MODULE = join(RAPIER_DIST, 'rapier.mjs');
const rapierSource = readFileSync(RAPIER_MODULE, 'utf8');
const publishedWasm = new Uint8Array(readFileSync(join(RAPIER_DIST, RAPIER_WASM_NAME)));

const WASM_URL = '"/assets/rapier.wasm"';

function inlined(base64: string): string {
  return `const a=1;await EI({module_or_path:oC.toByteArray("${base64}").buffer});`;
}

const WASM_BASE64 = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x2a]).toString(
  'base64',
);

describe('streamRapierWasm', () => {
  it('matches the resolved -compat entry module on every platform separator', () => {
    expect(RAPIER_COMPAT_MODULE.test(RAPIER_MODULE)).toBe(true);
    expect(RAPIER_COMPAT_MODULE.test(RAPIER_MODULE.replaceAll('/', '\\'))).toBe(true);
    expect(RAPIER_COMPAT_MODULE.test(join(RAPIER_DIST, 'rapier.d.ts'))).toBe(false);
  });

  it('hands out the exact binary the package publishes, so the browser runs the engine the hashes pin', () => {
    let emitted: Uint8Array | undefined;
    streamRapierWasm(rapierSource, (wasm) => {
      emitted = wasm;
      return WASM_URL;
    });
    expect(emitted?.length).toBe(publishedWasm.length);
    expect(Buffer.from(emitted ?? []).equals(Buffer.from(publishedWasm))).toBe(true);
  });

  it('leaves no inlined wasm behind and passes init() the URL instead', () => {
    const streamed = streamRapierWasm(rapierSource, () => WASM_URL);
    expect(streamed).toContain(`module_or_path:${WASM_URL}`);
    expect(streamed).not.toMatch(/[A-Za-z0-9+/]{10000}/);
    expect(rapierSource.length - streamed.length).toBeGreaterThan(publishedWasm.length);
  });

  it('rewrites only the base64 argument and keeps the rest of the module intact', () => {
    expect(streamRapierWasm(inlined(WASM_BASE64), () => WASM_URL)).toBe(
      `const a=1;await EI({module_or_path:${WASM_URL}});`,
    );
  });

  it('refuses a module with no inlined wasm, so an upgrade cannot ship the 4 MB copy unnoticed', () => {
    expect(() => streamRapierWasm('await EI({module_or_path:url});', () => WASM_URL)).toThrow(
      /exactly one base64 wasm binary.*found 0/,
    );
  });

  it('refuses a module that inlines more than one binary', () => {
    expect(() =>
      streamRapierWasm(inlined(WASM_BASE64) + inlined(WASM_BASE64), () => WASM_URL),
    ).toThrow(/found 2/);
  });

  it('refuses a base64 payload that is not WebAssembly', () => {
    const notWasm = Buffer.from('not a wasm module').toString('base64');
    expect(() => streamRapierWasm(inlined(notWasm), () => WASM_URL)).toThrow(
      /does not decode to a WebAssembly binary/,
    );
  });
});
