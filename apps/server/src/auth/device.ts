import {
  canonicalRequest,
  DeviceSignatureSchema,
  type DevicePublicKey,
  type SignedRequestParts,
} from '@coinposh/shared';
import { base64UrlDecode, base64UrlEncode, utf8 } from '../crypto.ts';
import { ApiFailure } from '../http/errors.ts';

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** RFC 7638 thumbprint: SHA-256 of the required members in lexicographic order. */
export async function deviceKeyThumbprint(key: DevicePublicKey): Promise<string> {
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(canonical))));
}

async function importDeviceKey(key: DevicePublicKey): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'jwk',
      { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
      ECDSA_P256,
      false,
      ['verify'],
    );
  } catch {
    throw new ApiFailure('invalid_signature', 'The device public key is not a valid P-256 point.');
  }
}

/** Verifies the `X-CoinPosh-Signature` header over the shared canonical request bytes. */
export async function verifyDeviceSignature(
  key: DevicePublicKey,
  parts: SignedRequestParts,
  signatureHeader: string | undefined,
): Promise<void> {
  if (signatureHeader === undefined) {
    throw new ApiFailure(
      'invalid_signature',
      'Missing X-CoinPosh-Signature: sign every request with the device key.',
    );
  }
  const parsed = DeviceSignatureSchema.safeParse(signatureHeader);
  if (!parsed.success) {
    throw new ApiFailure(
      'invalid_signature',
      'X-CoinPosh-Signature must be a 64-byte P1363 ECDSA P-256 signature as base64url.',
    );
  }
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importDeviceKey(key),
    base64UrlDecode(parsed.data),
    utf8(canonicalRequest(parts)),
  );
  if (!valid) {
    throw new ApiFailure(
      'invalid_signature',
      'The device signature does not match this request and key.',
    );
  }
}
