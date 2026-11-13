import { upgradeLines, upgradeStat } from '@coinposh/economy';
import {
  AccountNonceSchema,
  AccountSchema,
  EpochMsSchema,
  IDENTITY_PROVIDERS,
  IdTokenSchema,
  IdentityProviderSchema,
  PlayerIdSchema,
  SaveSummarySchema,
  type Account,
  type AccountLinkRequest,
  type AccountNonceResponse,
  type IdToken,
  type IdentityProvider,
  type NoncePurpose,
  type PlayerId,
  type ProgressChoice,
  type SaveSummary,
  type SignInRequest,
} from '@coinposh/shared';
import { z } from 'zod';
import { fromBase64Url, toBase64Url, utf8Bytes } from '../encoding.ts';
import { MockFailure, RestoreError, type MockPlayer, type MockWorld } from './world.ts';

/** The sessionStorage key the Demo account links live under, next to the world they point into. */
export const DEMO_ACCOUNT_STORAGE_KEY = 'coinposh.demo.account';
export const DEMO_ACCOUNT_SCHEMA_VERSION = 1;

/** Mirrors apps/server/src/auth/link/nonces.ts, so Demo play trips the same limits. */
export const MOCK_ACCOUNT_RULES = {
  nonceTtlMs: 10 * 60_000,
  maxOpenNoncesPerDevice: 6,
  idTokenTtlMs: 10 * 60_000,
  /** A token stamped further ahead of server time than this was not minted now. */
  issuedAtSkewMs: 60_000,
  eventsRetained: 500,
} as const;

/**
 * The fake identity provider behind Demo Mode. It never talks to Google or Apple: its tokens
 * name a demo issuer and audience, and nothing outside this tab accepts them.
 */
export const DEMO_IDENTITY = {
  audience: 'coinposh-demo',
  keyId: 'coinposh-demo-idp',
  issuer: (provider: IdentityProvider) => `https://demo-identity.coinposh.invalid/${provider}`,
  email: (provider: IdentityProvider, persona: string) =>
    `${persona}.${provider}@demo.coinposh.invalid`,
} as const;

const DemoClaimsSchema = z.strictObject({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1).max(255),
  nonce: z.string(),
  iat: z.int(),
  exp: z.int(),
  email: z.string().min(3).max(254).optional(),
});
export type DemoClaims = z.infer<typeof DemoClaimsSchema>;

const DemoHeaderSchema = z.strictObject({
  alg: z.literal('HS256'),
  typ: z.literal('JWT'),
  kid: z.literal(DEMO_IDENTITY.keyId),
});

const HMAC: HmacKeyGenParams = { name: 'HMAC', hash: 'SHA-256' };

function encodeSegment(value: unknown): string {
  return toBase64Url(utf8Bytes(JSON.stringify(value)));
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));
  } catch {
    return undefined;
  }
}

function invalidToken(message: string): MockFailure {
  return new MockFailure('invalid_id_token', message);
}

/** `l•••@gmail.com`, as the server masks it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

export interface VerifiedDemoToken {
  readonly subject: string;
  readonly nonce: string;
  readonly emailHint: string | null;
}

/**
 * Mints and checks HS256 ID tokens for the Demo provider with a key that lives only in this
 * page's WebCrypto. A reload draws a new key, so a token from an earlier page is refused.
 */
export class MockIdentityProvider {
  readonly #now: () => number;
  #key: Promise<CryptoKey> | null = null;

  constructor(now: () => number) {
    this.#now = now;
  }

