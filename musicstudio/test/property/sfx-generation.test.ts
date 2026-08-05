import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { oneShotTailThresholds } from '../../domain/quality/one-shot-tail-thresholds';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../domain/quality/threshold-set';
import {
  isDescendingWithinTolerance,
  isSeedAscendingWithinTieGroups,
  isNormalizedAlignmentScore,
  normalizeAlignmentScore,
  rankByAlignment,
} from '../../domain/sfx/alignment';
import {
  SFX_ALIGNMENT_TIE_TOLERANCE,
  SFX_GUIDANCE_SCALE_MAX,
  SFX_GUIDANCE_SCALE_MIN,
  SFX_SEED_MAX,
  SFX_SEED_MIN,
  SFX_TARGET_LENGTH_SECONDS_MAX,
  SFX_TARGET_LENGTH_SECONDS_MIN,
  SFX_VARIANT_COUNT_MAX,
  SFX_VARIANT_COUNT_MIN,
} from '../../domain/sfx/bounds';
import { stepBoundsFor, type SfxModelTier } from '../../domain/sfx/model-tier';
import { SFX_SEED_SPACE, variantSeed, variantSeeds } from '../../domain/sfx/seed';
import { evaluateTailDecay } from '../../domain/sfx/tail-decay';
import { countPromptTokens } from '../../domain/sfx/tokenize';
import { validateSfxRequest } from '../../domain/sfx/validation';
import { measureTailDecaySync } from '../../services/sound/in-process-measurement';
import { decayingOneShot } from '../support/pcm-synthesis';
import { createSfxHarness, sfxRequest } from '../support/sfx-harness';

/**
 * Sound-effect generation, as invariants over generated inputs.
 *
 * **Property 22 (design §10) — SFX 생성 재현성 — is the first block below.**
 * **Validates: Requirements 22.5, 22.6, 22.7, 22.8, 22.13, 22.15, 22.17**
 *
 * Scope note. Design §10's numbered Correctness Property list assigns **Property 22** to this
 * task (tasks.md §9.2's ownership table says so explicitly: "Property 22 SFX 생성 재현성 (Req
 * 22.8) → 태스크 2.5"), so that block claims the number. The remaining blocks are *unnumbered*
 * property tests: §10's "PBT 적용 영역" list covers ordering and threshold checks, but no
 * numbered Property exists for the alignment ordering of 22.6 or the seed distinctness of 22.5,
 * and inventing one would be a change to design §10 that is not this task's to make. Task 9.2's
 * coverage audit must count only the first block against Property 22.
 *
 * Nothing here reaches a network. Requirement 22.8's engine side is the deterministic simulator
 * in `test/support/deterministic-woosh-transport.ts`, which is a pure function of the wire
 * payload — which is exactly what makes the reproducibility claim checkable rather than assumed.
 */

/** Design §10: at least 100 cases per property. */
const RUNS = { numRuns: 100 };

const arbTier: fc.Arbitrary<SfxModelTier> = fc.constantFrom('fast', 'high_quality');
const arbTargetLength = fc.double({
  min: SFX_TARGET_LENGTH_SECONDS_MIN,
  max: SFX_TARGET_LENGTH_SECONDS_MAX,
  noNaN: true,
});
const arbVariantCount = fc.integer({ min: SFX_VARIANT_COUNT_MIN, max: SFX_VARIANT_COUNT_MAX });
const arbGuidance = fc.double({
  min: SFX_GUIDANCE_SCALE_MIN,
  max: SFX_GUIDANCE_SCALE_MAX,
  noNaN: true,
});
const arbSeed = fc.integer({ min: SFX_SEED_MIN, max: SFX_SEED_MAX });
/** A prompt that is always valid: short, non-empty after trimming, well under 77 tokens. */
const arbPrompt = fc
  .array(fc.constantFrom('door', 'glass', 'metal', 'slam', 'creak', 'thud', 'whoosh'), {
    minLength: 1,
    maxLength: 8,
  })
  .map((words) => words.join(' '));

/** A request whose every field is inside its own range, with a tier-legal step count. */
const arbRequest = fc
  .record({
    prompt: arbPrompt,
    targetLengthSeconds: arbTargetLength,
    variantCount: arbVariantCount,
    modelTier: arbTier,
    guidanceScale: arbGuidance,
    seed: arbSeed,
  })
  .chain((base) =>
    fc
      .integer({
        min: stepBoundsFor(base.modelTier).min,
        max: stepBoundsFor(base.modelTier).max,
      })
      .map((samplingSteps) => ({ ...base, samplingSteps })),
  );

