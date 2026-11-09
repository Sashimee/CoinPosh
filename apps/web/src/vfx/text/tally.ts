import type { ScreenPoint } from './arc.ts';
import type { PopRequest } from './numberPopLayer.ts';

/**
 * Credits that arrive while a sheet is open, folded into the one pop that plays when it
 * closes: the summed value, launched from the average of where each was earned, into
 * the latest target, in the colour of the biggest share (heirloom prism wins outright).
 */
export class PopTally {
  private requests: PopRequest[] = [];

  get size(): number {
    return this.requests.length;
  }

  add(request: PopRequest): void {
    this.requests.push(request);
  }

  clear(): void {
    this.requests = [];
  }

  /** The combined pop, or null when nothing was held; empties the tally either way. */
  take(format: (value: number) => string): PopRequest | null {
    const held = this.requests;
    this.requests = [];
    const last = held[held.length - 1];
    if (!last) return null;
    if (held.length === 1) return last;
    let magnitude = 0;
    let x = 0;
    let y = 0;
    let lead = last;
    for (const request of held) {
      magnitude += request.magnitude;
      x += request.from.x;
      y += request.from.y;
      if (Math.abs(request.magnitude) > Math.abs(lead.magnitude)) lead = request;
    }
    const prism = held.find((r) => r.prism);
    const from: ScreenPoint = { x: x / held.length, y: y / held.length };
    const arrivals = held.flatMap((r) => (r.onArrive ? [r.onArrive] : []));
    return {
      text: format(magnitude),
      magnitude,
      color: (prism ?? lead).color,
      prism: Boolean(prism),
      from,
      to: last.to,
      ...(arrivals.length > 0
        ? {
            onArrive: () => {
              for (const arrive of arrivals) arrive();
            },
          }
        : {}),
    };
  }
}
