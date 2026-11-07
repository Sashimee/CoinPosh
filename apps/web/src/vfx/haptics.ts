/** Vibration patterns in ms; light to heavy. */
export const HAPTIC_PATTERNS = {
  tick: [6],
  tap: [12],
  thud: [26],
  fanfare: [24, 50, 24, 50, 60],
} as const satisfies Record<string, readonly number[]>;

export type HapticPattern = keyof typeof HAPTIC_PATTERNS;

/** Ticks closer together than this blur into a buzz, so they are dropped. */
const MIN_GAP_MS: Readonly<Record<HapticPattern, number>> = {
  tick: 40,
  tap: 60,
  thud: 90,
  fanfare: 400,
};

export interface HapticNavigator {
  vibrate?: (pattern: number[]) => boolean;
  userActivation?: { readonly hasBeenActive: boolean };
}

/**
 * The haptic half of juice item 2 on phones (Web Vibration until the Capacitor plugin
 * lands in M7). Silent where vibration is missing, and before the first gesture, when
 * Chrome would refuse the call and log an intervention.
 */
export class Haptics {
  enabled = true;
  private readonly last = new Map<HapticPattern, number>();

  constructor(
    private readonly navigator: HapticNavigator | undefined,
    private readonly now: () => number,
  ) {}

  get supported(): boolean {
    return typeof this.navigator?.vibrate === 'function';
  }

  pulse(pattern: HapticPattern): boolean {
    const nav = this.navigator;
    if (!this.enabled || !nav || typeof nav.vibrate !== 'function') return false;
    if (nav.userActivation && !nav.userActivation.hasBeenActive) return false;
    const now = this.now();
    const previous = this.last.get(pattern);
    if (previous !== undefined && now - previous < MIN_GAP_MS[pattern]) return false;
    this.last.set(pattern, now);
    return nav.vibrate.call(nav, [...HAPTIC_PATTERNS[pattern]]);
  }
}
