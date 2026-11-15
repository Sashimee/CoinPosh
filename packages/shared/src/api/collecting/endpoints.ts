import { get, post, type Endpoint } from '../endpoint.ts';
import {
  CellarKeepRequestSchema,
  CellarKeepResponseSchema,
  CellarRackRequestSchema,
  CellarRackResponseSchema,
  CellarResponseSchema,
  CellarSellRequestSchema,
  CellarSellResponseSchema,
} from './cellar.ts';
import { CollectionResponseSchema } from './collection.ts';
import { LoungeArrangeRequestSchema, LoungeResponseSchema } from './lounge.ts';

// TODO(lead-architect): pass to `composeEndpoints` in `../endpoints.ts` in T-11.15, the same
// change that adds their fixtures to `test/fixtures.ts` and their Demo handlers; both are mapped
// over every EndpointName, so registering them first breaks their typecheck. Prizes and variants
// ride the table routes (`TableSnapshotSchema.prizes`, `ClaimWithPrizeSchema`), not this map.
/** Collecting (M11): the book, the trophy lounge and the wine cellar. */
export const collectingEndpoints = {
  collectingCollection: get('/v1/collecting/collection', CollectionResponseSchema),
  collectingLounge: get('/v1/collecting/lounge', LoungeResponseSchema),
  collectingLoungeArrange: post(
    '/v1/collecting/lounge/arrange',
    LoungeArrangeRequestSchema,
    LoungeResponseSchema,
  ),
  collectingCellar: get('/v1/collecting/cellar', CellarResponseSchema),
  collectingCellarSell: post(
    '/v1/collecting/cellar/sell',
    CellarSellRequestSchema,
    CellarSellResponseSchema,
  ),
  collectingCellarKeep: post(
    '/v1/collecting/cellar/keep',
    CellarKeepRequestSchema,
    CellarKeepResponseSchema,
  ),
  collectingCellarRack: post(
    '/v1/collecting/cellar/rack',
    CellarRackRequestSchema,
    CellarRackResponseSchema,
  ),
} as const satisfies Record<string, Endpoint>;

export type CollectingEndpoints = typeof collectingEndpoints;
export type CollectingEndpointName = keyof CollectingEndpoints;
export const COLLECTING_ENDPOINT_NAMES = Object.keys(
  collectingEndpoints,
) as CollectingEndpointName[];
