/**
 * Checks for prop configuration, which reaches the sim as data from the server: every
 * reader takes `unknown` and throws a RangeError or TypeError naming the field and the
 * range it must be in.
 */

export type Fields = Readonly<Record<string, unknown>>;

/** `raw` as an object holding exactly `keys`. */
export function fields(raw: unknown, what: string, keys: readonly string[]): Fields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${what} must be an object with ${keys.join(', ')}`);
  }
  const record = raw as Fields;
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  if (extra.length > 0) {
    throw new RangeError(
      `${what} has unknown fields ${extra.join(', ')}; it takes ${keys.join(', ')}`,
    );
  }
  return record;
}

/** A finite number in [min, max]. */
export function numberIn(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${what} must be a number in [${min}, ${max}], got ${String(value)}`);
  }
  return value;
}

/** A finite number in (min, max]. */
export function numberAbove(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= min || value > max) {
    throw new RangeError(`${what} must be a number in (${min}, ${max}], got ${String(value)}`);
  }
  return value;
}

/** An integer in [min, max]. */
export function intIn(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${what} must be an integer in [${min}, ${max}], got ${String(value)}`);
  }
  return value;
}

export function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${what} must be true or false, got ${String(value)}`);
  }
  return value;
}

/** One of `options`. */
export function oneOf<T extends string>(value: unknown, what: string, options: readonly T[]): T {
  const match = options.find((option) => option === value);
  if (match === undefined) {
    throw new RangeError(
      `${what} must be one of ${options.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return match;
}

/** An array of at most `max` strings, none repeated. */
export function distinctStrings(value: unknown, what: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new TypeError(`${what} must be an array of at most ${max} strings`);
  }
  const strings = value.map((item: unknown, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new TypeError(`${what}[${i}] must be a non-empty string, got ${JSON.stringify(item)}`);
    }
    return item;
  });
  if (new Set(strings).size !== strings.length) {
    throw new RangeError(`${what} repeats an entry: ${strings.join(', ')}`);
  }
  return strings;
}

/** A vector of three numbers, each within ±`limit`. */
export function vec3(
  value: unknown,
  what: string,
  limit: number,
): { x: number; y: number; z: number } {
  const v = fields(value, what, ['x', 'y', 'z']);
  return {
    x: numberIn(v.x, `${what}.x`, -limit, limit),
    y: numberIn(v.y, `${what}.y`, -limit, limit),
    z: numberIn(v.z, `${what}.z`, -limit, limit),
  };
}

/** How far a prop rotation's norm may be from 1; within it, it is renormalized. */
export const PROP_ROTATION_TOLERANCE = 1e-6;

/** A unit quaternion, renormalized from one within PROP_ROTATION_TOLERANCE of unit length. */
export function unitQuat(
  value: unknown,
  what: string,
): { x: number; y: number; z: number; w: number } {
  const q = fields(value, what, ['x', 'y', 'z', 'w']);
  const x = numberIn(q.x, `${what}.x`, -1, 1);
  const y = numberIn(q.y, `${what}.y`, -1, 1);
  const z = numberIn(q.z, `${what}.z`, -1, 1);
  const w = numberIn(q.w, `${what}.w`, -1, 1);
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(Math.abs(norm - 1) <= PROP_ROTATION_TOLERANCE)) {
    throw new RangeError(`${what} must be a unit quaternion, got norm ${norm}`);
  }
  return { x: x / norm, y: y / norm, z: z / norm, w: w / norm };
}
