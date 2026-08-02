import { describe, expect, it } from 'vitest';

import { fixedThresholdSource } from '../../../domain/quality/threshold-source';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  changeThreshold,
} from '../../../domain/quality/threshold-set';
import { variantSeeds } from '../../../domain/sfx/seed';
import {
  V2A_SAMPLE_FRAME_RATE,
  V2A_SEGMENT_MAX_MS,
  V2A_SEGMENT_OVERLAP_MS,
  V2A_VARIANT_COUNT_MAX,
} from '../../../domain/v2a/bounds';
import { previewRetainedUntilMs } from '../../../domain/v2a/retention';
import { isAscendingByTime } from '../../../domain/v2a/visual-event-timeline';
import { isGenerationError } from '../../../services/generation/errors';
import { TEST_SAMPLE_RATE } from '../../support/pcm-synthesis';
import {
  TEST_UPLOAD_ID,
  TEST_V2A_BASE_SEED,
  consentingUpload,
  createV2aHarness,
  unconsentingUpload,
} from '../../support/v2a-harness';
import { ambienceAudio, foleyAudio, validVideoMetadata, visualEvent } from '../../support/v2a-synthesis';

/**
 * V2A_Service — the whole Requirement 23 flow over the real job lifecycle.
 *
 * **Validates: Requirements 23.1, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9, 23.10, 23.11, 23.12,
 * 23.13, 23.14, 23.15, 23.16, 23.17, 34.6**
 *
 * The orchestrator, the registry, the credit ports and the refund path are the production ones
 * (see `test/support/v2a-harness.ts`), so a Requirement 23.8/23.9/23.12 refund is counted where
 * every other refund in the system is counted and it goes through the one existing refund path.
 * The fakes are the four ports of `v2a-ports.ts`, each standing in for something this environment
 * does not have: a container to probe, a codec to decode, a V2A engine, a muxer.
 */

const REQUEST = { uploadId: TEST_UPLOAD_ID };

describe('accepting a request (Requirements 23.1, 23.5, 23.10)', () => {
  it('produces one sfx asset by default and records 23.10s lineage on it', async () => {
    const harness = createV2aHarness();
    harness.segments.setEvents([visualEvent(500), visualEvent(1_500)]);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, prompt: 'footsteps on gravel' },
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants).toHaveLength(1);
    expect(outcome.applied).toEqual({ variantCount: 1, defaultedFields: ['variantCount'] });

    const variant = outcome.variants[0];
    // Requirement 23.10: the source video identifier and the prompt used.
    expect(variant?.metadata.sourceVideoUploadId).toBe(TEST_UPLOAD_ID);
    expect(variant?.metadata.prompt).toBe('footsteps on gravel');

    // Requirement 23.1: an `sfx` Audio_Asset.
    const stored = await harness.generation.store.find(variant?.jobId ?? '');
    expect(stored?.input.assetKind).toBe('sfx');
  });

  it('records a null prompt rather than omitting the field, since 23.10 stores the fact', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants[0]?.metadata.prompt).toBeNull();
  });

  it('normalises a whitespace-only prompt to none, so 23.14 is not broken by a form', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, prompt: '   \n ' },
      upload: consentingUpload(),
    });

    expect(outcome.kind === 'produced' && outcome.variants[0]?.metadata.prompt).toBeNull();
  });

  it('forwards 23.5s prompt to every segment and to the engine submission', async () => {
    const harness = createV2aHarness();

    await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, prompt: 'glass shattering' },
      upload: consentingUpload(),
    });

    expect(harness.segments.requests.every((request) => request.prompt === 'glass shattering')).toBe(
      true,
    );
    const record = await harness.generation.store.find(
      harness.segments.requests[0]?.jobId ?? '',
    );
    expect(record?.input.prompt).toBe('glass shattering');
  });

  it('produces exactly four for 23.1s maximum, each with its own job and seed', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, variantCount: V2A_VARIANT_COUNT_MAX },
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants).toHaveLength(4);
    expect(outcome.baseSeed).toBe(TEST_V2A_BASE_SEED);
    expect(outcome.variants.map((variant) => variant.seed)).toEqual(
      variantSeeds(TEST_V2A_BASE_SEED, 4),
    );
    expect(new Set(outcome.variants.map((variant) => variant.jobId)).size).toBe(4);
  });

  it('refuses a count outside 1–4 before probing anything, and charges nothing', async () => {
    const harness = createV2aHarness();

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: { ...REQUEST, variantCount: V2A_VARIANT_COUNT_MAX + 1 },
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isGenerationError(error) && error.code === 'v2a_request_rejected' && error.statusCode === 400,
    );

    expect(harness.uploads.probes).toHaveLength(0);
    expect(harness.generation.charges.requests).toHaveLength(0);
  });
});

