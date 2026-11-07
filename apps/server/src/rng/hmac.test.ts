import { describe, expect, it } from 'vitest';
import { utf8 } from '../crypto.ts';
import { hmacSha256, sha256, toHex } from './hmac.ts';

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function webCryptoHmac(key: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>) {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', imported, message)));
}

/** Small deterministic byte source so failures reproduce. */
function bytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

describe('sha256', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(toHex(sha256(utf8('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(toHex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(toHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with WebCrypto at every padding boundary', async () => {
    for (const length of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const message = bytes(length, length);
      const expected = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', message)));
      expect(toHex(sha256(message)), `length ${length}`).toBe(expected);
    }
  });
});

describe('hmacSha256', () => {
  it('matches RFC 4231 test cases 1, 2 and 6 (key longer than a block)', () => {
    expect(toHex(hmacSha256(new Uint8Array(20).fill(0x0b), utf8('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    expect(toHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(
      toHex(
        hmacSha256(
          new Uint8Array(131).fill(0xaa),
          utf8('Test Using Larger Than Block-Size Key - Hash Key First'),
        ),
      ),
    ).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });

  it('agrees with WebCrypto for short, block-sized and long keys and messages', async () => {
    for (const [keyLength, messageLength] of [
      [1, 0],
      [32, 17],
      [64, 64],
      [65, 200],
      [200, 1],
    ] as const) {
      const key = bytes(keyLength, keyLength * 7 + 1);
      const message = bytes(messageLength, messageLength * 13 + 2);
      expect(toHex(hmacSha256(key, message)), `key ${keyLength}, message ${messageLength}`).toBe(
        await webCryptoHmac(key, message),
      );
    }
  });

  it('changes completely when one key or message bit flips', () => {
    const key = hexBytes('00'.repeat(32));
    const flipped = hexBytes(`01${'00'.repeat(31)}`);
    const message = utf8('client:0');
    expect(toHex(hmacSha256(key, message))).not.toBe(toHex(hmacSha256(flipped, message)));
    expect(toHex(hmacSha256(key, message))).not.toBe(toHex(hmacSha256(key, utf8('client:1'))));
  });
});
