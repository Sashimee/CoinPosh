import type { Frustum } from 'three/webgpu';

export const CoinLod = { near: 0, far: 1 } as const;
export type CoinLodLevel = (typeof CoinLod)[keyof typeof CoinLod];

export interface LodSettings {
  readonly nearPixelRadius: number;
  readonly hysteresis: number;
}

export const DEFAULT_LOD_SETTINGS: LodSettings = { nearPixelRadius: 26, hysteresis: 0.15 };

export interface LodView {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly pixelsPerUnitAtUnitDistance: number;
  readonly frustum: Frustum | null;
}

export interface LodInput {
  readonly positions: Float32Array;
  readonly count: number;
  readonly radius: number;
  readonly state: Uint8Array;
}

export interface LodOutput {
  readonly near: Uint32Array;
  readonly far: Uint32Array;
  nearCount: number;
  farCount: number;
}

export function pixelsPerUnit(fovDegrees: number, viewportHeightPx: number): number {
  return viewportHeightPx / (2 * Math.tan((fovDegrees * Math.PI) / 360));
}

// Coins switch on projected size rather than raw distance so the threshold holds across
// FOV kicks and resolution changes. The band around the threshold keeps a coin from
// flickering between levels while it sits right on the boundary.
export function partitionByLod(
  input: LodInput,
  view: LodView,
  settings: LodSettings,
  out: LodOutput,
): void {
  out.nearCount = 0;
  out.farCount = 0;
  const { positions, radius, state } = input;
  const enterNear = settings.nearPixelRadius * (1 + settings.hysteresis);
  const leaveNear = settings.nearPixelRadius * (1 - settings.hysteresis);
  const planes = view.frustum?.planes;

  for (let i = 0; i < input.count; i += 1) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;

    if (planes) {
      let visible = true;
      for (const plane of planes) {
        if (
          plane.normal.x * x + plane.normal.y * y + plane.normal.z * z + plane.constant <
          -radius
        ) {
          visible = false;
          break;
        }
      }
      if (!visible) continue;
    }

    const distance = Math.max(
      Math.hypot(x - view.cameraX, y - view.cameraY, z - view.cameraZ),
      1e-6,
    );
    const projected = (radius * view.pixelsPerUnitAtUnitDistance) / distance;
    const wasNear = state[i] === CoinLod.near;
    const isNear = wasNear ? projected >= leaveNear : projected >= enterNear;
    state[i] = isNear ? CoinLod.near : CoinLod.far;
    if (isNear) {
      out.near[out.nearCount] = i;
      out.nearCount += 1;
    } else {
      out.far[out.farCount] = i;
      out.farCount += 1;
    }
  }
}