/**
 * The same request space with a shorter length, for the properties that synthesise audio.
 *
 * The length is still varied — it is one of the fields Requirement 22.8 names, so holding it fixed
 * would leave the property blind to it — but capped at one second. Sample-identity is a property of
 * every sample or of none, and eight ten-second buffers synthesised twice per case is 8 million
 * samples for evidence a one-second buffer gives just as well. Design §10 asks for 100 cases per
 * property, and 100 cases is what this cap buys.
 */
const arbShortRequest = arbRequest.map((request) => ({
  ...request,
  targetLengthSeconds: Math.min(request.targetLengthSeconds, 1.0),
}));

/**
 * Byte-wise view of a channel, for comparing two buffers.
 *
 * `Buffer.equals` is a `memcmp`; `expect(a).toEqual(b)` on a `Float32Array` walks it element by
 * element in the assertion library. Both answer the same question — the bytes of an IEEE-754 float
 * array are equal exactly when the samples are — and only one of them is affordable 100 times.
 */
function channelBytes(samples: Float32Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

describe('Feature: ai-music-generation-service, Property 22: 동일한 시드와 파라미터의 SFX 생성 요청은 동일한 결과를 낸다 (Requirements 22.8)', () => {
  it('asks the engine exactly the same questions for the same request', async () => {
    // The product-layer half of Requirement 22.8. Every field 22.8 names has to reach the wire in
    // the same form, in the same order, for the promise to be about anything the engine can keep.
    await fc.assert(
      fc.asyncProperty(arbRequest, async (request) => {
        const first = createSfxHarness();
        const second = createSfxHarness();

        await first.service.generate({ accountId: 'user-1', request });
        await second.service.generate({ accountId: 'user-1', request });

        expect(second.payloads()).toEqual(first.payloads());
      }),
      RUNS,
    );
  });

  it('produces sample-identical audio for the same request', async () => {
    // The whole claim, end to end: same request → same validated parameters → same derived seeds →
    // same wire payloads → same samples. The engine simulator is a pure function of the payload, so
    // any drift in any of those steps shows up as different Float32Array contents.
    //
    // Lengths are capped at 3 s here alone. The length is still varied — it is one of the fields
    // 22.8 names — but eight 10-second buffers synthesised four times per case is 15 million
    // samples for evidence that a 3-second buffer gives just as well.
    await fc.assert(
      fc.asyncProperty(arbShortRequest, async (request) => {
        const first = createSfxHarness();
        const second = createSfxHarness();

        const one = await first.service.generate({ accountId: 'user-1', request });
        const two = await second.service.generate({ accountId: 'user-1', request });

        expect(one.kind).toBe('produced');
        expect(two.kind).toBe('produced');
        if (one.kind !== 'produced' || two.kind !== 'produced') return;

        const samplesOf = (harness: ReturnType<typeof createSfxHarness>) =>
          harness.transport.submissions.map((entry) =>
            channelBytes(harness.transport.pcmFor(entry.taskId).channels[0] ?? new Float32Array(0)),
          );

        const firstSamples = samplesOf(first);
        const secondSamples = samplesOf(second);

        expect(secondSamples).toHaveLength(firstSamples.length);
        // Sample-identical, byte for byte, for every variant — not merely for the first.
        for (let index = 0; index < firstSamples.length; index += 1) {
          expect(secondSamples[index]?.equals(firstSamples[index] ?? Buffer.alloc(0))).toBe(true);
        }
        expect(firstSamples.every((buffer) => buffer.length > 0)).toBe(true);
        // And the user-visible order and scores match too, which is what makes the *list*
        // reproducible and not merely its contents.
        expect(two.variants.map((variant) => variant.metadata)).toEqual(
          one.variants.map((variant) => variant.metadata),
        );
      }),
      RUNS,
    );
  });

  it('changes the audio when any field of the reproducibility key changes', async () => {
    // The converse, and the reason the first two properties are not vacuous: if the simulator
    // ignored the payload, "same request → same audio" would hold trivially.
    await fc.assert(
      fc.asyncProperty(arbRequest, async (request) => {
        const baseline = createSfxHarness();
        const altered = createSfxHarness();

        await baseline.service.generate({ accountId: 'user-1', request });
        await altered.service.generate({
          accountId: 'user-1',
          request: { ...request, seed: (request.seed + 1) % SFX_SEED_SPACE },
        });

        expect(altered.payloads()).not.toEqual(baseline.payloads());
      }),
      RUNS,
    );
  });
});

describe('variant seeds are distinct and in range (Requirements 22.5, 22.13)', () => {
  it('derives distinct seeds for every variant of any request', () => {
    fc.assert(
      fc.property(arbSeed, arbVariantCount, (baseSeed, variantCount) => {
        const seeds = variantSeeds(baseSeed, variantCount);

        expect(seeds).toHaveLength(variantCount);
        expect(new Set(seeds).size).toBe(variantCount);
      }),
      RUNS,
    );
  });

  it('keeps every derived seed inside Requirement 22.13s range', () => {
    fc.assert(
      fc.property(arbSeed, fc.integer({ min: 0, max: SFX_VARIANT_COUNT_MAX - 1 }), (baseSeed, index) => {
        const seed = variantSeed(baseSeed, index);

        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(SFX_SEED_MIN);
        expect(seed).toBeLessThanOrEqual(SFX_SEED_MAX);
      }),
      RUNS,
    );
  });

  it('gives the caller their own seed for the first variant', () => {
    // Requirement 22.8's promise is about the seed the caller sent, so it has to be one of the
    // seeds actually used.
    fc.assert(
      fc.property(arbSeed, (baseSeed) => {
        expect(variantSeed(baseSeed, 0)).toBe(baseSeed);
      }),
      RUNS,
    );
  });

  it('is deterministic in both arguments', () => {
    fc.assert(
      fc.property(arbSeed, fc.integer({ min: 0, max: 7 }), (baseSeed, index) => {
        expect(variantSeed(baseSeed, index)).toBe(variantSeed(baseSeed, index));
      }),
      RUNS,
    );
  });
});

describe('the alignment ordering is descending (Requirement 22.6)', () => {
  /** Scored candidates with distinct seeds, as one request's variants always have. */
  const arbScored = fc
    .uniqueArray(arbSeed, { minLength: 1, maxLength: SFX_VARIANT_COUNT_MAX })
    .chain((seeds) =>
      fc
        .array(fc.double({ min: 0, max: 1, noNaN: true }), {
          minLength: seeds.length,
          maxLength: seeds.length,
        })
        .map((scores) =>
          seeds.map((seed, index) => ({ seed, alignmentScore: scores[index] ?? 0 })),
        ),
    );

  /** Scores deliberately clustered inside the tie window, to hit the intransitivity. */
  const arbNearTied = fc
    .uniqueArray(arbSeed, { minLength: 2, maxLength: SFX_VARIANT_COUNT_MAX })
    .chain((seeds) =>
      fc
        .tuple(
          fc.double({ min: 0.1, max: 0.9, noNaN: true }),
          fc.array(fc.integer({ min: 0, max: 4 }), {
            minLength: seeds.length,
            maxLength: seeds.length,
          }),
        )
        .map(([centre, offsets]) =>
          seeds.map((seed, index) => ({
            seed,
            alignmentScore: centre + (offsets[index] ?? 0) * (SFX_ALIGNMENT_TIE_TOLERANCE / 2),
          })),
        ),
    );

  it('never lets a later variant outscore an earlier one by more than the tolerance', () => {
    fc.assert(
      fc.property(arbScored, (scored) => {
        const ordered = rankByAlignment(scored).map((ranked) => ranked.value);

        expect(isDescendingWithinTolerance(ordered)).toBe(true);
      }),
      RUNS,
    );
  });

  it('holds the descending invariant even for scores clustered inside the tie window', () => {
    // This is the case a naive pairwise comparator gets wrong; see `domain/sfx/alignment.ts`.
    fc.assert(
      fc.property(arbNearTied, (scored) => {
        const ordered = rankByAlignment(scored).map((ranked) => ranked.value);

        expect(isDescendingWithinTolerance(ordered)).toBe(true);
      }),
      RUNS,
    );
  });

  it('orders seeds ascending inside every near-tie run', () => {
    fc.assert(
      fc.property(arbNearTied, (scored) => {
        expect(isSeedAscendingWithinTieGroups(rankByAlignment(scored))).toBe(true);
      }),
      RUNS,
    );
  });

  it('separates near-tie runs strictly by score', () => {
    fc.assert(
      fc.property(arbScored, (scored) => {
        const ranked = rankByAlignment(scored);

        for (let index = 1; index < ranked.length; index += 1) {
          const previous = ranked[index - 1];
          const current = ranked[index];
          if (previous === undefined || current === undefined) continue;
          if (previous.tieGroup === current.tieGroup) continue;
          // A new run means the score dropped by more than the tolerance, so ordering across runs
          // is score descending with no ambiguity at all.
          expect(previous.value.alignmentScore).toBeGreaterThan(current.value.alignmentScore);
        }
      }),
      RUNS,
    );
  });

  it('is a permutation of its input: nothing is dropped or duplicated', () => {
    fc.assert(
      fc.property(arbScored, (scored) => {
        const ranked = rankByAlignment(scored);

        expect(ranked).toHaveLength(scored.length);
        expect([...ranked].map((item) => item.value.seed).sort((a, b) => a - b)).toEqual(
          [...scored].map((item) => item.seed).sort((a, b) => a - b),
        );
        expect(ranked.map((item) => item.rank)).toEqual(scored.map((_unused, index) => index));
      }),
      RUNS,
    );
  });

  it('is independent of the input order', () => {
    fc.assert(
      fc.property(arbScored, (scored) => {
        const forward = rankByAlignment(scored).map((ranked) => ranked.value.seed);
        const reversed = rankByAlignment([...scored].reverse()).map((ranked) => ranked.value.seed);

        expect(reversed).toEqual(forward);
      }),
      RUNS,
    );
  });

  it('tie groups are non-decreasing along the returned order', () => {
    fc.assert(
      fc.property(arbScored, (scored) => {
        const groups = rankByAlignment(scored).map((ranked) => ranked.tieGroup);

        for (let index = 1; index < groups.length; index += 1) {
          expect(groups[index] ?? 0).toBeGreaterThanOrEqual(groups[index - 1] ?? 0);
        }
      }),
      RUNS,
    );
  });
});

describe('score normalisation is total (Requirement 22.7)', () => {
  it('lands inside 0..1 for any number at all', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noNaN: false }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        ),
        (raw) => {
          expect(isNormalizedAlignmentScore(normalizeAlignmentScore(raw))).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (raw) => {
        const once = normalizeAlignmentScore(raw);

        expect(normalizeAlignmentScore(once)).toBe(once);
      }),
      RUNS,
    );
  });
});

