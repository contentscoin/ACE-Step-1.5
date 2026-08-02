import { describe, expect, it } from 'vitest';

import { WOOSH_DFLOW_ENGINE_ID, WOOSH_FLOW_ENGINE_ID } from '../../../adapters/registry/default-engines';
import { WOOSH_WEIGHT_LICENSE_ID } from '../../../adapters/woosh/license';
import { SFX_VARIANT_COUNT_MAX } from '../../../domain/sfx/bounds';
import { variantSeeds } from '../../../domain/sfx/seed';
import { isGenerationError } from '../../../services/generation/errors';
import { isDescendingWithinTolerance } from '../../../domain/sfx/alignment';
import {
  TEST_SFX_BASE_SEED,
  createSfxHarness,
  sfxRequest,
} from '../../support/sfx-harness';
import { decayingOneShot, seamlessSfxLoop, sustainedOneShot } from '../../support/pcm-synthesis';

/**
 * SFX_Service — the whole Requirement 22 flow over the real job lifecycle.
 *
 * **Validates: Requirements 22.1, 22.3, 22.5, 22.6, 22.7, 22.9, 22.10, 22.11, 22.12, 22.13,
 * 22.14, 22.15, 22.16, 22.17, 22.18, 22.19, 33.2, 34.6**
 *
 * The orchestrator, the registry, the credit ports, the refund path and the Woosh adapter are
 * all the production ones (see `test/support/sfx-harness.ts`), so a Requirement 22.19 refund is
 * counted where every other refund in the system is counted and the Requirement 33.2 licence
 * ruling genuinely happens. The one fake is the seam onto decoded audio, which is what lets
 * "this variant's audio fails the tail rule" be stated.
 */

describe('accepting a request (Requirements 22.1, 22.16, 22.17)', () => {
  it('produces sfx assets and records the four fields of 22.1 on each', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2, targetLengthSeconds: 1.5 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants).toHaveLength(2);

    for (const variant of outcome.variants) {
      expect(variant.metadata.prompt).toBe('a heavy wooden door slams shut');
      expect(variant.metadata.targetLengthSeconds).toBe(1.5);
      expect(variant.metadata.isLoop).toBe(false);
      expect(variant.metadata.modelTier).toBe('fast');
    }

    const stored = await harness.generation.store.find(outcome.variants[0]?.jobId ?? '');
    expect(stored?.input.assetKind).toBe('sfx');
  });

  it('applies and reports 22.17s defaults', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.applied).toMatchObject({
      targetLengthSeconds: 2.0,
      variantCount: 4,
      modelTier: 'fast',
      samplingSteps: 8,
      guidanceScale: 7.5,
    });
    expect(outcome.applied.defaultedFields).toContain('modelTier');
    expect(outcome.variants).toHaveLength(4);
  });

  it('caps a request at eight assets, which is the validator refusing nine (22.16, 22.18)', async () => {
    const harness = createSfxHarness();

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: sfxRequest({ variantCount: SFX_VARIANT_COUNT_MAX + 1 }),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isGenerationError(error) && error.code === 'sfx_request_invalid',
    );

    // Requirement 22.18: nothing was charged.
    expect(harness.generation.charges.requests).toHaveLength(0);
  });

  it('produces exactly eight for the maximum request', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: SFX_VARIANT_COUNT_MAX }),
    });

    expect(outcome.kind === 'produced' ? outcome.variants.length : 0).toBe(SFX_VARIANT_COUNT_MAX);
  });
});

describe('rejections leave the balance untouched (Requirements 22.3, 22.18)', () => {
  it('refuses an empty prompt with the counts and charges nothing', async () => {
    const harness = createSfxHarness();

    await expect(
      harness.service.generate({ accountId: 'user-1', request: { prompt: '  ' } }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      return (
        error.code === 'sfx_request_invalid' &&
        error.statusCode === 400 &&
        (error.details.prompt as { constraint?: string } | undefined)?.constraint === 'min_length'
      );
    });

    expect(harness.generation.charges.requests).toHaveLength(0);
    expect(harness.transport.submissions).toHaveLength(0);
  });

  it('refuses a step count outside the chosen tier and never reaches the engine', async () => {
    const harness = createSfxHarness();

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: sfxRequest({ modelTier: 'fast', samplingSteps: 30 }),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isGenerationError(error) && error.code === 'sfx_request_invalid',
    );

    expect(harness.transport.submissions).toHaveLength(0);
  });
});

