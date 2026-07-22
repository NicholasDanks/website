/**
 * A faithful re-implementation of R's default random number generator:
 * Mersenne-Twister for uniforms, and the post-3.6.0 "Rejection" sampler for
 * discrete draws.
 *
 * Why this exists: the congruence bootstrap resamples rows, so the confidence
 * intervals depend on the exact stream of random indices. Reproducing R's
 * stream bit-for-bit means `set.seed(123)` in R and `new RRNG(123)` here draw
 * the *same* rows, so this app's numbers are identical to the published R
 * implementation's rather than merely close to them.
 *
 * Verified against R 4.6.0 in test/parity.mjs.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

/** R's i2_32m1: 1/(2^32 - 1) is NOT used; MT_genrand scales by 2.3283064365386963e-10. */
const TWO_POW_32_INV = 2.3283064365386963e-10;

export class RRNG {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: number) {
    this.setSeed(seed);
  }

  /**
   * Mirrors R's `set.seed()` for Mersenne-Twister: scramble the seed 50 times
   * with the LCG 69069*x+1, then fill the 625-word seed vector with the same
   * LCG. Word 0 is the position counter (fixed to 624 by R's FixupSeeds, which
   * forces a fresh block on the first draw); words 1..624 are the MT state.
   */
  private setSeed(inseed: number): void {
    let seed = inseed >>> 0;
    for (let j = 0; j < 50; j++) seed = (Math.imul(69069, seed) + 1) >>> 0;
    // i_seed[0] is the counter and is overwritten by FixupSeeds, but R still
    // advances the LCG for it — so we must burn one step here to stay in phase.
    seed = (Math.imul(69069, seed) + 1) >>> 0;
    for (let j = 0; j < N; j++) {
      seed = (Math.imul(69069, seed) + 1) >>> 0;
      this.mt[j] = seed;
    }
    this.mti = N; // FixupSeeds: I624 = 624
  }

  /** Raw 32-bit MT output, tempered. */
  private genrandInt32(): number {
    let y: number;
    if (this.mti >= N) {
      let kk: number;
      for (kk = 0; kk < N - M; kk++) {
        y = ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
        this.mt[kk] = (this.mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        y = ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
        this.mt[kk] =
          (this.mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      y = ((this.mt[N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK)) >>> 0;
      this.mt[N - 1] = (this.mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    y = this.mt[this.mti++];
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y >>> 0;
  }

  /**
   * R's unif_rand() for MT, including the `fixup` clamp that keeps the value
   * strictly inside (0, 1).
   */
  unifRand(): number {
    const v = this.genrandInt32() * TWO_POW_32_INV;
    // R's fixup(): ensure in (0,1)
    if (v <= 0) return 0.5 * 2.328306437080797e-10;
    if (1 - v <= 0) return 1 - 0.5 * 2.328306437080797e-10;
    return v;
  }

  /** R's rbits(): assemble `bits` random bits, 16 at a time. */
  private rbits(bits: number): number {
    let v = 0;
    for (let n = 0; n <= bits; n += 16) {
      const v1 = Math.floor(this.unifRand() * 65536);
      v = 65536 * v + v1;
    }
    // Mask down to the requested width. Uses BigInt-free math: bits <= 53 here
    // because n is a row count, so 2^bits is exactly representable.
    return v % Math.pow(2, bits);
  }

  /**
   * R's R_unif_index(dn) under the default "Rejection" sample.kind: draw
   * ceil(log2(dn)) bits and reject anything >= dn.
   */
  unifIndex(dn: number): number {
    if (dn <= 0) return 0;
    const bits = Math.ceil(Math.log2(dn));
    let dv: number;
    do {
      dv = this.rbits(bits);
    } while (dn <= dv);
    return dv;
  }

  /** Equivalent to R's `sample.int(n, size, replace = TRUE)`, returned 0-based. */
  sampleIntReplace(n: number, size: number): Int32Array {
    const out = new Int32Array(size);
    for (let i = 0; i < size; i++) out[i] = this.unifIndex(n);
    return out;
  }
}