describe('the rights consent gate (Requirement 23.11)', () => {
  it('refuses when the confirmation was never recorded, naming the missing item', async () => {
    const harness = createV2aHarness();

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: unconsentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      return (
        error.code === 'v2a_upload_consent_missing' &&
        error.statusCode === 403 &&
        Array.isArray(error.details.missingConsent) &&
        error.details.missingConsent.includes('holdsRights')
      );
    });

    // Refused before the file was even opened, and nothing charged.
    expect(harness.uploads.probes).toHaveLength(0);
    expect(harness.generation.charges.requests).toHaveLength(0);
    // The upload is not kept either.
    expect(harness.uploads.discarded).toEqual([TEST_UPLOAD_ID]);
  });

  it('refuses a present-but-false declaration, which is a refusal rather than consent', async () => {
    const harness = createV2aHarness();

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload({
          rightsConsent: { holdsRights: false, acknowledgedAtMs: 1 },
        }),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isGenerationError(error) && error.code === 'v2a_upload_consent_missing',
    );
  });
});

describe('upload validation, and the file it must not keep (Requirement 23.4)', () => {
  it('discards the upload and reports every violated constraint', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ durationMs: 90_000, container: 'mkv' }));

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      return (
        error.code === 'v2a_upload_rejected' &&
        error.statusCode === 400 &&
        error.details.uploadDiscarded === true &&
        Array.isArray(error.details.constraints) &&
        error.details.constraints.join(',') === 'container,durationMs'
      );
    });

    // 23.4's "해당 업로드 파일을 저장하지 않는다", as an observed effect.
    expect(harness.uploads.discarded).toEqual([TEST_UPLOAD_ID]);
    expect(harness.generation.charges.requests).toHaveLength(0);
    expect(harness.segments.requests).toHaveLength(0);
  });

  it('reports an unreadable container separately, since it yields no measurements', async () => {
    const harness = createV2aHarness();
    harness.uploads.setUnreadable('moov atom not found');

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      return (
        error.code === 'v2a_upload_unreadable' && error.details.detail === 'moov atom not found'
      );
    });

    expect(harness.uploads.discarded).toEqual([TEST_UPLOAD_ID]);
  });
});

describe('24 fps sampling (Requirement 23.6)', () => {
  it('asks the frame source for 24 fps whatever the source rate', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ frameRate: 12, durationMs: 2_000 }));

    await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(harness.frames.requests).toHaveLength(1);
    const plan = harness.frames.requests[0]?.plan;
    expect(plan?.targetFrameRate).toBe(V2A_SAMPLE_FRAME_RATE);
    expect(plan?.sourceIndices).toHaveLength(48);
    // 12 fps: every output frame duplicates its predecessor once.
    expect(plan?.duplicatedCount).toBe(24);
  });

  it('plans each segment against its own length, so indices start at zero', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ durationMs: 20_000, frameRate: 30 }));

    await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(harness.frames.requests).toHaveLength(3);
    for (const request of harness.frames.requests) {
      expect(request.plan.sourceIndices[0]).toBe(0);
      expect(request.plan.sourceIndices).toHaveLength(
        Math.round((request.segment.durationMs * V2A_SAMPLE_FRAME_RATE) / 1000),
      );
    }
  });
});

describe('segmentation and the join (Requirements 23.7, 23.9)', () => {
  it('generates one segment for a clip inside the engine window', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ durationMs: V2A_SEGMENT_MAX_MS }));

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind === 'produced' && outcome.segmentCount).toBe(1);
    expect(harness.segments.requests).toHaveLength(1);
  });

  it('splits a longer clip sequentially, with 50 ms overlaps, and joins to the input length', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ durationMs: 20_000 }));

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.segmentCount).toBe(3);
    // Requirement 23.7's "순차 생성": ascending order, one call each.
    expect(harness.segments.requests.map((request) => request.segment.index)).toEqual([0, 1, 2]);
    for (let index = 1; index < harness.segments.requests.length; index += 1) {
      const previous = harness.segments.requests[index - 1]?.segment;
      const current = harness.segments.requests[index]?.segment;
      expect((previous?.endMs ?? 0) - (current?.startMs ?? 0)).toBe(V2A_SEGMENT_OVERLAP_MS);
    }

    // Requirement 23.9 on the joined result.
    const variant = outcome.variants[0];
    expect(variant?.duration.satisfied).toBe(true);
    expect(Math.abs(variant?.duration.errorMs ?? Infinity)).toBeLessThanOrEqual(40);
    expect(variant?.metadata.durationMs).toBe(20_000);
    expect(variant?.metadata.inputVideoDurationMs).toBe(20_000);
    expect(variant?.metadata.segmentCount).toBe(3);
  });

  it('shares one split across every variant, so 23.14 does not depend on the count', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ durationMs: 20_000 }));

    await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, variantCount: 2 },
      upload: consentingUpload(),
    });

    const spans = harness.segments.requests.map(
      (request) => `${String(request.segment.startMs)}-${String(request.segment.endMs)}`,
    );
    expect(spans.slice(0, 3)).toEqual(spans.slice(3, 6));
  });
});