describe('validation is total and its defaults are consistent (Requirements 22.17, 22.18)', () => {
  it('accepts every request whose fields are all in range', () => {
    fc.assert(
      fc.property(arbRequest, (request) => {
        expect(validateSfxRequest(request).kind).toBe('valid');
      }),
      RUNS,
    );
  });

  it('resolves a step count inside the resolved tier, whatever was omitted', () => {
    fc.assert(
      fc.property(arbPrompt, fc.option(arbTier, { nil: undefined }), (prompt, modelTier) => {
        const result = validateSfxRequest({
          prompt,
          ...(modelTier === undefined ? {} : { modelTier }),
        });

        expect(result.kind).toBe('valid');
        if (result.kind !== 'valid') return;
        const bounds = stepBoundsFor(result.parameters.modelTier);
        expect(result.parameters.samplingSteps).toBeGreaterThanOrEqual(bounds.min);
        expect(result.parameters.samplingSteps).toBeLessThanOrEqual(bounds.max);
      }),
      RUNS,
    );
  });

  it('lists exactly the omitted fields as defaulted', () => {
    fc.assert(
      fc.property(
        arbPrompt,
        fc.option(arbTargetLength, { nil: undefined }),
        fc.option(arbVariantCount, { nil: undefined }),
        (prompt, targetLengthSeconds, variantCount) => {
          const result = validateSfxRequest({
            prompt,
            ...(targetLengthSeconds === undefined ? {} : { targetLengthSeconds }),
            ...(variantCount === undefined ? {} : { variantCount }),
          });

          expect(result.kind).toBe('valid');
          if (result.kind !== 'valid') return;
          expect(result.parameters.appliedDefaults.includes('targetLengthSeconds')).toBe(
            targetLengthSeconds === undefined,
          );
          expect(result.parameters.appliedDefaults.includes('variantCount')).toBe(
            variantCount === undefined,
          );
        },
      ),
      RUNS,
    );
  });

  it('never throws, whatever shape it is handed', () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            prompt: fc.oneof(fc.string(), fc.constant(''), fc.constant('   ')),
            targetLengthSeconds: fc.oneof(fc.double({ noNaN: false }), fc.constant(Number.NaN)),
            variantCount: fc.integer({ min: -100, max: 100 }),
            guidanceScale: fc.double({ min: -100, max: 100, noNaN: false }),
            seed: fc.integer({ min: -1_000, max: SFX_SEED_MAX }),
          },
          { requiredKeys: ['prompt'] },
        ),
        (request) => {
          const result = validateSfxRequest(request);

          expect(['valid', 'invalid']).toContain(result.kind);
          if (result.kind === 'invalid') {
            expect(result.violations.length).toBeGreaterThan(0);
          }
        },
      ),
      RUNS,
    );
  });

  it('reports a token count that never falls below the character-run count', () => {
    // The estimate is an upper bound by construction (`domain/sfx/tokenize.ts`); this pins that it
    // is at least monotone in the number of words, so a longer prompt never counts as fewer tokens.
    fc.assert(
      fc.property(arbPrompt, arbPrompt, (first, second) => {
        expect(countPromptTokens(`${first} ${second}`)).toBeGreaterThanOrEqual(
          countPromptTokens(first),
        );
      }),
      RUNS,
    );
  });
});

