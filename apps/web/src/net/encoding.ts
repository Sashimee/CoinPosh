import type { Sha256Hex } from '@coinposh/shared';

const utf8 = new TextEncoder();
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return utf8.encode(text);
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export async function sha256Hex(text: string): Promise<Sha256Hex> {
  const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(text));
  return toHex(new Uint8Array(digest));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error('fromBase64Url: input is not unpadded base64url.');
  }
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Unbiased random base62 from the platform CSPRNG, for entity IDs and opaque tokens. */
export function randomBase62(length: number): string {
  const out: string[] = [];
  const limit = 256 - (256 % BASE62.length);
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out.push(BASE62[byte % BASE62.length] ?? '0');
    }
  }
  return out.join('');
}