describe('the Visual_Event_Timeline (Requirements 23.15, 23.16)', () => {
  it('returns clip-relative times ascending, merged across segments', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ durationMs: 20_000 }));
    // One event in each of the three segments, reported segment-relative by the detector.
    harness.segments.setEvents([visualEvent(1_000), visualEvent(9_000), visualEvent(17_000)]);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    const timeline = outcome.variants[0]?.metadata.timeline;
    expect(timeline?.events.map((event) => event.timeMs)).toEqual([1_000, 9_000, 17_000]);
    expect(isAscendingByTime(timeline?.events ?? [])).toBe(true);
    expect(timeline?.status).toBe('events_detected');
    expect(timeline?.confidentEventCount).toBe(3);
  });

  it('carries each events millisecond time, confidence and category (23.15)', async () => {
    const harness = createV2aHarness();
    harness.segments.setEvents([visualEvent(700, { confidence: 0.77, category: 'impact' })]);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind === 'produced' && outcome.variants[0]?.metadata.timeline.events[0]).toEqual({
      timeMs: 700,
      confidence: 0.77,
      category: 'impact',
    });
  });

  it('takes the ambience path with no rate when nothing confident was detected (23.16)', async () => {
    const harness = createV2aHarness();
    // Events below the floor, and audio with no impacts: 23.16's exact situation.
    harness.segments.setEvents([visualEvent(500, { confidence: 0.2 })]);
    harness.segments.setImpacts([]);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    const variant = outcome.variants[0];
    expect(variant?.metadata.detectionStatus).toBe('no_visual_events_detected');
    // No rate was measured, so none is recorded — not 0, not 1.
    expect(variant?.metadata.onsetAlignmentRate).toBeNull();
    expect(variant?.alignment.kind).toBe('no_confident_events');
    // 23.16 still requires the ambience to be the clip's length.
    expect(variant?.duration.satisfied).toBe(true);
    // The event itself is still returned, with the status beside it.
    expect(variant?.metadata.timeline.events).toHaveLength(1);
  });
});

describe('the onset alignment verdict (Requirement 23.8)', () => {
  it('admits a variant whose impacts land on its confident events', async () => {
    const harness = createV2aHarness();
    harness.segments.setEvents([visualEvent(500), visualEvent(1_500), visualEvent(2_500)]);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    const variant = outcome.variants[0];
    expect(variant?.alignment.kind).toBe('measured');
    expect(variant?.metadata.onsetAlignmentRate).toBe(1);
    expect(variant?.metadata.qualityThresholdSetVersion).toBe(
      INITIAL_QUALITY_THRESHOLD_SET.version,
    );
  });

  it('fails and refunds a variant whose audio has no onset near its events', async () => {
    const harness = createV2aHarness();
    harness.segments.setEvents([visualEvent(500), visualEvent(1_500), visualEvent(2_500)]);
    // Impacts nowhere near the events: 23.8's rate is 0.
    harness.segments.setImpacts([3_800]);

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      const failures = error.details.failures as readonly { unmet: readonly string[] }[];
      return (
        error.code === 'v2a_generation_failed' &&
        error.statusCode === 422 &&
        failures[0]?.unmet.includes('onset_alignment') === true &&
        error.details.partialAudioStored === false
      );
    });

    // The refund went through the one existing path, and exactly once.
    expect(harness.generation.refunds.requests).toHaveLength(1);
  });

  it('honours a lowered rate threshold, so the number is read from the set (34.6)', async () => {
    const lowered = changeThreshold(INITIAL_QUALITY_THRESHOLD_SET, 'v2a_onset_alignment_rate_min', 0.5);
    expect(lowered.kind).toBe('applied');
    if (lowered.kind !== 'applied') return;

    const harness = createV2aHarness({ thresholds: fixedThresholdSource(lowered.set) });
    // Two events, one impact: a rate of 0.5, which passes only under the lowered threshold.
    harness.segments.setEvents([visualEvent(500), visualEvent(2_500)]);
    harness.segments.setImpacts([500]);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants[0]?.metadata.onsetAlignmentRate).toBe(0.5);
    expect(outcome.variants[0]?.metadata.qualityThresholdSetVersion).toBe(lowered.set.version);
  });
});