  #signingKey(): Promise<CryptoKey> {
    this.#key ??= crypto.subtle.generateKey(HMAC, false, ['sign', 'verify']);
    return this.#key;
  }

  /**
   * What the Demo sign-in button returns. `persona` picks which fake person signs in, so a test
   * can stand for two people; `claims` lets a test mint a token a real provider never would.
   */
  async issue(
    provider: IdentityProvider,
    nonce: string,
    options: { readonly persona?: string; readonly claims?: Partial<DemoClaims> } = {},
  ): Promise<IdToken> {
    const persona = options.persona ?? 'demo';
    const issuedAt = Math.floor(this.#now() / 1000);
    const claims: DemoClaims = {
      iss: DEMO_IDENTITY.issuer(provider),
      aud: DEMO_IDENTITY.audience,
      sub: `demo-${provider}-${persona}`,
      nonce,
      iat: issuedAt,
      exp: issuedAt + MOCK_ACCOUNT_RULES.idTokenTtlMs / 1000,
      email: DEMO_IDENTITY.email(provider, persona),
      ...options.claims,
    };
    const signingInput = `${encodeSegment({ alg: 'HS256', typ: 'JWT', kid: DEMO_IDENTITY.keyId })}.${encodeSegment(claims)}`;
    const signature = await crypto.subtle.sign(
      HMAC,
      await this.#signingKey(),
      utf8Bytes(signingInput),
    );
    return IdTokenSchema.parse(`${signingInput}.${toBase64Url(new Uint8Array(signature))}`);
  }

  /** Checks signature, issuer, audience and lifetime against server time; the nonce is the caller's. */
  async verify(
    token: IdToken,
    provider: IdentityProvider,
    now: number,
  ): Promise<VerifiedDemoToken> {
    const [header = '', payload = '', signature = ''] = token.split('.');
    if (!DemoHeaderSchema.safeParse(decodeSegment(header)).success) {
      throw invalidToken('This ID token was not issued by the Demo sign-in. Sign in again.');
    }
    let signatureBytes: Uint8Array<ArrayBuffer>;
    try {
      signatureBytes = fromBase64Url(signature);
    } catch {
      throw invalidToken('This ID token signature is not base64url. Sign in again.');
    }
    const valid = await crypto.subtle.verify(
      HMAC,
      await this.#signingKey(),
      signatureBytes,
      utf8Bytes(`${header}.${payload}`),
    );
    if (!valid) throw invalidToken('This ID token signature does not verify. Sign in again.');
    const claims = DemoClaimsSchema.safeParse(decodeSegment(payload));
    if (!claims.success) throw invalidToken('This ID token is missing required claims.');
    const { iss, aud, sub, nonce, iat, exp, email } = claims.data;
    if (iss !== DEMO_IDENTITY.issuer(provider)) {
      throw invalidToken(`This ID token was issued for another provider than ${provider}.`);
    }
    if (aud !== DEMO_IDENTITY.audience) {
      throw invalidToken('This ID token was issued for another app. Sign in again.');
    }
    if (exp * 1000 <= now) throw invalidToken('This ID token has expired. Sign in again.');
    if (iat * 1000 > now + MOCK_ACCOUNT_RULES.issuedAtSkewMs) {
      throw invalidToken('This ID token claims to be issued in the future. Sign in again.');
    }
    return { subject: sub, nonce, emailHint: email === undefined ? null : maskEmail(email) };
  }
}

interface NonceRecord {
  readonly provider: IdentityProvider;
  readonly purpose: NoncePurpose;
  readonly device: string;
  readonly expiresAt: number;
  consumed: boolean;
}

interface IdentityRecord {
  readonly provider: IdentityProvider;
  readonly subject: string;
  readonly playerId: PlayerId;
  readonly linkedAt: number;
  readonly emailHint: string | null;
}

export const ACCOUNT_EVENT_KINDS = ['link', 'unlink', 'signin'] as const;

export interface AccountEvent {
  readonly kind: (typeof ACCOUNT_EVENT_KINDS)[number];
  readonly playerId: PlayerId;
  readonly provider: IdentityProvider;
  readonly device: string;
  readonly at: number;
}

