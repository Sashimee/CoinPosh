import {
  QuestClaimResponseSchema,
  QuestsResponseSchema,
  SeasonResponseSchema,
  type IdempotencyKey,
  type QuestId,
} from '@coinposh/shared';
import type { SeasonData } from './model.ts';

interface QuestsSource {
  call(name: 'quests'): Promise<unknown>;
}

interface SeasonSource {
  call(name: 'season'): Promise<unknown>;
}

interface QuestClaimSource {
  call(
    name: 'questsClaim',
    input: { readonly body: { readonly questId: QuestId } },
    options: { readonly idempotencyKey: IdempotencyKey },
  ): Promise<unknown>;
}

/**
 * An intersection rather than one interface with overloads: the app's generic
 * `ApiClient.call` is checked against each signature on its own, and an overload set it is not.
 */
export type SeasonClient = QuestsSource & SeasonSource & QuestClaimSource;

/**
 * Quests and the season over `GET /v1/quests`, `POST /v1/quests/claim` and `GET /v1/season`
 * (Demo Mode's mock answers them too). Responses are parsed here as well as in the client, so
 * a malformed answer fails loudly at this boundary.
 */
export function apiSeasonData(client: SeasonClient): SeasonData {
  return {
    async quests() {
      return QuestsResponseSchema.parse(await client.call('quests'));
    },
    async claim(questId, idempotencyKey) {
      return QuestClaimResponseSchema.parse(
        await client.call('questsClaim', { body: { questId } }, { idempotencyKey }),
      );
    },
    async season() {
      return SeasonResponseSchema.parse(await client.call('season'));
    },
  };
}