describe('the output length verdict (Requirement 23.9)', () => {
  it('fails and refunds a variant whose joined audio is the wrong length', async () => {
    const harness = createV2aHarness();
    // A single segment whose audio is a second short of the 4 s video.
    harness.segments.script({ kind: 'audio', audio: ambienceAudio(3_000) });

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      const failures = error.details.failures as readonly { unmet: readonly string[] }[];
      return failures[0]?.unmet.includes('output_duration') === true;
    });

    expect(harness.generation.refunds.requests).toHaveLength(1);
  });
});

describe('the preview (Requirement 23.12)', () => {
  it('muxes a preview per variant and records its 168-hour floor', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    const variant = outcome.variants[0];
    const completedAtMs = harness.generation.clock.now().getTime();

    expect(harness.preview.requests).toHaveLength(1);
    expect(variant?.metadata.previewFileId).toMatch(/^preview-/);
    expect(variant?.metadata.previewRetainedUntilMs).toBe(previewRetainedUntilMs(completedAtMs));
    expect(variant?.previewSync.satisfied).toBe(true);
    expect(variant?.metadata.previewSyncOffsetMs).toBe(0);
  });

  it('fails and refunds a variant whose preview is out of sync by more than 20 ms', async () => {
    const harness = createV2aHarness();
    harness.preview.setOffsets({ audioStartMs: 45, videoStartMs: 0 });

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      const failures = error.details.failures as readonly { unmet: readonly string[] }[];
      return failures[0]?.unmet.includes('preview_sync') === true;
    });

    expect(harness.generation.refunds.requests).toHaveLength(1);
  });
});

describe('the source video (Requirement 23.13)', () => {
  it('deletes the upload only after every preview exists, and reports the outer bound', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, variantCount: 2 },
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    // Two previews were muxed before the single discard.
    expect(harness.preview.requests).toHaveLength(2);
    expect(harness.uploads.discarded).toEqual([TEST_UPLOAD_ID]);
    expect(outcome.sourceVideoDeletionNotAfterMs).toBe(
      previewRetainedUntilMs(harness.generation.clock.now().getTime()),
    );
  });
});

describe('reproducibility (Requirement 23.14)', () => {
  /**
   * The joined audio, read off the preview muxer.
   *
   * That port is the only place the *joined* result crosses a seam a test can observe, which
   * makes it the right place to compare samples: it is what the user's preview contains and what
   * the three quality verdicts were taken on.
   */
  const joinedAudioOf = (harness: ReturnType<typeof createV2aHarness>): Buffer => {
    const samples = harness.preview.requests[0]?.audio.channels[0] ?? new Float32Array(0);
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  };

  it('produces sample-identical audio for the same seed, video and prompt', async () => {
    const run = async () => {
      const harness = createV2aHarness();
      harness.setMetadata(validVideoMetadata({ durationMs: 20_000 }));
      harness.segments.setEvents([visualEvent(600), visualEvent(9_800)]);
      const outcome = await harness.service.generate({
        accountId: 'user-1',
        request: { ...REQUEST, prompt: 'wet footsteps', seed: 99_991 },
        upload: consentingUpload(),
      });
      expect(outcome.kind).toBe('produced');
      return harness;
    };

    const first = await run();
    const second = await run();

    // Byte-wise on a multi-segment clip, so the cross-fade join is inside the claim.
    expect(joinedAudioOf(first).equals(joinedAudioOf(second))).toBe(true);
  });

  it('produces different audio for a different seed, so the property is not vacuous', async () => {
    const run = async (seed: number) => {
      const harness = createV2aHarness();
      harness.segments.setEvents([visualEvent(600)]);
      await harness.service.generate({
        accountId: 'user-1',
        request: { ...REQUEST, seed },
        upload: consentingUpload(),
      });
      return harness;
    };

    expect(joinedAudioOf(await run(11)).equals(joinedAudioOf(await run(12)))).toBe(false);
  });

  it('draws and records a seed when the caller names none', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind === 'produced' && outcome.baseSeed).toBe(TEST_V2A_BASE_SEED);
    expect(outcome.kind === 'produced' && outcome.variants[0]?.metadata.seed).toBe(
      TEST_V2A_BASE_SEED,
    );
  });
});

