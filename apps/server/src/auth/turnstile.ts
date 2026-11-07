import { z } from 'zod';
import { ApiFailure } from '../http/errors.ts';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SiteverifyResponseSchema = z.object({ success: z.boolean() });

const TurnstileModeSchema = z.enum(['enforce', 'off']).default('enforce');

/** Fails closed: only an explicit `TURNSTILE_MODE: "off"` (dev and tests) skips the check. */
export async function verifyTurnstile(
  mode: string | undefined,
  secret: string | undefined,
  token: string,
  remoteIp: string | undefined,
  idempotencyKey: string,
): Promise<void> {
  const parsedMode = TurnstileModeSchema.safeParse(mode);
  if (!parsedMode.success) {
    throw new ApiFailure(
      'unavailable',
      `TURNSTILE_MODE must be "enforce" or "off", got "${mode}". Fix the wrangler var.`,
    );
  }
  if (parsedMode.data === 'off') return;
  if (secret === undefined || secret === '') {
    throw new ApiFailure(
      'unavailable',
      'TURNSTILE_SECRET_KEY is not configured: set it with `wrangler secret put TURNSTILE_SECRET_KEY`.',
    );
  }

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  form.append('idempotency_key', idempotencyKey);
  if (remoteIp !== undefined) form.append('remoteip', remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
  } catch {
    throw new ApiFailure('unavailable', 'Turnstile verification is unreachable. Retry shortly.', {
      retryAfterMs: 5_000,
    });
  }
  const result = SiteverifyResponseSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !result.success) {
    throw new ApiFailure('unavailable', 'Turnstile verification failed upstream. Retry shortly.', {
      retryAfterMs: 5_000,
    });
  }
  if (!result.data.success) {
    throw new ApiFailure('forbidden', 'The Turnstile challenge was not passed. Solve it again.');
  }
}
