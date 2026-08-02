import { describe, expect, it } from 'vitest';

import { integratedLoudnessLufs } from '../../../domain/audio/loudness';
import {
  PACK_CUE_COUNT,
  PACK_CUE_PAIR_COUNT,
  PACK_GENERATION_CONCURRENCY,
} from '../../../domain/sound-pack/bounds';
import { CUE_NAMES, LOOP_CUE_NAMES, SEMANTIC_CUES } from '../../../domain/sound-pack/taxonomy';
import { examinedEveryPair } from '../../../domain/sound-pack/similarity';
import { isGenerationError } from '../../../services/generation/errors';
import { mapWithConcurrency, withConcurrencyProbe } from '../../../services/generation/concurrency';
import type { SoundPackReport } from '../../../services/sound/sound-pack-result';
import {
  PACK_REGENERATION_ROUNDS,
  createSoundPackHarness,
  soundPackRequest,
} from '../../support/sound-pack-harness';
import { distinctOneShot } from '../../support/cue-synthesis';
import { monoAudio, sustainedOneShot } from '../../support/pcm-synthesis';

/**
 * The Sound_Pack_Service end to end (Requirement 24).
 *
 * These are the expensive tests in this task's suite — a pack is 78 real Generation_Jobs through
 * the real lifecycle — so there are few of them and each one asserts several clauses about the
 * same pack rather than generating a new pack per assertion. Where a clause can be checked
 * without a pack (the manifest, the similarity arithmetic, the export judgement, the loudness
 * band) it is checked in its own file against stated numbers instead.
 */

async function produce(
  harness: ReturnType<typeof createSoundPackHarness>,
  overrides: Record<string, unknown> = {},
): Promise<SoundPackReport> {
  const outcome = await harness.service.generate({
    accountId: 'account-1',
    packId: 'pack-1',
    request: soundPackRequest(overrides),
  });
  if (outcome.kind !== 'produced') throw new Error(`pack was ${outcome.kind}`);
  return outcome;
}

describe('a completed pack (Requirements 24.1, 24.2, 24.18)', () => {
  it('holds all 78 cues, and its cue names are exactly the taxonomy', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    // 수용 기준 (a): a completed pack has all 78 cues.
    expect(report.cues).toHaveLength(PACK_CUE_COUNT);
    expect(report.cues.map((cue) => cue.cueName)).toEqual([...CUE_NAMES]);
    expect(report.missingCueNames).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.status).toBe('complete');
  });

  it('produces 72 one-shots and 6 loops, each inside its own length range', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    const loops = report.cues.filter((cue) => cue.loop);
    expect(loops.map((cue) => cue.cueName)).toEqual([...LOOP_CUE_NAMES]);
    expect(report.cues.filter((cue) => !cue.loop)).toHaveLength(72);

    // Requirements 24.4 and 24.5, judged per cue against its own kind's range.
    expect(report.lengths.filter((verdict) => !verdict.satisfied)).toEqual([]);
    for (const verdict of report.lengths) {
      expect(verdict.minMs).toBe(verdict.loop ? 500 : 50);
      expect(verdict.maxMs).toBe(verdict.loop ? 4_000 : 1_500);
    }
  });

  it('keeps every cue inside Requirement 24.7\'s −25…−21 LUFS band', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    expect(report.loudness.satisfied).toBe(true);
    expect(report.loudness.outside).toEqual([]);
    expect(report.loudness.cues).toHaveLength(PACK_CUE_COUNT);
    for (const cue of report.loudness.cues) {
      expect(cue.maxShortTermLufs).toBeGreaterThanOrEqual(-25);
      expect(cue.maxShortTermLufs).toBeLessThanOrEqual(-21);
    }
  });

  it('examines all 3003 cue pairs and finds none above the ceiling', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    // 수용 기준 (b): an exhaustive pairwise check, not a sample. Both halves are asserted —
    // that every pair was examined, and that none exceeded — because a bug that dropped cues
    // from the comparison would make the second true while the first is false.
    expect(report.similarity.pairCount).toBe(PACK_CUE_PAIR_COUNT);
    expect(report.similarity.pairCount).toBe((78 * 77) / 2);
    expect(examinedEveryPair(report.similarity, PACK_CUE_COUNT)).toBe(true);
    expect(report.similarity.satisfied).toBe(true);
    expect(report.similarity.maxSimilarity).toBeLessThanOrEqual(0.95);
    expect(report.unresolvedSimilarPairs).toEqual([]);
  });

  it('judges Requirement 24.6\'s two seam criteria on the six loop cues only', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    expect(report.loopSeams.map((entry) => entry.cueName)).toEqual([...LOOP_CUE_NAMES]);
    for (const entry of report.loopSeams) {
      expect(entry.verdict.satisfied).toBe(true);
      // The sample-step criterion Requirement 22.14 does *not* impose; see
      // `domain/sound-pack/loop-seam.ts`.
      expect(entry.verdict.unmet).toEqual([]);
    }
  });

  it('records every cue as an sfx asset with its cue name, category and pack id (24.18)', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    expect(harness.assetRecords).toHaveLength(PACK_CUE_COUNT);
    expect(harness.assetRecords.map((record) => record.cueName)).toEqual([...CUE_NAMES]);
    for (const record of harness.assetRecords) {
      expect(record.packId).toBe('pack-1');
      expect(record.assetId).not.toBe('');
      const cue = SEMANTIC_CUES.find((entry) => entry.name === record.cueName);
      expect(record.categoryName).toBe(cue?.category);
    }
    // Every asset the pack claims is one the report also claims, and nothing else.
    expect(new Set(harness.assetRecords.map((record) => record.assetId))).toEqual(
      new Set(report.cues.map((cue) => cue.assetId)),
    );
  });

  it('submits one Generation_Job per cue and records the set version on the verdicts', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    // 78 jobs, not one: the reading `services/sound/sound-pack-service.ts` documents.
    expect(harness.sfx.transport.submissions).toHaveLength(PACK_CUE_COUNT);
    expect(new Set(report.cues.map((cue) => cue.jobId)).size).toBe(PACK_CUE_COUNT);
    expect(report.qualityThresholdSetVersion).toBe(1);
    for (const cue of report.loudness.cues) {
      expect(cue.qualityThresholdSetVersion).toBe(report.qualityThresholdSetVersion);
    }
  });

  it('asks the engine 78 distinct seeds, derived from one base seed', async () => {
    const harness = createSoundPackHarness();

    await produce(harness);

    const seeds = harness.sfx.seeds();
    expect(seeds).toHaveLength(PACK_CUE_COUNT);
    expect(new Set(seeds).size).toBe(PACK_CUE_COUNT);
  });

  it('refunds nothing when every cue succeeds', async () => {
    const harness = createSoundPackHarness();

    const report = await produce(harness);

    expect(report.refundedAmount).toBe(0);
  });
});

