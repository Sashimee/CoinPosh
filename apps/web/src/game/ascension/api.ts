import type { ApiClient } from '../../net/index.ts';
import type { AscensionApi } from './controller.ts';

/** Both calls go through the signed net client, which keeps the key across its own retries. */
export function netAscensionApi(client: Pick<ApiClient, 'call'>): AscensionApi {
  return {
    ascend: (body, idempotencyKey) => client.call('ascend', { body }, { idempotencyKey }),
    buyFamilyOffice: (body, idempotencyKey) =>
      client.call('upgradesBuy', { body }, { idempotencyKey }),
  };
}
