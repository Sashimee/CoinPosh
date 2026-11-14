import type {
  Currency,
  EndpointBody,
  EndpointName,
  EndpointParams,
  EndpointResponseInput,
  StateQuery,
} from '@coinposh/shared';
import type { GrantReason, MockPlayer } from '../mock/world.ts';

/**
 * What a Demo feature handler may touch: the signed-in player, server time, its own slot in the
 * persisted world and the ledger. Nothing here reads the request beyond its validated input, so
 * a feature cannot trust a value the client sent.
 */
export interface MockFeatureContext {
  readonly player: MockPlayer;
  /** Server time for this request, never a timestamp the client sent. */
  readonly now: number;
  /**
   * A fresh copy of what this feature last stored, or undefined when it stored none. The blob
   * lives in storage the page can edit, so parse it before trusting its shape.
   */
  state(): unknown;
  /** Stored with the world, in the same write as the ledger the feature's grants credit. */
  setState(value: unknown): void;
  /** Pays a reward through the world's ledger; amounts must be positive. */
  grant(reason: GrantReason, delta: Partial<Record<Currency, number>>, ref?: string | null): void;
}

/** The request after the server's pipeline: signed, authenticated, rate-checked and validated. */
export interface MockFeatureInput<N extends EndpointName> {
  readonly body: EndpointBody<N>;
  readonly params: EndpointParams<N>;
  readonly query: StateQuery;
}

/** Throw `MockFailure` to refuse with an error envelope, as a built-in route does. */
export type MockFeatureHandler<N extends EndpointName> = (
  ctx: MockFeatureContext,
  input: MockFeatureInput<N>,
) => EndpointResponseInput<N> | Promise<EndpointResponseInput<N>>;

export type MockFeatureHandlers = { readonly [N in EndpointName]?: MockFeatureHandler<N> };

/**
 * One theme's Demo Mode server half. `id` names its slot in the persisted world (lowercase
 * letters, digits, ".", "_" or "-", starting with a letter); each endpoint it handles runs in
 * place of the built-in route of that name.
 */
export interface MockFeature {
  readonly id: string;
  readonly handlers: MockFeatureHandlers;
}
