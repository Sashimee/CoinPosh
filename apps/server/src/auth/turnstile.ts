import { z } from 'zod';
import { ApiFailure } from '../http/errors.ts';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SiteverifyResponseSchema = z.object({ success: z.boolean() });

export async function verifyTurnstile(
  secret: string | undefined,
  token: string,
  remoteIp: string | undefined,
  idempotencyKey: string,
): Promise<void> {
  // Turnstile is a human provisioning step (site + secret); until the secret exists the
  // device signature and single-use auth keys are the only sign-up gate.
  if (secret === undefined || secret === '') return;

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
