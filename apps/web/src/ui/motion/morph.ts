import { SPRINGS, type SpringConfig } from './spring.ts';
import { SpringValue } from './value.ts';

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface MorphFrame {
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  /** 0..1 opacity for the panel's content, which only fades in once the shape is mostly there. */
  readonly content: number;
}

const CONTENT_START = 0.35;
const CONTENT_SPAN = 0.45;

/**
 * FLIP interpolation between the trigger's box (`progress` 0) and the panel's resting box
 * (`progress` 1), expressed as a transform on the panel with a top-left origin.
 */
export function morphFrame(from: Box, to: Box, progress: number): MorphFrame {
  const inverse = 1 - progress;
  const scaleX = to.width > 0 ? from.width / to.width : 1;
  const scaleY = to.height > 0 ? from.height / to.height : 1;
  return {
    translateX: (from.left - to.left) * inverse,
    translateY: (from.top - to.top) * inverse,
    scaleX: scaleX + (1 - scaleX) * progress,
    scaleY: scaleY + (1 - scaleY) * progress,
    content: Math.min(1, Math.max(0, (progress - CONTENT_START) / CONTENT_SPAN)),
  };
}

export interface SharedLayoutMorph {
  open(from: Box): Promise<void>;
  close(to: Box): Promise<void>;
  jump(open: boolean): void;
}

/**
 * Shared-layout transition: the panel grows out of the element that opened it and shrinks
 * back into it. Radii are counter-scaled so corners stay round mid-flight.
 */
export function sharedLayoutMorph(
  panel: HTMLElement,
  content: HTMLElement,
  radius: number,
  config: SpringConfig = SPRINGS.sheet,
): SharedLayoutMorph {
  let from: Box | null = null;
  let to: Box | null = null;

  const paint = (progress: number): void => {
    if (!from || !to) {
      panel.style.transform = '';
      panel.style.borderRadius = '';
      content.style.opacity = progress >= 1 ? '' : String(progress);
      return;
    }
    const frame = morphFrame(from, to, progress);
    panel.style.transformOrigin = '0 0';
    panel.style.transform = `translate(${frame.translateX}px, ${frame.translateY}px) scale(${frame.scaleX}, ${frame.scaleY})`;
    const rx = radius / Math.max(frame.scaleX, 0.01);
    const ry = radius / Math.max(frame.scaleY, 0.01);
    panel.style.borderRadius = `${rx}px / ${ry}px`;
    content.style.opacity = String(frame.content);
    if (progress >= 1 && frame.translateX === 0 && frame.translateY === 0) {
      panel.style.transform = '';
      panel.style.borderRadius = '';
      content.style.opacity = '';
    }
  };

  const progress = new SpringValue(0, config, paint);
  const measure = (): Box => {
    const rect = panel.getBoundingClientRect();
    const style = panel.style.transform;
    if (style === '') return rect;
    panel.style.transform = '';
    const resting = panel.getBoundingClientRect();
    panel.style.transform = style;
    return resting;
  };

  return {
    async open(source) {
      from = source;
      to = measure();
      if (progress.value <= 0) paint(0);
      await progress.to(1, config);
    },
    async close(target) {
      from = target;
      to = measure();
      await progress.to(0, SPRINGS.snappy);
      progress.stop();
    },
    jump(open) {
      from = null;
      to = null;
      progress.jump(open ? 1 : 0);
    },
  };
}
