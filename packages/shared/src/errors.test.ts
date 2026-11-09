import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DropRequestSchema } from './api/table.ts';
import {
  ERROR_CODES,
  ERROR_STATUS,
  ErrorEnvelopeSchema,
  errorEnvelope,
  errorStatus,
  validationErrorEnvelope,
} from './errors.ts';
import { roundTrip } from './test/roundTrip.ts';

describe('ErrorEnvelopeSchema', () => {
  it('round-trips a minimal envelope', () => {
    const envelope = { error: { code: 'not_found', message: 'No such route.' } };
    const { parsed, reparsed } = roundTrip(ErrorEnvelopeSchema, envelope);
    expect(parsed).toEqual(envelope);
    expect(reparsed).toEqual(parsed);
  });

  it('round-trips an envelope with every optional field', () => {
    const envelope = {
      error: {
        code: 'rate_limited',
        message: 'Too many drops; slow down.',
        requestId: 'req_01JC8X',
        retryAfterMs: 1_500,
        issues: [{ path: ['claims', 0, 'coinId'], message: 'Expected a CoinId.' }],
      },
    };
    const { parsed, reparsed } = roundTrip(ErrorEnvelopeSchema, envelope);
    expect(parsed).toEqual(envelope);
    expect(reparsed).toEqual(parsed);
  });

  it('matches the shape the server already returns for unknown routes', () => {
    const fromServer = { error: { code: 'not_found', message: 'No such route.' } };
    expect(ErrorEnvelopeSchema.safeParse(fromServer).success).toBe(true);
  });

  it.each([
    ['an unknown code', { error: { code: 'teapot', message: 'x' } }],
    ['an empty message', { error: { code: 'internal', message: '' } }],
    ['a bare error string', { error: 'boom' }],
    ['a negative retry delay', { error: { code: 'rate_limited', message: 'x', retryAfterMs: -1 } }],
  ])('rejects %s', (_label, value) => {
    expect(ErrorEnvelopeSchema.safeParse(value).success).toBe(false);
  });
});

describe('error codes', () => {
  it('map every code to a 4xx or 5xx status', () => {
    for (const code of ERROR_CODES) {
      const status = errorStatus(code);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
    expect(ERROR_CODES).toHaveLength(Object.keys(ERROR_STATUS).length);
  });

  it('follow the idempotency-key draft for reuse and in-flight conflicts', () => {
    expect(errorStatus('idempotency_key_missing')).toBe(400);
    expect(errorStatus('idempotency_in_progress')).toBe(409);
    expect(errorStatus('idempotency_key_reused')).toBe(422);
  });

  it('answer a fenced tab and an out-of-order table snapshot with 409', () => {
    expect(errorStatus('session_superseded')).toBe(409);
    expect(errorStatus('stale_snapshot')).toBe(409);
    const envelope = errorEnvelope('session_superseded', 'This table is open elsewhere.');
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });
});

describe('errorEnvelope', () => {
  it('builds a valid envelope and keeps the extras', () => {
    const envelope = errorEnvelope('insufficient_funds', 'Not enough coins to drop.', {
      requestId: 'req_1',
    });
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual({
      error: {
        code: 'insufficient_funds',
        message: 'Not enough coins to drop.',
        requestId: 'req_1',
      },
    });
  });
});

describe('validationErrorEnvelope', () => {
  it('turns zod issues into JSON-safe paths and messages', () => {
    const result = DropRequestSchema.safeParse({ x: 3, tick: -1, value: 9 });
    if (result.success) {
      throw new Error('Expected the forged drop to fail validation.');
    }
    const envelope = validationErrorEnvelope(result.error);
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.issues?.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([['x'], ['tick'], []]),
    );
  });

  it('stringifies symbol path keys', () => {
    const key = Symbol('slot');
    const error = new z.ZodError([{ code: 'custom', path: [key, 2], message: 'bad', input: 0 }]);
    expect(validationErrorEnvelope(error).error.issues).toEqual([
      { path: ['Symbol(slot)', 2], message: 'bad' },
    ]);
  });
});
