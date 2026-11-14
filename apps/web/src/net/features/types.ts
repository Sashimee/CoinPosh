import type {
  Currency,
  EndpointBody,
  EndpointName,
  EndpointParams,
  EndpointResponseInput,
  StateQuery,
  Wallet,
} from '@coinposh/shared';
import type { GrantReason, MockPlayer } from '../mock/world.ts';

/**
 * What a Demo feature handler may touch: the signed-in player, server time, its own slot in the
 * persisted world and the ledger. Nothing here reads the request beyond its validated input, so
 * a feature cannot trust a value the client sent.
 *
 * Writes are held until the handler returns an answer that meets the endpoint's response
 * contract; then the state and every grant land together. A handler that throws (a
 * `MockFailure` included) or answers off contract pays nothing and records nothing, so a retry
 * is never paid twice.
 */
export interface MockFeatureContext {
  /** The player as the request found them: `player.wallet` leaves out held grants. */
  readonly player: MockPlayer;
  /** Server time for this request, never a timestamp the client sent. */
  readonly now: number;
  /**
   * A fresh copy of this request's held state, else of what this feature last stored, else
   * undefined. The blob lives in storage the page can edit, so parse it before trusting its
   * shape.
   */
  state(): unknown;
  /**
   * Holds the feature's next state, stored with the world in the same write as the ledger its
   * grants credit. Anything but plain JSON data fails the request, naming the feature.
   */
  setState(value: unknown): void;
  /** Holds a reward for the world's ledger; amounts must be whole and never negative. */
  grant(reason: GrantReason, delta: Partial<Record<Currency, number>>, ref?: string | null): void;
  /** The player's wallet with this request's held grants added: the one to answer with. */
  wallet(): Wallet;
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
 * place of the built-in route of that name, and a theme endpoint has no built-in route, so its
 * feature must be registered before the Demo can serve it.
 */
export interface MockFeature {
  readonly id: string;
  readonly handlers: MockFeatureHandlers;
}
