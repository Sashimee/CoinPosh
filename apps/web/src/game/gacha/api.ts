import type { ApiClient } from '../../net/index.ts';
import type { GachaApi } from './controller.ts';

/** The pull goes through the signed net client, which keeps the key across its own retries. */
export function netGachaApi(client: Pick<ApiClient, 'call'>): GachaApi {
  return {
    pull: (body, idempotencyKey) => client.call('gachaPull', { body }, { idempotencyKey }),
  };
}
