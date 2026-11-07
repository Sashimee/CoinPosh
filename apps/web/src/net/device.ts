import {
  DevicePublicKeySchema,
  DeviceSignatureSchema,
  type DevicePublicKey,
  type DeviceSignature,
} from '@coinposh/shared';
import { toBase64Url, utf8Bytes } from './encoding.ts';
import type { KeyValueStore } from './store.ts';

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const STORE_KEY = 'device-key';

/** The device identity every request is signed with. The private key never leaves WebCrypto. */
export interface DeviceKey {
  readonly publicKey: DevicePublicKey;
  sign(message: string): Promise<DeviceSignature>;
}

function isDeviceKeyPair(value: unknown): value is CryptoKeyPair {
  if (typeof value !== 'object' || value === null) return false;
  const { privateKey, publicKey } = value as Partial<CryptoKeyPair>;
  return (
    privateKey instanceof CryptoKey &&
    publicKey instanceof CryptoKey &&
    privateKey.algorithm.name === 'ECDSA' &&
    !privateKey.extractable &&
    privateKey.usages.includes('sign')
  );
}

async function fromPair(pair: CryptoKeyPair): Promise<DeviceKey> {
  const publicKey = DevicePublicKeySchema.parse(
    await crypto.subtle.exportKey('jwk', pair.publicKey),
  );
  return {
    publicKey,
    async sign(message) {
      // WebCrypto emits IEEE P1363 (r ‖ s), which is exactly the wire format the server verifies.
      const signature = await crypto.subtle.sign(
        SIGN_ALGORITHM,
        pair.privateKey,
        utf8Bytes(message),
      );
      return DeviceSignatureSchema.parse(toBase64Url(new Uint8Array(signature)));
    },
  };
}

/** Reuses the stored key pair, or creates and stores a fresh non-extractable one. */
export async function loadOrCreateDeviceKey(store: KeyValueStore): Promise<DeviceKey> {
  const stored = await store.get(STORE_KEY);
  if (isDeviceKeyPair(stored)) return fromPair(stored);
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ['sign', 'verify']);
  await store.set(STORE_KEY, pair);
  return fromPair(pair);
}
