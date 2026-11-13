import type { ApiClient } from '../../net/index.ts';
import type { SafesApi } from './controller.ts';

/** The open goes through the signed net client, which keeps the key across its own retries. */
export function netSafesApi(client: Pick<ApiClient, 'call'>): SafesApi {
  return {
    open: (body, idempotencyKey) => client.call('safesOpen', { body }, { idempotencyKey }),
  };
}
