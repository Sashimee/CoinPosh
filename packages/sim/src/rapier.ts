import RAPIER from '@dimforge/rapier3d-deterministic-compat';

export type Rapier = typeof RAPIER;

let ready: Promise<Rapier> | undefined;

/**
 * Loads the cross-platform deterministic Rapier build (inlined WASM, so the same
 * binary runs in the browser worker, Node and the Cloudflare auditor). Safe to call
 * repeatedly; the module is initialised once per JS realm, and a failed load is
 * retried on the next call.
 */
export function loadRapier(): Promise<Rapier> {
  ready ??= RAPIER.init().then(
    () => RAPIER,
    (error: unknown) => {
      ready = undefined;
      throw new Error('Failed to initialise the Rapier WASM module', { cause: error });
    },
  );
  return ready;
}