describe('the model tier selects the engine (Requirement 22.9; design §3.6)', () => {
  it('routes the fast tier to the distilled Woosh engine', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ modelTier: 'fast', variantCount: 1 }),
    });

    expect(outcome.kind === 'produced' ? outcome.engineId : '').toBe(WOOSH_DFLOW_ENGINE_ID);
  });

  it('routes the high-quality tier to the non-distilled Woosh engine', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ modelTier: 'high_quality', variantCount: 1 }),
    });

    expect(outcome.kind === 'produced' ? outcome.engineId : '').toBe(WOOSH_FLOW_ENGINE_ID);
  });

  it('honours an engine the caller named (Requirement 20.3)', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ modelTier: 'fast', variantCount: 1 }),
      engineId: WOOSH_FLOW_ENGINE_ID,
    });

    expect(outcome.kind === 'produced' ? outcome.engineId : '').toBe(WOOSH_FLOW_ENGINE_ID);
  });

  it('sends the tier-appropriate step count and the guidance scale on the wire', async () => {
    const harness = createSfxHarness();

    await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ modelTier: 'high_quality', variantCount: 1, guidanceScale: 12.5 }),
    });

    expect(harness.payloads()[0]).toMatchObject({
      model: 'woosh-flow',
      num_inference_steps: 30,
      guidance_scale: 12.5,
      duration_seconds: 2.0,
      num_samples: 1,
    });
  });
});

describe('both Woosh engines are non-commercial (Requirement 33.2)', () => {
  it('records commercial use as false, grounded in the CC-BY-NC weight licence', () => {
    const harness = createSfxHarness();

    for (const engineId of [WOOSH_DFLOW_ENGINE_ID, WOOSH_FLOW_ENGINE_ID]) {
      const record = harness.generation.registry.require(engineId);

      // The descriptor said `false` and the list says `false`; either way the ruling is `false`,
      // and Requirement 33.22 makes that unbypassable downstream.
      expect(record.commercialUse.commercialUseAllowed).toBe(false);
      expect(record.commercialUse.groundingLicenseIds).toContain(WOOSH_WEIGHT_LICENSE_ID);
    }
  });
});

describe('variant seeds (Requirements 22.5, 22.13)', () => {
  it('asks the engine for a different seed for every variant', async () => {
    const harness = createSfxHarness();

    await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: SFX_VARIANT_COUNT_MAX, seed: 99 }),
    });

    const seeds = harness.seeds();
    expect(seeds).toHaveLength(SFX_VARIANT_COUNT_MAX);
    expect(new Set(seeds).size).toBe(SFX_VARIANT_COUNT_MAX);
  });

  it('uses the seed the caller named for the first variant', async () => {
    const harness = createSfxHarness();

    await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 3, seed: 4_242 }),
    });

    expect(harness.seeds()).toEqual(variantSeeds(4_242, 3));
    expect(harness.seeds()[0]).toBe(4_242);
  });

  it('draws a seed when none was named, and records it on every asset', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.baseSeed).toBe(TEST_SFX_BASE_SEED);
    // Requirement 22.13: each asset records the seed it actually used.
    expect(outcome.variants.map((variant) => variant.metadata.seed).sort((a, b) => a - b)).toEqual(
      [...variantSeeds(TEST_SFX_BASE_SEED, 2)].sort((a, b) => a - b),
    );
  });
});

