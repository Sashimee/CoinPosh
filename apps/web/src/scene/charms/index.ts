import { type BufferGeometry, type Material, Mesh, type Object3D } from 'three/webgpu';
import { pulse } from '../../vfx/easing.ts';
import { CharmBurst } from './fx.ts';
import {
  type CharmKind,
  DEFAULT_CHARM_TAGS,
  isCharmKind,
  SYNERGY_COLORS,
  type SynergyTag,
} from './kinds.ts';
import { type CharmQuality, createCharmUniforms } from './materials.ts';
import { buildCharmModel } from './models.ts';

export {
  CHARM_KINDS,
  CHARM_SOCKET,
  DEFAULT_CHARM_TAGS,
  isCharmKind,
  SYNERGY_COLORS,
  SYNERGY_TAGS,
  type CharmKind,
  type SynergyTag,
} from './kinds.ts';
export type { CharmQuality } from './materials.ts';

export interface CharmViewOptions {
  /** Synergy tags inlaid in the plinth ring; the first one tints the activation. Defaults per kind. */
  readonly tags?: readonly SynergyTag[];
  readonly reducedMotion?: boolean;
  readonly quality?: CharmQuality;
  /** Offsets the idle clock so neighbouring charms do not breathe in step. Seconds. */
  readonly phase?: number;
}

export interface CharmView {
  readonly kind: CharmKind;
  /** Stands on the table floor at the socket centre; position and rotate it as a whole. */
  readonly object3d: Object3D;
  /** Seconds an activation plays before the charm is back at rest. */
  readonly activationSeconds: number;
  /** Advances the charm to absolute time `t` (seconds). Call once per frame. */
  setIdle(t: number): void;
  /** Plays the activation, starting from the next `setIdle` time. */
  activate(): void;
  setReducedMotion(reduced: boolean): void;
  /** Frees every geometry and material and detaches the charm from its parent. */
  dispose(): void;
}

const FLASH_SECONDS = 0.55;
const REDUCED_FLASH_SECONDS = 0.9;

function seedFor(kind: CharmKind): number {
  let seed = 2166136261;
  for (let i = 0; i < kind.length; i += 1) seed = Math.imul(seed ^ kind.charCodeAt(i), 16777619);
  return seed >>> 0;
}

/**
 * Builds one charm: a procedural model on its socket plinth, an idle loop and an activation
 * (choreography, accent flash, sparks and a shockwave ring). Reduced motion keeps the charm
 * still at idle and swaps the activation for a flash and a ring that blooms in place.
 */
export function createCharmView(kind: CharmKind, opts: CharmViewOptions = {}): CharmView {
  if (!isCharmKind(kind)) throw new Error(`Unknown charm kind "${String(kind)}"`);
  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : DEFAULT_CHARM_TAGS[kind];
  const quality = opts.quality ?? 'high';
  const phase = opts.phase ?? 0;
  let reduced = opts.reducedMotion ?? false;
  const uniforms = createCharmUniforms(SYNERGY_COLORS[tags[0] ?? 'gilded']);
  const model = buildCharmModel(kind, { quality, uniforms, tags });
  const burst = new CharmBurst(model.burst, uniforms, quality, seedFor(kind));
  model.root.add(burst.particles);
  if (burst.ring) model.root.add(burst.ring);
  model.root.userData.charmKind = kind;
  const activationSeconds = Math.max(model.choreography, burst.duration, REDUCED_FLASH_SECONDS);

  let pending = false;
  let startedAt = Number.NaN;
  let disposed = false;

  const view: CharmView = {
    kind,
    object3d: model.root,
    activationSeconds,
    setIdle(t) {
      if (disposed || !Number.isFinite(t)) return;
      if (pending) {
        startedAt = t;
        pending = false;
      }
      let since = Number.isNaN(startedAt) ? -1 : t - startedAt;
      if (since >= activationSeconds || since < 0) {
        since = -1;
        startedAt = Number.NaN;
      }
      const motion = reduced ? 0 : 1;
      model.pose(reduced ? 0 : t + phase, since, motion);
      uniforms.flash.value =
        since < 0
          ? 0
          : reduced
            ? pulse(since / REDUCED_FLASH_SECONDS, 0.3) * 0.9
            : pulse(since / FLASH_SECONDS, 0.12) * 1.1;
      burst.update(since, reduced);
    },
    activate() {
      if (!disposed) pending = true;
    },
    setReducedMotion(on) {
      reduced = on;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      model.root.traverse((node) => {
        if (node instanceof Mesh) {
          geometries.add(node.geometry as BufferGeometry);
          const material = node.material as Material | Material[];
          for (const m of Array.isArray(material) ? material : [material]) materials.add(m);
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      model.root.removeFromParent();
    },
  };
  return view;
}