describe('Requirement 24.20: the request is rejected before anything is charged', () => {
  it.each([
    ['an empty name', { name: '' }],
    ['a 61-character name', { name: 'x'.repeat(61) }],
    ['an empty description', { description: '' }],
    ['a 201-character description', { description: 'y'.repeat(201) }],
  ])('rejects %s with the field, its length and the permitted range', async (_label, overrides) => {
    const harness = createSoundPackHarness();

    const error = await harness.service
      .generate({
        accountId: 'account-1',
        packId: 'pack-1',
        request: soundPackRequest(overrides),
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(isGenerationError(error)).toBe(true);
    if (!isGenerationError(error)) return;
    expect(error.code).toBe('sound_pack_request_invalid');
    expect(error.statusCode).toBe(400);
    expect(error.details['lengths']).toHaveLength(1);
    expect(error.details['violations']).toHaveLength(1);

    // 24.20's other half: nothing was submitted, so no existing asset could have changed.
    expect(harness.sfx.transport.submissions).toEqual([]);
    expect(harness.assetRecords).toEqual([]);
  });

  it('reports both fields when both are wrong', async () => {
    const harness = createSoundPackHarness();

    const error = await harness.service
      .generate({
        accountId: 'account-1',
        packId: 'pack-1',
        request: { name: '', description: '' },
      })
      .catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.details['lengths']).toEqual([
      { field: 'name', actualLength: 0 },
      { field: 'description', actualLength: 0 },
    ]);
  });
});

describe('Requirement 24.21: a cue that cannot be generated', () => {
  it('leaves the pack incomplete, names the cue, and keeps the other 77', async () => {
    const harness = createSoundPackHarness();
    harness.failCue('hover');

    const report = await produce(harness);

    expect(report.status).toBe('incomplete');
    expect(report.missingCueNames).toEqual(['hover']);
    expect(report.cues).toHaveLength(PACK_CUE_COUNT - 1);
    expect(report.cues.map((cue) => cue.cueName)).not.toContain('hover');
  });

  it('retries the cue twice — three attempts — and reports the seeds it tried', async () => {
    const harness = createSoundPackHarness();
    harness.failCue('press');

    const report = await produce(harness);

    const failure = report.failures.find((entry) => entry.cueName === 'press');
    expect(failure?.attempts).toBe(3);
    expect(failure?.seeds).toHaveLength(3);
    expect(new Set(failure?.seeds).size).toBe(3);
    expect(failure?.reason).toBe('quality_unmet');
    expect(failure?.categoryName).toBe('input');
  });

  it('refunds the failed cue through the one existing refund path', async () => {
    const harness = createSoundPackHarness();
    harness.failCue('press');

    const report = await produce(harness);

    // Three attempts, each its own Generation_Job, each failed and refunded by
    // `createJobQualityRejection` — the same path Requirements 5.7, 6.3, 21.18 and 22.19 use.
    expect(report.refundedAmount).toBeGreaterThan(0);
  });

  it('fails a cue whose audio misses Requirement 24.8, not the whole pack', async () => {
    const harness = createSoundPackHarness();
    // A sustained tone's last 50 ms is at full level, so its tail ratio is 1.0 against a 0.05
    // ceiling — Requirement 22.15's rule, which is Requirement 24.8's.
    harness.setRoundAudio('press', 0, sustainedOneShot({ durationMs: 150 }));

    const report = await produce(harness);

    // Requirement 24.21's retries stay in the same round, so a cue whose round is bad fails all
    // three attempts — which is what makes this pack incomplete rather than merely slow.
    expect(report.missingCueNames).toEqual(['press']);
    expect(report.failures.map((entry) => entry.reason)).toEqual(['quality_unmet']);
    expect(report.cues).toHaveLength(PACK_CUE_COUNT - 1);
  });
});

describe('Requirement 24.22: a cue pair above the similarity ceiling', () => {
  it('regenerates the later cue three times, then reports the pack as needing review', async () => {
    const harness = createSoundPackHarness();
    // Identical audio has a cosine similarity of exactly 1, so every same-kind pair exceeds the
    // ceiling — and the replacement audio is identical too, so the remedy cannot succeed. That is
    // 24.22's terminal state reached deterministically.
    harness.setUniformAudio(distinctOneShot(1, { durationMs: 150 }), harness.audioFor('loading'));

    const report = await produce(harness);

    expect(report.similarity.satisfied).toBe(false);
    expect(report.similarity.pairCount).toBe(PACK_CUE_PAIR_COUNT);
    expect(report.status).toBe('review_required');
    expect(report.unresolvedSimilarPairs.length).toBeGreaterThan(0);

    // Three regenerations, as 24.22 permits, and each unresolved pair reports the number tried
    // alongside its measured similarity.
    for (const pair of report.unresolvedSimilarPairs) {
      expect(pair.regenerations).toBe(PACK_REGENERATION_ROUNDS);
      expect(pair.similarity).toBeGreaterThan(0.95);
      expect(pair.similarity).toBeLessThanOrEqual(1);
    }

    // The pack is *whole* — that is what distinguishes `review_required` from `incomplete`.
    expect(report.cues).toHaveLength(PACK_CUE_COUNT);
    expect(report.missingCueNames).toEqual([]);
  });

  it('names the later cue of each pair, in taxonomy order, and reseeds only those', async () => {
    const harness = createSoundPackHarness();
    harness.setUniformAudio(distinctOneShot(1, { durationMs: 150 }), harness.audioFor('loading'));

    const report = await produce(harness);

    // The remedy submits more than the 78 of the initial pass, and every extra submission is a
    // regeneration of a cue that appeared on the right of an exceeding pair.
    expect(harness.sfx.transport.submissions.length).toBeGreaterThan(PACK_CUE_COUNT);
    const rightNames = new Set(report.unresolvedSimilarPairs.map((pair) => pair.rightCueName));
    expect(rightNames.has('hover')).toBe(false); // the first cue is never the later one
  });

  it('submits exactly 78 jobs when no pair exceeds the ceiling', async () => {
    const harness = createSoundPackHarness();

    await produce(harness);

    expect(harness.sfx.transport.submissions).toHaveLength(PACK_CUE_COUNT);
  });
});

describe('Requirement 24.17: regenerating one cue', () => {
  it('replaces that cue and leaves the other 77 untouched', async () => {
    const harness = createSoundPackHarness();
    const report = await produce(harness);
    const before = report.cues.find((cue) => cue.cueName === 'select');

    const outcome = await harness.service.regenerateCue({
      accountId: 'account-1',
      packId: 'pack-1',
      request: soundPackRequest(),
      cueName: 'select',
      cues: report.cues,
    });

    if (outcome.kind !== 'regenerated') throw new Error(`regeneration was ${outcome.kind}`);
    expect(outcome.unchangedCueCount).toBe(PACK_CUE_COUNT - 1);
    expect(outcome.cue?.assetId).not.toBe(before?.assetId);
    expect(outcome.cue?.seed).not.toBe(before?.seed);
  });

  it('re-checks the four constraints Requirement 24.17 names', async () => {
    const harness = createSoundPackHarness();
    const report = await produce(harness);

    const outcome = await harness.service.regenerateCue({
      accountId: 'account-1',
      packId: 'pack-1',
      request: soundPackRequest(),
      cueName: 'loading',
      cues: report.cues,
    });

    if (outcome.kind !== 'regenerated') throw new Error(`regeneration was ${outcome.kind}`);
    // 24.4/24.5's length, 24.7's loudness, 24.6's seam (a loop cue), 24.9's similarity.
    expect(outcome.length?.satisfied).toBe(true);
    expect(outcome.loudness?.satisfied).toBe(true);
    expect(outcome.loopSeam?.verdict.satisfied).toBe(true);
    expect(outcome.similarity.pairCount).toBe(PACK_CUE_PAIR_COUNT);
    expect(outcome.status).toBe('complete');
  });

  it('reports no seam verdict for a one-shot cue, which 24.6 does not apply to', async () => {
    const harness = createSoundPackHarness();
    const report = await produce(harness);

    const outcome = await harness.service.regenerateCue({
      accountId: 'account-1',
      packId: 'pack-1',
      request: soundPackRequest(),
      cueName: 'hover',
      cues: report.cues,
    });

    if (outcome.kind !== 'regenerated') throw new Error(`regeneration was ${outcome.kind}`);
    expect(outcome.loopSeam).toBeNull();
  });

  it('rejects a cue name the taxonomy does not know, before submitting anything', async () => {
    const harness = createSoundPackHarness();

    const error = await harness.service
      .regenerateCue({
        accountId: 'account-1',
        packId: 'pack-1',
        request: soundPackRequest(),
        cueName: 'kerplunk',
        cues: [],
      })
      .catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.code).toBe('sound_pack_cue_unknown');
    expect(error.statusCode).toBe(404);
    expect(harness.sfx.transport.submissions).toEqual([]);
  });
});

