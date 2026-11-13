/**
 * Build-time support for shipping Rapier's WebAssembly as its own asset in the browser.
 *
 * The deterministic `-compat` build inlines its wasm as base64 and decodes it inside `init()`,
 * which puts 4 MB of text in the sim worker and compiles it only after the whole script has
 * downloaded and parsed. A bundler instead swaps that base64 literal for a URL with
 * `streamRapierWasm`, emits the decoded bytes next to the worker, and wasm-bindgen's own
 * loader then fetches the URL and compiles it with `WebAssembly.instantiateStreaming` while
 * it downloads. The emitted bytes are the inlined ones, decoded, so the engine that runs is
 * bit-for-bit the one Node, the server verifier and the hash tests run.
 *
 * Node keeps loading the package as published (wasm inlined, nothing to fetch).
 */

/** The `-compat` entry module a bundler rewrites, matched against its resolved file path. */
export const RAPIER_COMPAT_MODULE =
  /[\\/]@dimforge[\\/]rapier3d-deterministic-compat[\\/]dist[\\/]rapier\.mjs$/;

/** The name the published package gives its wasm binary, kept for the emitted asset. */
export const RAPIER_WASM_NAME = 'rapier_wasm3d_bg.wasm';

/** wasm-bindgen's `init()` argument in the `-compat` build: `<decoder>.toByteArray("<base64>").buffer`. */
const INLINED_WASM = /\b[\w$]+\.toByteArray\("([A-Za-z0-9+/]+={0,2})"\)\.buffer/g;

/** The magic number and version every WebAssembly binary starts with. */
const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/**
 * Takes the inlined wasm out of the source of Rapier's `-compat` entry module (`rapier.mjs`)
 * and has `init()` load it from a URL instead. `urlFor` receives the wasm binary, which the
 * caller serves as `application/wasm`, and returns a JavaScript expression evaluating to its
 * URL (for example `"/assets/rapier.wasm"`); the rewritten module source is returned.
 *
 * Throws when the module does not inline exactly one wasm binary, which means a Rapier upgrade
 * changed the loader; the build must stop rather than ship the 4 MB inlined copy unnoticed.
 */
export function streamRapierWasm(code: string, urlFor: (wasm: Uint8Array) => string): string {
  const found = [...code.matchAll(INLINED_WASM)];
  const [inlined] = found;
  if (found.length !== 1 || inlined?.[1] === undefined) {
    throw new Error(
      `Expected Rapier's rapier.mjs to inline exactly one base64 wasm binary passed to init(), found ${found.length}. A Rapier upgrade changed how the -compat build loads its wasm: update streamRapierWasm in packages/sim/src/rapier-wasm.ts to match.`,
    );
  }
  const wasm = decodeBase64(inlined[1]);
  if (!WASM_HEADER.every((byte, at) => wasm[at] === byte)) {
    throw new Error(
      "The base64 literal passed to Rapier's init() does not decode to a WebAssembly binary: update streamRapierWasm in packages/sim/src/rapier-wasm.ts to match the new -compat build.",
    );
  }
  const end = inlined.index + inlined[0].length;
  return code.slice(0, inlined.index) + urlFor(wasm) + code.slice(end);
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) {
    bytes[at] = binary.charCodeAt(at);
  }
  return bytes;
}
