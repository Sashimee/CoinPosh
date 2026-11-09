import type { ApiClient } from '../../net/index.ts';
import type { UpgradeApi } from './controller.ts';

/** Purchases go through the signed net client, which keeps the key across its retries. */
export function netUpgradeApi(client: Pick<ApiClient, 'call'>): UpgradeApi {
  return {
    buy: (body, idempotencyKey) => client.call('upgradesBuy', { body }, { idempotencyKey }),
  };
}
