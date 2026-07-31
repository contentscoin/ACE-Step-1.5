import { describe, expect, it } from 'vitest';

import { isGenerationError } from '../../../services/generation/errors';
import { generateBgmIntensityVariants } from '../../../services/sound/bgm-variants';
import {
  DEFAULT_BGM_BPM,
  DEFAULT_BGM_TIME_SIGNATURE,
  bgmRequest,
  createBgmHarness,
} from '../../support/bgm-harness';
import { compliantLoop, monoAudio, scaled } from '../../support/pcm-synthesis';

/**
 * Generating a cue's intensity variants.
 *
 * **Validates: Requirements 21.9, 21.10, 21.11**
 *
 * The scripted candidate port returns each variant's audio, so a ladder that does or does
 * not hold can be stated. Since there is no loudness normalisation yet — that is
 * Requirement 30.2–30.5 and task 3.3's Mastering_Assistant — the variants' levels are set
 * here by scaling the same buffer, which is exactly the relation `integratedLoudnessLufs`
 * is pinned to reproduce (see `loudness.test.ts`).
 */

const bpm = DEFAULT_BGM_BPM;
const timeSignature = DEFAULT_BGM_TIME_SIGNATURE;

function baseChannel(): Float32Array {
  const channel = compliantLoop({ bpm, timeSignature, barCount: 4 }).audio.channels[0];
  if (channel === undefined) throw new Error('no channel');
  return channel;
}

/** The base buffer `gapDb` decibels louder — a ladder rung, by construction. */
function rung(stepsAbove: number, gapDb: number) {
  return monoAudio(scaled(baseChannel(), 10 ** ((gapDb * stepsAbove) / 20)));
}

/** Audio for a ladder of `count` variants, each `gapDb` above the one below. */
function ladderAudio(count: number, gapDb: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: 'audio' as const,
    audio: rung(index, gapDb),
  }));
}

describe('producing a ladder (Requirements 21.9, 21.11)', () => {
  it('produces the requested number of variants, stepped 1 upwards', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(...ladderAudio(4, 3));

    const outcome = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 4, intensityGapLufs: 3 },
    });
    if (outcome.kind !== 'produced') throw new Error('expected a variant set');

    expect(outcome.variants).toHaveLength(4);
    expect(outcome.variants.map((variant) => variant.metadata.intensityStep)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(outcome.ladder.satisfied).toBe(true);
  });

  it('separates adjacent variants by the requested loudness gap', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(...ladderAudio(3, 4));

    const outcome = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 3, intensityGapLufs: 4 },
    });
    if (outcome.kind !== 'produced') throw new Error('expected a variant set');

    for (const gap of outcome.ladder.gapsLufs) {
      expect(gap).toBeCloseTo(4, 3);
    }
  });

  it('reports the loudness targets task 3.3 will normalise towards', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(...ladderAudio(3, 2));

    const outcome = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 3, intensityGapLufs: 2, baseLoudnessLufs: -22 },
    });
    if (outcome.kind !== 'produced') throw new Error('expected a variant set');

    expect(outcome.plan).toEqual([
      { step: 1, targetLoudnessLufs: -22 },
      { step: 2, targetLoudnessLufs: -20 },
      { step: 3, targetLoudnessLufs: -18 },
    ]);
  });

  it('produces a set of one for a count of 1', async () => {
    const harness = createBgmHarness();

    const outcome = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 1 },
    });
    if (outcome.kind !== 'produced') throw new Error('expected a variant set');

    expect(outcome.variants).toHaveLength(1);
    expect(outcome.ladder.gapsLufs).toEqual([]);
    expect(outcome.ladder.satisfied).toBe(true);
  });
});