const PersistedIdentitySchema = z.strictObject({
  provider: IdentityProviderSchema,
  subject: z.string().min(1).max(255),
  playerId: PlayerIdSchema,
  linkedAt: EpochMsSchema,
  emailHint: z.string().min(1).max(128).nullable(),
});

const PersistedAccountsSchema = z.strictObject({
  schema: z.literal(DEMO_ACCOUNT_SCHEMA_VERSION),
  identities: z.array(PersistedIdentitySchema),
  events: z.array(
    z.strictObject({
      kind: z.enum(ACCOUNT_EVENT_KINDS),
      playerId: PlayerIdSchema,
      provider: IdentityProviderSchema,
      device: z.string().min(1),
      at: EpochMsSchema,
    }),
  ),
});
export type PersistedAccounts = z.infer<typeof PersistedAccountsSchema>;

export type DecodedAccounts =
  | { readonly ok: true; readonly accounts: PersistedAccounts }
  | { readonly ok: false; readonly reason: string };

/** Never throws, like `decodeDemoBlob`: a bad blob is a reason to start unlinked, not a crash. */
export function decodeAccountsBlob(raw: string): DecodedAccounts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `it is not JSON (${String(error)})` };
  }
  const blob = PersistedAccountsSchema.safeParse(parsed);
  if (!blob.success) {
    const issue = blob.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || 'the root'}`;
    return { ok: false, reason: `its shape is invalid${where}: ${issue?.message ?? 'unknown'}` };
  }
  return { ok: true, accounts: blob.data };
}

export function encodeAccountsBlob(accounts: PersistedAccounts): string {
  return JSON.stringify(accounts);
}

function startingCoins(): number {
  const line = upgradeLines.find((candidate) => candidate.effect.stat === 'startingCoins');
  if (line === undefined) throw new Error('Economy config has no startingCoins upgrade line.');
  return upgradeStat(line, 0);
}

function vault(player: MockPlayer): number {
  let coins = player.wallet.coins;
  for (const record of player.coins.values()) {
    if (record.place === 'buffer') coins += record.coin.value;
  }
  return coins;
}

/** Same test as the server's `readSave`: anything beyond a fresh save's starting setup. */
function hasProgress(player: MockPlayer): boolean {
  return (
    player.drops > 0 ||
    player.wallet.goldBars > 0 ||
    [...player.levels.values()].some((level) => level > 0) ||
    vault(player) !== startingCoins()
  );
}

function saveSummary(player: MockPlayer): SaveSummary {
  return SaveSummarySchema.parse({
    playerId: player.id,
    venue: player.venueId,
    goldBars: player.wallet.goldBars,
    coins: vault(player),
    lastPlayedAt: Math.max(player.lastActiveAt, player.createdAt),
  });
}

export interface MockSignIn {
  readonly owner: MockPlayer;
  /** The signing device created this save as a guest, so its key needs no registration. */
  readonly firstDevice: boolean;
  readonly account: Account;
  readonly choice: ProgressChoice | undefined;
}

/**
 * Account links for the Demo world, with the server's rules (T-10.02): server-issued nonces
 * bound to one device, provider and purpose and spent once; one subject per save and one save
 * per subject; a sign-in hands out a session on the save the subject keeps and offers a choice
 * instead of ever merging two saves. No request carries a value: a link moves no coin.
 */
export class MockAccounts {
  readonly #world: MockWorld;
  readonly #identity: MockIdentityProvider;
  readonly #nonces = new Map<string, NonceRecord>();
  readonly #identities: IdentityRecord[] = [];
  readonly #events: AccountEvent[] = [];

  constructor(world: MockWorld, identity: MockIdentityProvider) {
    this.#world = world;
    this.#identity = identity;
  }

  get events(): readonly AccountEvent[] {
    return this.#events;
  }

  /** Nonces and their device bindings die with the page, like the client keys they are bound to. */
  serialize(): PersistedAccounts {
    return {
      schema: DEMO_ACCOUNT_SCHEMA_VERSION,
      identities: this.#identities.map((identity) => ({ ...identity })),
      events: this.#events.map((event) => ({ ...event })),
    };
  }

  /** Refuses links that point outside `world` or break one-subject-per-save. */
  static restore(
    data: PersistedAccounts,
    world: MockWorld,
    identity: MockIdentityProvider,
  ): MockAccounts {
    const accounts = new MockAccounts(world, identity);
    for (const saved of data.identities) {
      if (world.player(saved.playerId) === undefined) {
        throw new RestoreError(`a ${saved.provider} link names unknown player ${saved.playerId}`);
      }
      if (accounts.#bySubject(saved.provider, saved.subject) !== undefined) {
        throw new RestoreError(`the ${saved.provider} subject ${saved.subject} is linked twice`);
      }
      if (accounts.#byPlayer(saved.playerId, saved.provider) !== undefined) {
        throw new RestoreError(`player ${saved.playerId} holds two ${saved.provider} links`);
      }
      accounts.#identities.push({ ...saved });
    }
    for (const event of data.events) {
      if (world.player(event.playerId) === undefined) {
        throw new RestoreError(`an account event names unknown player ${event.playerId}`);
      }
      accounts.#events.push({ ...event });
    }
    return accounts;
  }

  account(playerId: PlayerId): Account {
    return AccountSchema.parse({
      playerId,
      identities: this.#identities
        .filter((identity) => identity.playerId === playerId)
        .sort((a, b) => a.linkedAt - b.linkedAt || a.provider.localeCompare(b.provider))
        .map((identity) => ({
          provider: identity.provider,
          linkedAt: identity.linkedAt,
          ...(identity.emailHint === null ? {} : { emailHint: identity.emailHint }),
        })),
      available: [...IDENTITY_PROVIDERS],
    });
  }

  issueNonce(input: {
    readonly provider: IdentityProvider;
    readonly purpose: NoncePurpose;
    readonly device: string;
    readonly now: number;
  }): AccountNonceResponse {
    const { now, device } = input;
    for (const [nonce, record] of this.#nonces) {
      if (record.expiresAt <= now) this.#nonces.delete(nonce);
    }
    const open = [...this.#nonces.values()].filter(
      (record) => record.device === device && !record.consumed,
    );
    if (open.length >= MOCK_ACCOUNT_RULES.maxOpenNoncesPerDevice) {
      const firstExpiry = Math.min(...open.map((record) => record.expiresAt));
      throw new MockFailure(
        'rate_limited',
        'Too many sign-in attempts from this device. Finish or wait for one to expire.',
        Math.max(1000, firstExpiry - now),
      );
    }
    const nonce = AccountNonceSchema.parse(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
    const expiresAt = now + MOCK_ACCOUNT_RULES.nonceTtlMs;
    this.#nonces.set(nonce, {
      provider: input.provider,
      purpose: input.purpose,
      device,
      expiresAt,
      consumed: false,
    });
    return { nonce, expiresAt };
  }

  async link(
    player: MockPlayer,
    body: AccountLinkRequest,
    device: string,
    now: number,
  ): Promise<Account> {
    const token = await this.#verified(body.provider, body.idToken, body.nonce, now);
    this.#spend(body.nonce, body.provider, 'link', device, now);
    const owner = this.#bySubject(body.provider, token.subject);
    if (owner?.playerId === player.id) return this.account(player.id);
    const label = providerLabel(body.provider);
    if (owner !== undefined) {
      throw new MockFailure(
        'identity_in_use',
        `This ${label} account already keeps another CoinPosh save. Sign in with it instead, or link a different ${label} account.`,
      );
    }
    if (this.#byPlayer(player.id, body.provider) !== undefined) {
      throw new MockFailure(
        'identity_in_use',
        `This save is already linked to a different ${label} account. Unlink it first to switch.`,
      );
    }
    this.#identities.push({
      provider: body.provider,
      subject: token.subject,
      playerId: player.id,
      linkedAt: now,
      emailHint: token.emailHint,
    });
    this.#record({ kind: 'link', playerId: player.id, provider: body.provider, device, at: now });
    return this.account(player.id);
  }

  async signIn(body: SignInRequest, device: string, now: number): Promise<MockSignIn> {
    const token = await this.#verified(body.provider, body.idToken, body.nonce, now);
    this.#spend(body.nonce, body.provider, 'signin', device, now);
    const identity = this.#bySubject(body.provider, token.subject);
    const owner = identity === undefined ? undefined : this.#world.player(identity.playerId);
    if (owner === undefined) {
      throw new MockFailure(
        'not_found',
        `No CoinPosh save is linked to this ${providerLabel(body.provider)} account yet. Play as a guest and link it from Settings to keep your progress.`,
      );
    }
    const guest = this.#world.playerByDevice(device);
    let choice: ProgressChoice | undefined;
    if (
      guest !== undefined &&
      guest.id !== owner.id &&
      !this.#isLinked(guest.id) &&
      hasProgress(guest)
    ) {
      choice = { guest: saveSummary(guest), account: saveSummary(owner) };
    }
    this.#record({ kind: 'signin', playerId: owner.id, provider: body.provider, device, at: now });
    return {
      owner,
      firstDevice: guest?.id === owner.id,
      account: this.account(owner.id),
      choice,
    };
  }

  /** Idempotent: unlinking a provider the save does not hold changes nothing. */
  unlink(player: MockPlayer, provider: IdentityProvider, device: string, now: number): Account {
    const index = this.#identities.findIndex(
      (identity) => identity.playerId === player.id && identity.provider === provider,
    );
    if (index >= 0) {
      this.#identities.splice(index, 1);
      this.#record({ kind: 'unlink', playerId: player.id, provider, device, at: now });
    }
    return this.account(player.id);
  }

  async #verified(
    provider: IdentityProvider,
    idToken: IdToken,
    nonce: string,
    now: number,
  ): Promise<VerifiedDemoToken> {
    const token = await this.#identity.verify(idToken, provider, now);
    if (token.nonce !== nonce) {
      throw invalidToken(
        `This ${providerLabel(provider)} sign-in was not made for the nonce sent with it. Start the sign-in again.`,
      );
    }
    return token;
  }

  #spend(
    nonce: string,
    provider: IdentityProvider,
    purpose: NoncePurpose,
    device: string,
    now: number,
  ): void {
    const record = this.#nonces.get(nonce);
    if (record === undefined || record.expiresAt <= now) {
      throw invalidToken('This sign-in nonce is unknown or expired. Request a new one and retry.');
    }
    if (record.provider !== provider || record.purpose !== purpose) {
      throw invalidToken('This nonce was issued for a different sign-in. Request a new one.');
    }
    if (record.device !== device) throw invalidToken('This nonce was issued to another device.');
    if (record.consumed) {
      throw invalidToken('This sign-in was already used. Request a new nonce and sign in again.');
    }
    record.consumed = true;
  }

  #bySubject(provider: IdentityProvider, subject: string): IdentityRecord | undefined {
    return this.#identities.find(
      (identity) => identity.provider === provider && identity.subject === subject,
    );
  }

  #byPlayer(playerId: PlayerId, provider: IdentityProvider): IdentityRecord | undefined {
    return this.#identities.find(
      (identity) => identity.playerId === playerId && identity.provider === provider,
    );
  }

  #isLinked(playerId: PlayerId): boolean {
    return this.#identities.some((identity) => identity.playerId === playerId);
  }

  #record(event: AccountEvent): void {
    this.#events.push(event);
    if (this.#events.length > MOCK_ACCOUNT_RULES.eventsRetained) this.#events.shift();
  }
}

function providerLabel(provider: IdentityProvider): string {
  return provider === 'google' ? 'Demo Google' : 'Demo Apple';
}