describe('the 900-second budget (Requirement 23.17)', () => {
  it('fails the job with the completed segment count and stores no partial audio', async () => {
    // A budget of zero: the check runs before the first segment, so nothing completes.
    const harness = createV2aHarness({ jobBudgetMs: 0 });
    harness.setMetadata(validVideoMetadata({ durationMs: 20_000 }));

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      return (
        error.code === 'v2a_generation_timed_out' &&
        error.details.completedSegmentCount === 0 &&
        error.details.segmentCount === 3 &&
        error.details.partialAudioStored === false
      );
    });

    // No engine work was started past the budget, and the job was refunded once.
    expect(harness.segments.requests).toHaveLength(0);
    expect(harness.generation.refunds.requests).toHaveLength(1);
  });

  it('reports how far a job got when the clock passes the budget mid-clip', async () => {
    const harness = createV2aHarness({ jobBudgetMs: 1_000 });
    harness.setMetadata(validVideoMetadata({ durationMs: 20_000 }));
    // Advance the clock during the first segment so the second one is past the budget.
    const original = harness.segments.generateSegment.bind(harness.segments);
    harness.segments.generateSegment = async (request) => {
      harness.generation.clock.advanceSeconds(2);
      return original(request);
    };

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isGenerationError(error) &&
        error.code === 'v2a_generation_timed_out' &&
        error.details.completedSegmentCount === 1,
    );
  });
});

describe('an engine that produces nothing (Requirements 6.1–6.3)', () => {
  it('fails the request without adding a second refund path', async () => {
    const harness = createV2aHarness();
    harness.segments.script({ kind: 'unproduced', reason: 'model unavailable' });

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: REQUEST,
        upload: consentingUpload(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isGenerationError(error)) return false;
      const failures = error.details.failures as readonly { reason: string }[];
      return error.code === 'v2a_generation_failed' && failures[0]?.reason === 'engine_failure';
    });

    // One refund, through `createJobQualityRejection` — the same path 21.18 and 22.19 use.
    expect(harness.generation.refunds.requests).toHaveLength(1);
  });

  it('keeps the variants that did succeed when only one failed (23.1s 1–4 range)', async () => {
    const harness = createV2aHarness();
    // Variant 0's only segment produces nothing; variant 1 is left to the default.
    harness.segments.script({ kind: 'unproduced' });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, variantCount: 2 },
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants).toHaveLength(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.reason).toBe('engine_failure');
  });
});

describe('moderation (Requirements 16.2, 16.11)', () => {
  it('refuses the whole request and charges nothing when the prompt is blocked', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: { ...REQUEST, prompt: 'blocked prompt', variantCount: 4 },
      upload: consentingUpload(),
      moderate: () => ({
        outcome: 'blocked' as const,
        blocks: [{ code: 'policy_violation' as const, violations: [] }],
        violationClasses: [],
        texts: [],
      }),
    });

    expect(outcome.kind).toBe('blocked');
    expect(harness.generation.charges.requests).toHaveLength(0);
    // One verdict settles every variant; the rest were never attempted.
    expect(harness.segments.requests).toHaveLength(0);
  });
});

describe('the produced audio shape', () => {
  it('reports the joined audios rate and channel count on the asset', async () => {
    const harness = createV2aHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind === 'produced' && outcome.variants[0]?.metadata.sampleRate).toBe(
      TEST_SAMPLE_RATE,
    );
    expect(outcome.kind === 'produced' && outcome.variants[0]?.metadata.channels).toBe(1);
  });

  it('measures the joined audio, not a segment, so a straddling impact is counted once', async () => {
    const harness = createV2aHarness();
    harness.setMetadata(validVideoMetadata({ durationMs: 16_000 }));
    // An event inside the first overlap region, at 7 960 ms.
    harness.segments.setEvents([visualEvent(7_960)]);

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') return;
    expect(outcome.variants[0]?.metadata.timeline.events.map((event) => event.timeMs)).toEqual([
      7_960,
    ]);
    expect(outcome.variants[0]?.alignment.kind).toBe('measured');
  });
});

describe('audio scripted directly', () => {
  it('accepts a foley buffer of the right length with impacts on its events', async () => {
    const harness = createV2aHarness();
    harness.segments.setEvents([visualEvent(1_000)]);
    harness.segments.script({
      kind: 'audio',
      audio: foleyAudio({ durationMs: 4_000, impactTimesMs: [1_000] }),
      events: [visualEvent(1_000)],
    });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: REQUEST,
      upload: consentingUpload(),
    });

    expect(outcome.kind === 'produced' && outcome.variants[0]?.metadata.onsetAlignmentRate).toBe(1);
  });
});