describe('alignment scores and ordering (Requirements 22.6, 22.7)', () => {
  it('returns the variants ordered by score descending', async () => {
    const harness = createSfxHarness();
    harness.candidates.script(
      { kind: 'audio', audio: decayingOneShot({ durationMs: 800 }), alignmentScore: 0.2 },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 800 }), alignmentScore: 0.9 },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 800 }), alignmentScore: 0.5 },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 3 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants.map((variant) => variant.alignmentScore)).toEqual([0.9, 0.5, 0.2]);
    expect(isDescendingWithinTolerance(outcome.variants)).toBe(true);
  });

  it('breaks a near-tie by ascending seed', async () => {
    const harness = createSfxHarness();
    const seeds = variantSeeds(7, 2);
    // Two scores 0.0004 apart: Requirement 22.6 says the seeds decide.
    harness.candidates.script(
      { kind: 'audio', audio: decayingOneShot({ durationMs: 500 }), alignmentScore: 0.5 },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 500 }), alignmentScore: 0.5004 },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2, seed: 7 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    const orderedSeeds = outcome.variants.map((variant) => variant.seed);
    expect(orderedSeeds).toEqual([...seeds].sort((a, b) => a - b));
  });

  it('normalises the score into 0..1 before storing it (Requirement 22.7)', async () => {
    const harness = createSfxHarness();
    harness.candidates.script(
      { kind: 'audio', audio: decayingOneShot({ durationMs: 400 }), alignmentScore: 4.2 },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 400 }), alignmentScore: -3 },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants.map((variant) => variant.metadata.alignmentScore)).toEqual([1, 0]);
  });

  it('ranks an unscored candidate last rather than discarding it', async () => {
    const harness = createSfxHarness();
    harness.candidates.script(
      { kind: 'audio', audio: decayingOneShot({ durationMs: 400 }), alignmentScore: null },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 400 }), alignmentScore: 0.4 },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants).toHaveLength(2);
    expect(outcome.variants[1]?.alignmentScore).toBe(0);
  });
});

describe('the quality gate (Requirements 22.14, 22.15, 34.6)', () => {
  it('records the threshold-set version on every admitted asset', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 1 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants[0]?.metadata.qualityThresholdSetVersion).toBe(1);
  });

  it('judges a one-shot on the tail rule and a loop on the seam rule, never both', async () => {
    const oneShot = createSfxHarness();
    const oneShotOutcome = await oneShot.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 1 }),
    });
    expect(oneShotOutcome.kind).toBe('produced');
    if (oneShotOutcome.kind !== 'produced') return;
    expect(oneShotOutcome.variants[0]?.tailDecay).not.toBeNull();
    expect(oneShotOutcome.variants[0]?.loopSeam).toBeNull();

    const loop = createSfxHarness();
    loop.setAudioShape('loop');
    const loopOutcome = await loop.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 1, loop: true }),
    });
    expect(loopOutcome.kind).toBe('produced');
    if (loopOutcome.kind !== 'produced') return;
    expect(loopOutcome.variants[0]?.loopSeam).not.toBeNull();
    expect(loopOutcome.variants[0]?.tailDecay).toBeNull();
    expect(loopOutcome.variants[0]?.metadata.isLoop).toBe(true);
  });

  it('refuses a one-shot that never decays, refunds it, and keeps the good variants (22.19)', async () => {
    const harness = createSfxHarness();
    harness.candidates.script(
      // Requirement 22.15 fails: still at full level on its last sample.
      { kind: 'audio', audio: sustainedOneShot({ durationMs: 900 }), alignmentScore: 0.9 },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 900 }), alignmentScore: 0.4 },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    // Only the surviving variant is returned, and the highest-scoring one is gone because it
    // was the one that failed — the gate is not a preference.
    expect(outcome.variants).toHaveLength(1);
    expect(outcome.variants[0]?.alignmentScore).toBe(0.4);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.reason).toBe('quality_unmet');
    expect(outcome.failures[0]?.unmet).toEqual(['one_shot_tail']);
    // Requirement 22.19: the failed variant's credits come back, through the one refund path.
    expect(outcome.refundedAmount).toBeGreaterThan(0);
    expect(harness.generation.refunds.requests).toHaveLength(1);
  });

  it('refuses a loop whose ends do not match in level', async () => {
    const harness = createSfxHarness();
    harness.candidates.script(
      { kind: 'audio', audio: decayingOneShot({ durationMs: 900 }) },
      { kind: 'audio', audio: seamlessSfxLoop({ durationMs: 900 }) },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2, loop: true }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.failures[0]?.unmet).toEqual(['loop_seam']);
    expect(outcome.variants).toHaveLength(1);
  });

  it('fails the whole request when no variant survives', async () => {
    const harness = createSfxHarness();
    harness.candidates.script(
      { kind: 'audio', audio: sustainedOneShot({ durationMs: 600 }) },
      { kind: 'audio', audio: sustainedOneShot({ durationMs: 600 }) },
    );

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: sfxRequest({ variantCount: 2 }),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      return error.code === 'sfx_all_variants_failed' && error.statusCode === 422;
    });

    // Both charges came back.
    expect(harness.generation.refunds.requests).toHaveLength(2);
  });
});