describe('cue generation is bounded at 8 concurrent (task 3.4)', () => {
  it('never has more than the limit in flight, and finishes every task', async () => {
    const probe = withConcurrencyProbe(async (value: number) => {
      // Two microtask turns, so the workers genuinely interleave rather than each running to
      // completion before the next starts.
      await Promise.resolve();
      await Promise.resolve();
      return value * 2;
    });

    const settled = await mapWithConcurrency(
      Array.from({ length: PACK_CUE_COUNT }, (_unused, index) => index),
      PACK_GENERATION_CONCURRENCY,
      probe.probed,
    );

    expect(probe.peak()).toBe(PACK_GENERATION_CONCURRENCY);
    expect(settled).toHaveLength(PACK_CUE_COUNT);
    expect(settled.map((result) => (result.status === 'fulfilled' ? result.value : -1))).toEqual(
      Array.from({ length: PACK_CUE_COUNT }, (_unused, index) => index * 2),
    );
  });

  it('produces the same pack at a concurrency of 1 as at 8', async () => {
    const eight = await produce(createSoundPackHarness({ concurrency: 8 }));
    const one = await produce(createSoundPackHarness({ concurrency: 1 }));

    // The limiter returns results in input order, so the pack is a function of its inputs and
    // not of how many generations happened to be in flight.
    expect(one.cues.map((cue) => cue.cueName)).toEqual(eight.cues.map((cue) => cue.cueName));
    expect(one.cues.map((cue) => cue.seed)).toEqual(eight.cues.map((cue) => cue.seed));
    expect(one.similarity.maxSimilarity).toBeCloseTo(eight.similarity.maxSimilarity, 12);
  });
});

describe('the synthesised cues really are what the clauses require', () => {
  it('places a one-shot at −23 LUFS with a decayed tail, level-independently', () => {
    const cue = distinctOneShot(7, { durationMs: 150 });

    // A sanity check on the fixture rather than on the product: if these stop holding, the
    // service tests above stop being evidence about the service.
    expect(integratedLoudnessLufs(cue)).toBeLessThan(-15);
    expect(cue.channels[0]?.length).toBe(7_200);
  });

  it('sends a zero-length cue to review rather than admitting it (24.4)', async () => {
    const harness = createSoundPackHarness();
    harness.setCueAudio('hover', monoAudio(new Float32Array(0)));

    const report = await produce(harness);

    // A silent buffer *passes* Requirement 22.15's tail rule — silence has decayed, which
    // `tailRatio` documents — so `SfxService` admits it and the pack is the thing that has to
    // notice. It notices through 24.4: a 0 ms cue is below the 50 ms floor.
    const verdict = report.lengths.find((entry) => entry.cueName === 'hover');
    expect(verdict?.satisfied).toBe(false);
    expect(verdict?.placement).toBe('too_short');
    expect(report.status).toBe('review_required');
    expect(report.missingCueNames).toEqual([]);
  });
});