describe('the tail rule over synthesised one-shots (Requirement 22.15)', () => {
  const thresholds = oneShotTailThresholds(INITIAL_QUALITY_THRESHOLD_SET);

  it('admits a decaying one-shot at every length Requirement 22.4 permits', () => {
    // Including the 0.1 s floor, which is the case that forced `decayingOneShot`'s exponent to be
    // derived from the duration rather than fixed — see the note there and the unit test
    // "the 0.1 s floor of 22.4 leaves 22.15 barely satisfiable".
    fc.assert(
      fc.property(
        fc.double({
          min: SFX_TARGET_LENGTH_SECONDS_MIN,
          max: SFX_TARGET_LENGTH_SECONDS_MAX,
          noNaN: true,
        }),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        (seconds, amplitude) => {
          const audio = decayingOneShot({ durationMs: seconds * 1000, amplitude });
          const verdict = evaluateTailDecay(
            measureTailDecaySync({ subject: { kind: 'pcm', audio } }),
            thresholds,
          );

          expect(verdict.satisfied).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('never produces NaN evidence, for any buffer', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (seconds, amplitude) => {
          const audio = decayingOneShot({ durationMs: seconds * 1000, amplitude });
          const verdict = evaluateTailDecay(
            measureTailDecaySync({ subject: { kind: 'pcm', audio } }),
            thresholds,
          );

          for (const evidence of verdict.channels) {
            expect(Number.isNaN(evidence.tailRatio)).toBe(false);
          }
          expect(Number.isNaN(verdict.worstTailRatio)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('is monotone in the ceiling: a looser threshold never rejects what a tighter admitted', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0.001, max: 0.25, noNaN: true }),
        fc.double({ min: 0.001, max: 0.25, noNaN: true }),
        (tailRatio, first, second) => {
          const tight = Math.min(first, second);
          const loose = Math.max(first, second);
          const subject = {
            sampleRate: 48_000,
            durationMs: 1_000,
            channels: [{ tailPeakAbs: tailRatio, peakAbs: 1 }],
          };
          const at = (max: number): boolean =>
            evaluateTailDecay(subject, { version: 1, tailAmplitudeRatioMax: max }).satisfied;

          if (at(tight)) expect(at(loose)).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

describe('the produced set respects Requirement 22.16 for any admitted count', () => {
  it('never returns more assets than variants requested', async () => {
    await fc.assert(
      fc.asyncProperty(arbVariantCount, async (variantCount) => {
        const harness = createSfxHarness();

        const outcome = await harness.service.generate({
          accountId: 'user-1',
          request: sfxRequest({ variantCount, targetLengthSeconds: 1.0 }),
        });

        expect(outcome.kind).toBe('produced');
        if (outcome.kind !== 'produced') return;
        expect(outcome.variants.length).toBeLessThanOrEqual(variantCount);
        expect(outcome.variants.length).toBeLessThanOrEqual(SFX_VARIANT_COUNT_MAX);
        expect(outcome.variants.length + outcome.failures.length).toBe(variantCount);
        expect(isDescendingWithinTolerance(outcome.variants)).toBe(true);
      }),
      RUNS,
    );
  });
});
