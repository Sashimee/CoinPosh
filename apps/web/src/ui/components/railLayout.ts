import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import {
  applyCameraPreset,
  RIVIERA_TABLE as T,
  rivieraCameraPreset,
} from '../../scene/venues/riviera/layout.ts';

/** A screen rectangle in CSS px from the viewport's top-left corner. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export type RailSide = 'left' | 'right';

/**
 * Where the meters live: `flank` beside the coin floor when the screen is wide enough for a
 * card there, `crown` between the HUD above and the floor's back edge, `apron` between the
 * payout lip and the dock, and `edge` (no card) in the sliver the camera leaves beside the floor.
 */
export type RailZone = 'flank' | 'crown' | 'apron' | 'edge';

export interface RailSlot {
  readonly side: RailSide;
  /** The collapsed rail. */
  readonly rail: Box;
  /** The open card, sharing the rail's top, height and outer edge; null where none fits. */
  readonly card: Box | null;
}

export interface RailPlan {
  readonly zone: RailZone;
  readonly left: RailSlot | null;
  readonly right: RailSlot | null;
}

export interface RailPlanInput {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly safe: Insets;
  readonly floor: Box;
  /** Bottom edge of the HUD above the table: banner, Vault plaque and its notices. */
  readonly ceiling: number;
  /** Top edge of the HUD below the table: the dock, or the aim rail when it sits higher. */
  readonly base: number;
}

export const RAIL_WIDTH = 22;
/** P-247: a collapsed meter is a rail no wider than this. */
export const RAIL_MAX_WIDTH = 28;
export const CARD_MAX_WIDTH = 176;
const CARD_MIN_WIDTH = 128;
const RAIL_MIN_HEIGHT = 76;
const RAIL_MAX_HEIGHT = 116;
const EDGE_RAIL_MIN_WIDTH = 6;
const EDGE_GAP = 6;
const FLOOR_GAP = 8;
const CHROME_GAP = 8;
const CENTRE_GAP = 12;

export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/** True when `inner` lies wholly inside `outer`. */
export function boxContains(outer: Box, inner: Box): boolean {
  const epsilon = 1e-6;
  return (
    inner.left >= outer.left - epsilon &&
    inner.top >= outer.top - epsilon &&
    inner.left + inner.width <= outer.left + outer.width + epsilon &&
    inner.top + inner.height <= outer.top + outer.height + epsilon
  );
}

const floorCamera = new PerspectiveCamera();
const FLOOR_POINTS = [-1, 1].flatMap((side) => [
  new Vector3(side * T.fieldHalfWidth, 0, T.fieldFrontZ),
  new Vector3(side * T.fieldHalfWidth, 0, T.backboardFrontZ),
  new Vector3(side * T.fieldHalfWidth, T.pusherHeight, T.backboardFrontZ),
]);
const projected = new Vector3();

/**
 * Screen rect of the coin floor, pusher deck included, as the stage camera frames it on a
 * full-viewport canvas of this size.
 */
export function coinFloorRect(width: number, height: number): Box {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  floorCamera.aspect = w / h;
  applyCameraPreset(floorCamera, rivieraCameraPreset(w / h));
  floorCamera.updateMatrixWorld();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of FLOOR_POINTS) {
    projected.copy(point).project(floorCamera);
    const x = ((projected.x + 1) / 2) * w;
    const y = ((1 - projected.y) / 2) * h;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

interface Band {
  readonly top: number;
  readonly bottom: number;
}

function fitBand(band: Band, centre: number): Band | null {
  const room = band.bottom - band.top;
  if (room < RAIL_MIN_HEIGHT) return null;
  const height = Math.min(RAIL_MAX_HEIGHT, room);
  const top = Math.min(Math.max(centre - height / 2, band.top), band.bottom - height);
  return { top, bottom: top + height };
}

function slots(
  zone: RailZone,
  band: Band,
  inner: { left: number; right: number },
  railWidth: number,
  cardWidth: number | null,
): RailPlan {
  const height = band.bottom - band.top;
  const make = (side: RailSide): RailSlot => {
    const at = (width: number): Box => ({
      left: side === 'left' ? inner.left : inner.right - width,
      top: band.top,
      width,
      height,
    });
    return { side, rail: at(railWidth), card: cardWidth === null ? null : at(cardWidth) };
  };
  return { zone, left: make('left'), right: make('right') };
}

/**
 * Lays the Decorum (left) and Cascade (right) rails out against the viewport edges so that
 * neither the rail, nor the card it opens into, nor any width in between ever covers the coin
 * floor or the HUD above and below it.
 */
export function planMeterRails(input: RailPlanInput): RailPlan {
  const { viewport, safe, floor } = input;
  const inner = { left: safe.left + EDGE_GAP, right: viewport.width - safe.right - EDGE_GAP };
  const ceiling = Math.max(input.ceiling, safe.top) + CHROME_GAP;
  const base = Math.min(input.base, viewport.height - safe.bottom) - CHROME_GAP;
  const floorRight = floor.left + floor.width;
  const floorBottom = floor.top + floor.height;
  const half = (inner.right - inner.left - CENTRE_GAP) / 2;

  const flankRoom = Math.min(
    floor.left - FLOOR_GAP - inner.left,
    inner.right - (floorRight + FLOOR_GAP),
    half,
  );
  if (flankRoom >= CARD_MIN_WIDTH) {
    const band = fitBand({ top: ceiling, bottom: base }, floor.top + floor.height / 2);
    if (band) return slots('flank', band, inner, RAIL_WIDTH, Math.min(CARD_MAX_WIDTH, flankRoom));
  }

  const cardWidth = Math.min(CARD_MAX_WIDTH, half);
  if (cardWidth >= CARD_MIN_WIDTH) {
    const crownBottom = floor.top - FLOOR_GAP;
    const crown = fitBand({ top: ceiling, bottom: crownBottom }, (ceiling + crownBottom) / 2);
    if (crown) return slots('crown', crown, inner, RAIL_WIDTH, cardWidth);
    const apronTop = floorBottom + FLOOR_GAP;
    const apron = fitBand({ top: apronTop, bottom: base }, apronTop + RAIL_MAX_HEIGHT / 2);
    if (apron) return slots('apron', apron, inner, RAIL_WIDTH, cardWidth);
  }

  const strip = Math.min(floor.left - safe.left, viewport.width - safe.right - floorRight);
  const edgeWidth = Math.min(RAIL_WIDTH, strip - 4);
  if (edgeWidth < EDGE_RAIL_MIN_WIDTH) return { zone: 'edge', left: null, right: null };
  const height = Math.min(RAIL_MAX_HEIGHT, floor.height);
  const top = floor.top + (floor.height - height) / 2;
  const edgeInner = { left: safe.left + 2, right: viewport.width - safe.right - 2 };
  return slots('edge', { top, bottom: top + height }, edgeInner, edgeWidth, null);
}

/**
 * The box a meter fills `open` of the way from rail to card. It grows from the screen edge
 * inward, and an overshooting spring never pushes it past the card.
 */
export function railBox(slot: RailSlot, open: number): Box {
  const card = slot.card;
  if (!card) return slot.rail;
  const t = Math.min(1, Math.max(0, open));
  const width = slot.rail.width + (card.width - slot.rail.width) * t;
  const left = slot.side === 'left' ? slot.rail.left : slot.rail.left + slot.rail.width - width;
  return { left, top: slot.rail.top, width, height: slot.rail.height };
}
