import { Vector3, type PerspectiveCamera } from 'three/webgpu';

/** A box on screen in CSS pixels from the viewport's top left. */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The DOM the unbox hero has to stand clear of once its reward card is up, in CSS pixels of a
 * viewport the 3D canvas fills.
 */
export interface UnboxClearance {
  readonly viewport: { readonly width: number; readonly height: number };
  /** The card where it rests: fit scale and side shift applied, never its entrance mid-flight. */
  readonly card: ScreenRect;
  /** Nothing of the hero above this line: the Vault plaque at the peak of its credit pop. */
  readonly ceiling: number;
  /** Nor below this one: the top of the dock. */
  readonly floor: number;
}

/**
 * The reward card and the cinematic are mounted side by side by the crate director, which hands
 * neither to the other, so the card posts where it rests here and the playing cinematic reads
 * it each frame. One unbox plays at a time; null while no card is up.
 */
let posted: UnboxClearance | null = null;

export function postUnboxClearance(clearance: UnboxClearance | null): void {
  posted = clearance;
}

export function unboxClearance(): UnboxClearance | null {
  return posted;
}

/** Air between the hero and the card or the plaque line, in CSS pixels. */
export const PRESENT_GAP = 14;
/** Air between the hero and the sides of the screen. */
const PRESENT_MARGIN = 16;
/** Never grown past its pedestal size: the lift only ever makes room. */
const MAX_SCALE = 1;
/** A band that would shrink the hero further than this is not worth the trip. */
export const MIN_PRESENT_SCALE = 0.3;
const SOLVE_ITERATIONS = 5;

/** Where the hero goes once presented: a world-space shift of its pivot and a uniform scale. */
export interface HeroPresentation {
  readonly offset: Vector3;
  readonly scale: number;
}

/**
 * Lifts the hero out from under the reward card: of the free bands on screen (above the card
 * under the plaque line, or beside it on a wide screen between the plaque line and the dock)
 * it takes the one that keeps the hero largest, and moves it the least way into it, so it hugs
 * the card it belongs to. The shift runs across the view at the hero's depth and the scale is
 * about its pivot; a few projected corrections absorb the perspective. `bound` is the hero's
 * swept outline in world space at rest and `camera` the rest camera, its matrices current.
 * A screen with no band worth the trip leaves the hero where it stands.
 */
export function presentHero(
  camera: PerspectiveCamera,
  pivot: Vector3,
  bound: readonly Vector3[],
  clearance: UnboxClearance,
): HeroPresentation {
  const { width, height } = clearance.viewport;
  const offset = new Vector3();
  if (!(width > 0 && height > 0) || bound.length === 0) return { offset, scale: 1 };
  const rest = screenBox(camera, pivot, bound, offset, 1, clearance);
  const restW = rest.right - rest.left;
  const restH = rest.bottom - rest.top;
  if (!(restW > 0 && restH > 0)) return { offset, scale: 1 };

  let best: { region: ScreenRect; fit: number } | null = null;
  for (const region of freeBands(clearance)) {
    const fit = Math.min(
      MAX_SCALE,
      (region.right - region.left) / restW,
      (region.bottom - region.top) / restH,
    );
    if (fit >= MIN_PRESENT_SCALE && (best === null || fit > best.fit)) best = { region, fit };
  }
  if (best === null) return { offset, scale: 1 };

  const { region, fit } = best;
  const w = restW * fit;
  const h = restH * fit;
  const cx = clamp((rest.left + rest.right) / 2, region.left + w / 2, region.right - w / 2);
  const cy = clamp((rest.top + rest.bottom) / 2, region.top + h / 2, region.bottom - h / 2);

  camera.matrixWorld.extractBasis(right, up, back);
  const halfView = Math.tan((camera.fov * Math.PI) / 360);
  let scale = fit;
  for (let i = 0; i < SOLVE_ITERATIONS; i++) {
    const box = screenBox(camera, pivot, bound, offset, scale, clearance);
    const boxW = box.right - box.left;
    const boxH = box.bottom - box.top;
    if (boxW > 0 && boxH > 0) scale *= Math.min(w / boxW, h / boxH);
    const depth = toPivot.copy(pivot).add(offset).sub(camera.position).dot(back) * -1;
    const errX = cx - (box.left + box.right) / 2;
    const errY = cy - (box.top + box.bottom) / 2;
    offset.addScaledVector(right, ((errX * 2) / width) * depth * halfView * camera.aspect);
    offset.addScaledVector(up, ((-errY * 2) / height) * depth * halfView);
  }
  return { offset, scale };
}

/** The bands the hero may stand in, margins and gaps taken off; empty ones dropped. */
export function freeBands(clearance: UnboxClearance): ScreenRect[] {
  const { viewport, card, ceiling, floor } = clearance;
  const top = Math.max(PRESENT_MARGIN, ceiling + PRESENT_GAP);
  const bottom = Math.min(viewport.height - PRESENT_MARGIN, floor - PRESENT_GAP);
  const bands: ScreenRect[] = [
    {
      left: PRESENT_MARGIN,
      top,
      right: viewport.width - PRESENT_MARGIN,
      bottom: Math.min(bottom, card.top - PRESENT_GAP),
    },
    { left: PRESENT_MARGIN, top, right: card.left - PRESENT_GAP, bottom },
    { left: card.right + PRESENT_GAP, top, right: viewport.width - PRESENT_MARGIN, bottom },
  ];
  return bands.filter((band) => band.right > band.left && band.bottom > band.top);
}

/** Share of `box` that lies outside `card`: 1 is fully clear, 0 fully covered. */
export function shareOutside(box: ScreenRect, card: ScreenRect): number {
  const area = (box.right - box.left) * (box.bottom - box.top);
  if (!(area > 0)) return 0;
  const across = Math.max(0, Math.min(box.right, card.right) - Math.max(box.left, card.left));
  const down = Math.max(0, Math.min(box.bottom, card.bottom) - Math.max(box.top, card.top));
  return 1 - (across * down) / area;
}

/** The bound moved by `offset` and scaled by `scale` about `pivot`, projected to CSS pixels. */
export function screenBox(
  camera: PerspectiveCamera,
  pivot: Vector3,
  bound: readonly Vector3[],
  offset: Vector3,
  scale: number,
  clearance: Pick<UnboxClearance, 'viewport'>,
): ScreenRect {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of bound) {
    projected.copy(point).sub(pivot).multiplyScalar(scale).add(pivot).add(offset).project(camera);
    minX = Math.min(minX, projected.x);
    maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y);
    maxY = Math.max(maxY, projected.y);
  }
  const { width, height } = clearance.viewport;
  return {
    left: ((minX + 1) / 2) * width,
    right: ((maxX + 1) / 2) * width,
    top: ((1 - maxY) / 2) * height,
    bottom: ((1 - minY) / 2) * height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return min > max ? (min + max) / 2 : Math.min(max, Math.max(min, value));
}

const right = new Vector3();
const up = new Vector3();
const back = new Vector3();
const toPivot = new Vector3();
const projected = new Vector3();
