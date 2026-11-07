/**
 * 64-bit state digest built from two independent 32-bit Murmur3-style lanes.
 * Not cryptographic: it detects replay divergence, and the server never trusts it
 * as proof of value. Floats are hashed by their exact little-endian IEEE-754 bits,
 * so any divergence, however small, changes the digest.
 */
export class StateHasher {
  #a = 0x811c9dc5;
  #b = 0x01000193;
  #words = 0;
  readonly #scratch = new DataView(new ArrayBuffer(8));

  uint32(value: number): this {
    const k = value >>> 0;
    this.#a = mixLane(this.#a, k, 0xcc9e2d51, 0x1b873593);
    this.#b = mixLane(this.#b, k, 0x85ebca77, 0xc2b2ae3d);
    this.#words += 1;
    return this;
  }

  int(value: number): this {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`StateHasher.int needs a safe integer, got ${value}`);
    }
    return this.uint32(value >>> 0).uint32(Math.floor(value / 4294967296));
  }

  bool(value: boolean): this {
    return this.uint32(value ? 1 : 0);
  }

  float(value: number): this {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        `Sim state contains a non-finite number (${value}); the physics step has diverged`,
      );
    }
    this.#scratch.setFloat64(0, value, true);
    return this.uint32(this.#scratch.getUint32(0, true)).uint32(this.#scratch.getUint32(4, true));
  }

  vec3(v: { readonly x: number; readonly y: number; readonly z: number }): this {
    return this.float(v.x).float(v.y).float(v.z);
  }

  quat(q: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  }): this {
    return this.float(q.x).float(q.y).float(q.z).float(q.w);
  }

  /** 16 lowercase hex characters. */
  digest(): string {
    const a = fmix32((this.#a ^ this.#words) >>> 0);
    const b = fmix32((this.#b ^ Math.imul(this.#words, 0x9e3779b1)) >>> 0);
    return hex32(a) + hex32(b);
  }
}

function mixLane(h: number, word: number, c1: number, c2: number): number {
  let k = Math.imul(word, c1);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, c2);
  let next = h ^ k;
  next = (next << 13) | (next >>> 19);
  return (Math.imul(next, 5) + 0xe6546b64) >>> 0;
}

function fmix32(h: number): number {
  let x = h;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, '0');
}