describe('the cue is shared across variants (Requirement 21.9)', () => {
  it('asks the engine for the same BPM, key and length every time', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(...ladderAudio(3, 3));

    await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: {
        ...bgmRequest({ bpm, keyScale: 'C major', targetLengthSeconds: 8 }),
        variantCount: 3,
        intensityGapLufs: 3,
      },
    });

    const submitted = harness.generation.adapter.submitted;
    expect(submitted).toHaveLength(3);
    for (const request of submitted) {
      expect(request.durationMs).toBe(8_000);
    }
    // Every variant is built from one validated `BgmParameters`, so there is no path on
    // which two variants of a cue could be asked for different tempi.
    const stored = await Promise.all(
      harness.candidates.calls.map((call) => harness.generation.store.find(call.jobId)),
    );
    for (const record of stored) {
      expect(record?.input.song).toMatchObject({ bpm, keyScale: 'C major', durationSeconds: 8 });
    }
  });

  it('distinguishes the variants by caption and seed alone', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(...ladderAudio(3, 3));

    await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 3, intensityGapLufs: 3 },
    });

    const prompts = harness.generation.adapter.submitted.map((request) => request.prompt);
    expect(prompts[0]).toContain('intensity level 1 of 3');
    expect(prompts[1]).toContain('intensity level 2 of 3');
    expect(prompts[2]).toContain('intensity level 3 of 3');

    // Without a per-variant seed the engine would be asked the same question three times.
    expect(new Set(harness.seeds()).size).toBe(3);
  });

  it('leaves a standalone cue uncaptioned', async () => {
    const harness = createBgmHarness();

    await harness.service.generate({ accountId: 'user-1', request: bgmRequest() });

    expect(harness.generation.adapter.submitted[0]?.prompt).not.toContain('intensity level');
  });
});

describe('rejecting a variant request (Requirements 21.3, 21.9)', () => {
  it('throws bgm_request_invalid for a count outside 1–4, before charging', async () => {
    const harness = createBgmHarness();

    const error = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 5 },
    }).catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.code).toBe('bgm_request_invalid');
    expect(harness.generation.charges.requests).toHaveLength(0);
  });

  it('throws for a gap outside 1.0–6.0 LUFS', async () => {
    const harness = createBgmHarness();

    const error = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 2, intensityGapLufs: 8 },
    }).catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.code).toBe('bgm_request_invalid');
  });
});

describe('an unachievable ladder is reported, not repaired (Requirements 21.10, 21.11)', () => {
  it('throws bgm_intensity_ladder_unmet when the gaps are too small', async () => {
    // Requirement 21.18 gives the loop criteria a regeneration remedy and gives the
    // ladder invariants none, so a service that invented one would be writing
    // requirement text. Closing the gap is loudness normalisation — task 3.3's.
    const harness = createBgmHarness();
    harness.candidates.script(...ladderAudio(3, 0.5));

    const error = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 3, intensityGapLufs: 3 },
    }).catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('bgm_intensity_ladder_unmet');
    const details = error.details as { unmet: string[]; requirements: string[] };
    expect(details.unmet).toEqual(['loudness_gap']);
    expect(details.requirements).toEqual(['21.11']);
  });

  it('throws when the gaps are too large', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(...ladderAudio(2, 9));

    const error = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 2, intensityGapLufs: 6 },
    }).catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect((error.details as { unmet: string[] }).unmet).toEqual(['loudness_gap']);
  });

  it('throws when the variant lengths differ by more than 10 ms (Requirement 21.10)', async () => {
    const harness = createBgmHarness();
    const shorter = compliantLoop({ bpm, timeSignature, barCount: 4 }).audio.channels[0];
    if (shorter === undefined) throw new Error('no channel');
    harness.candidates.script(
      { kind: 'audio', audio: rung(0, 3) },
      // 20 ms shorter: a clean seam, a clean ladder, and variants that drift apart.
      { kind: 'audio', audio: monoAudio(scaled(shorter.slice(0, shorter.length - 960), 10 ** (3 / 20))) },
    );

    const error = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 2, intensityGapLufs: 3 },
    }).catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    const details = error.details as { unmet: string[]; durationSpreadMs: number };
    expect(details.unmet).toContain('duration_spread');
    expect(details.durationSpreadMs).toBe(20);
  });
});

describe('a variant that cannot be produced stops the set', () => {
  it('returns the failure rather than the remaining variants', async () => {
    // Generating siblings for a cue that cannot be completed would charge for audio
    // nobody can use.
    const harness = createBgmHarness();
    harness.candidates.script(
      { kind: 'audio', audio: rung(0, 3) },
      { kind: 'unproduced', reason: 'decoder crashed' },
    );

    const outcome = await generateBgmIntensityVariants(harness.service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 4, intensityGapLufs: 3 },
    });

    expect(outcome.kind).toBe('failed');
    // Two attempted, not four.
    expect(harness.candidates.calls).toHaveLength(2);
  });
});
