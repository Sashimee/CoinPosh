import {
  CoefficientCombineRule,
  ColliderDesc,
  Cuboid,
  init,
  RigidBodyDesc,
  RigidBodyType,
  RotationOps,
  RoundCylinder,
  VectorOps,
  version,
  World,
} from '@dimforge/rapier3d-deterministic-compat';

/**
 * The part of Rapier the sim uses. Naming it, rather than passing the package's namespace
 * around, lets a bundler drop the rest of the bindings (soft bodies, joints, controllers, debug
 * rendering) from the sim worker; the wasm itself is the same either way.
 */
const RAPIER = {
  CoefficientCombineRule,
  ColliderDesc,
  Cuboid,
  RigidBodyDesc,
  RigidBodyType,
  RotationOps,
  RoundCylinder,
  VectorOps,
  version,
  World,
};

export type Rapier = typeof RAPIER;

let ready: Promise<Rapier> | undefined;

/**
 * Loads the cross-platform deterministic Rapier build. Node runs the package as published, with
 * the wasm inlined, so the same binary runs in Node and the Cloudflare auditor; the web build
 * streams that same binary from its own asset (see rapier-wasm.ts). Safe to call repeatedly;
 * the module is initialised once per JS realm, and a failed load is retried on the next call.
 */
export function loadRapier(): Promise<Rapier> {
  ready ??= init().then(
    () => RAPIER,
    (error: unknown) => {
      ready = undefined;
      throw new Error('Failed to initialise the Rapier WASM module', { cause: error });
    },
  );
  return ready;
}
