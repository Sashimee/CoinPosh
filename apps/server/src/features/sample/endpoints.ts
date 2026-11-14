import { get, post, WalletSchema } from '@coinposh/shared';
import { z } from 'zod';

export const SAMPLE_SEALS = ['wax', 'gilt', 'onyx'] as const;

export const SampleStampSchema = z.strictObject({
  id: z.uuid(),
  motto: z.string(),
  seal: z.enum(SAMPLE_SEALS),
  at: z.number().int().nonnegative(),
});

export const SampleBookSchema = z.strictObject({
  stamps: z.array(SampleStampSchema),
});

/** Test-only contract for the sample feature, defined locally the way a theme map is. */
export const sampleEndpoints = {
  sampleBook: get('/v1/sample/book', SampleBookSchema),
  sampleStamp: post(
    '/v1/sample/stamp',
    z.strictObject({ motto: z.string().min(1).max(40) }),
    z.strictObject({ stamp: SampleStampSchema, book: SampleBookSchema, wallet: WalletSchema }),
  ),
} as const;
