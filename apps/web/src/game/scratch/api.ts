import type { ApiClient } from '../../net/index.ts';
import type { ScratchApi } from './controller.ts';

/** The reveal goes through the signed net client, which keeps the key across its own retries. */
export function netScratchApi(client: Pick<ApiClient, 'call'>): ScratchApi {
  return {
    reveal: (body, idempotencyKey) => client.call('scratchReveal', { body }, { idempotencyKey }),
  };
}
