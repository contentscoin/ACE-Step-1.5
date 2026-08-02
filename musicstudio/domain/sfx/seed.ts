/**
 * Seeds for the variants of one request (Requirements 22.5, 22.8, 22.13).
 *
 * Three criteria meet here and they pull in different directions, so the resolution is
 * worth stating plainly:
 *
 * - **22.5** wants the variants of one request to use *different* seeds, or the engine
 *   would be asked the same question `variantCount` times.
 * - **22.8** wants a re-request with the same seed to produce sample-identical audio.
 * - **22.13** wants a seed drawn when the caller named none, and recorded.
 *
 * A per-variant random draw satisfies 22.5 and 22.13 and breaks 22.8: the caller names
 * one seed and gets `variantCount` outputs, so the seed they named cannot be the seed of
 * all of them, and re-requesting would redraw the rest. So the variant seeds are
 * *derived* from the base seed by a pure function. One seed in, `variantCount` distinct
 * seeds out, deterministically — which makes 22.8 a property of arithmetic rather than a
 * promise about a random number generator, and leaves 22.13's randomness confined to the
 * single case where no seed was named at all.
 *
 * Distinctness is exact, not probable. `SEED_STRIDE` is odd and the modulus is a power of
 * two, so the stride is invertible in the ring: `i · stride mod 2^31` takes a different
 * value for every distinct `i`, and adding the base is a bijection. Every one of the at
 * most 8 variants (22.16) therefore gets a different seed, for every base seed, with no
 * collision check and no retry loop.
 */

import { SFX_SEED_MAX, SFX_SEED_MIN } from './bounds';

/**
 * Size of the seed space: `SFX_SEED_MAX` is inclusive, so the count is one more.
 *
 * 2^31 exactly, which is what makes the odd-stride argument above hold.
 */
export const SFX_SEED_SPACE = SFX_SEED_MAX - SFX_SEED_MIN + 1;

/**
 * Step between consecutive variant seeds.
 *
 * Odd, so it is invertible modulo 2^31 (see the module comment). Large and irregular
 * rather than 1 so that sibling variants are far apart in the seed space: adjacent
 * integer seeds are not guaranteed to give perceptibly different samples on every
 * sampler, and 22.5's point is that the variants differ.
 *
 * 2654435761 is Knuth's multiplicative constant, chosen for having no small factors in
 * common with a power of two other than being odd.
 */
export const SEED_STRIDE = 2_654_435_761;

/**
 * The seed for variant `index` of a request whose base seed is `baseSeed`.
 *
 * Variant 0 is the base seed itself, so a single-variant request with a named seed uses
 * exactly that seed — which is what a caller reading Requirement 22.8 would expect, and
 * what makes the seed they receive back equal the seed they sent.
 */
export function variantSeed(baseSeed: number, index: number): number {
  const offset = (index * SEED_STRIDE) % SFX_SEED_SPACE;
  return (((baseSeed + offset) % SFX_SEED_SPACE) + SFX_SEED_SPACE) % SFX_SEED_SPACE;
}

/** Every variant seed for one request, in variant order. Distinct by construction. */
export function variantSeeds(baseSeed: number, variantCount: number): readonly number[] {
  return Array.from({ length: Math.max(0, variantCount) }, (_unused, index) =>
    variantSeed(baseSeed, index),
  );
}

/**
 * The draw of Requirement 22.13, as a port.
 *
 * A port rather than a `Math.random()` call because a seed drawn at random is the one
 * thing in the whole SFX path that is not a function of its inputs, and a test that
 * cannot pin it cannot assert anything about what was recorded. Production supplies
 * `cryptoSeedSource`; a test supplies a sequence.
 */
export interface SeedSource {
  /** An integer in `[SFX_SEED_MIN, SFX_SEED_MAX]`. */
  draw(): number;
}

/**
 * Uniform over the seed space, from the platform CSPRNG.
 *
 * `crypto.getRandomValues` rather than `Math.random()`: not for secrecy, but because a
 * seed is user-visible provenance recorded on an asset (22.13) and reproduced on
 * request (22.8), and a generator with a short period could quietly hand two accounts
 * the same "random" sound. Masking to 31 bits keeps the result inside 0..2^31−1 with no
 * modulo bias.
 */
export const cryptoSeedSource: SeedSource = {
  draw(): number {
    const buffer = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buffer);
    return (buffer[0] ?? 0) % SFX_SEED_SPACE;
  },
};

/** A source returning a fixed sequence, then repeating its last value. */
export function fixedSeedSource(...seeds: readonly number[]): SeedSource {
  const queue = [...seeds];
  let last = seeds[seeds.length - 1] ?? SFX_SEED_MIN;
  return {
    draw(): number {
      const next = queue.shift();
      if (next !== undefined) last = next;
      return last;
    },
  };
}