describe('partial engine failure (Requirement 22.19)', () => {
  it('keeps the successes, counts the failures, and does not double-refund', async () => {
    const harness = createSfxHarness();
    harness.candidates.script(
      { kind: 'unproduced', reason: 'sampler diverged' },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 700 }), alignmentScore: 0.6 },
      { kind: 'audio', audio: decayingOneShot({ durationMs: 700 }), alignmentScore: 0.3 },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 3 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants).toHaveLength(2);
    expect(outcome.failures).toHaveLength(1);
    // Requirement 22.19's 실패 사유 구분값: an engine failure is a different kind from a
    // quality miss, and Requirements 6.1–6.3 already settled its credits.
    expect(outcome.failures[0]?.reason).toBe('engine_failure');
    expect(outcome.refundedAmount).toBe(0);
  });

  it('records an engine that refused the submission, refunded by Requirement 6.3', async () => {
    const harness = createSfxHarness();
    // The real engine-failure path: the Woosh adapter throws, the orchestrator fails the job and
    // Requirement 6.3 refunds it. The SFX_Service must count the variant and not refund it again.
    //
    // 400 rather than 500 deliberately. A 4xx classifies as `input_error`, which Requirement 6.2
    // does not re-request — its backoff exists for queue saturation, not for a refused request — so
    // this test stays about the Requirement 22.19 accounting instead of also driving the retry
    // schedule, which `test/unit/bgm/retry-composition.test.ts` already covers for the shared
    // machinery.
    harness.transport.failSubmit(400, 1);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 2 }),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants).toHaveLength(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.reason).toBe('engine_failure');
    // Requirement 6.3 already returned the credits; 22.19 must not return them twice.
    expect(outcome.refundedAmount).toBe(0);
    expect(harness.generation.refunds.requests).toHaveLength(1);
  });

  it('attempts every variant even after one fails', async () => {
    const harness = createSfxHarness();
    harness.candidates.script({ kind: 'unproduced' }, { kind: 'unproduced' });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 4 }),
    });

    expect(outcome.kind === 'produced' ? outcome.variants.length : 0).toBe(2);
    expect(harness.candidates.calls).toHaveLength(4);
  });
});

describe('the content policy gate (Requirements 16.2, 16.11)', () => {
  it('refuses the whole request and charges nothing when the prompt is blocked', async () => {
    const harness = createSfxHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: sfxRequest({ variantCount: 4 }),
      moderate: () => ({
        outcome: 'blocked' as const,
        blocks: [{ code: 'policy_violation' as const, violations: [] }],
        violationClasses: [],
        texts: [],
      }),
    });

    expect(outcome.kind).toBe('blocked');
    // Every variant shares the prompt, so one verdict settles all of them and none is charged.
    expect(harness.generation.charges.requests).toHaveLength(0);
    expect(harness.transport.submissions).toHaveLength(0);
  });
});
