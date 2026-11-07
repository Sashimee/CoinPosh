import type { z } from 'zod';

/** Parses `value`, sends it through JSON as the wire would, and parses it again. */
export function roundTrip<S extends z.ZodType>(
  schema: S,
  value: unknown,
): { parsed: z.output<S>; reparsed: z.output<S> } {
  const parsed = schema.parse(value);
  const wire: unknown = JSON.parse(JSON.stringify(parsed));
  return { parsed, reparsed: schema.parse(wire) };
}
