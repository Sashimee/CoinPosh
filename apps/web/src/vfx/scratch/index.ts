export { ScratchCard } from './card.ts';
export type {
  ScratchAnswer,
  ScratchAudioPort,
  ScratchCardEvents,
  ScratchCardLabels,
  ScratchCardOptions,
  ScratchCardPhase,
  ScratchPrizeLine,
} from './card.ts';
export { ScratchFlow } from './flow.ts';
export type { ScratchPhase, ScratchStep } from './flow.ts';
export {
  BRUSH_RADIUS,
  CARD_CLEAR,
  CELL_REVEAL,
  cellAt,
  cellCentre,
  cellRect,
  CoverageMask,
  strokeStamps,
} from './mask.ts';
export type { CellRect, ScratchPoint } from './mask.ts';
export {
  FULL_SCRATCH,
  REDUCED_SCRATCH,
  SCRATCH_JUICE,
  scratchCue,
  scratchMatch,
  scratchTimeline,
} from './plan.ts';
export type { ScratchCue, ScratchInteraction, ScratchMatch, ScratchTimeline } from './plan.ts';
export { createScratchSurface } from './surface.ts';
export type { ScratchSurface, ScratchSurfaceKind } from './surface.ts';
