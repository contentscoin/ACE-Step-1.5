import { describe, expect, it } from 'vitest';

import { BGM_LOOP_QUALITY_MAX_ATTEMPTS } from '../../../domain/bgm/bounds';
import { fixedThresholdSource } from '../../../domain/quality/threshold-source';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  changeThreshold,
} from '../../../domain/quality/threshold-set';
import { isGenerationError } from '../../../services/generation/errors';
import { BGM_DURATION_BOUNDS } from '../../../services/sound/bgm-service';
import {
  DEFAULT_BGM_BPM,
  DEFAULT_BGM_TIME_SIGNATURE,
  bgmLoopRequest,
  bgmRequest,
  createBgmHarness,
} from '../../support/bgm-harness';
import {
  compliantLoop,
  monoAudio,
  withClickAt,
  withFadeIn,
  withFadeOut,
} from '../../support/pcm-synthesis';

/**
 * BGM_Service — the whole Requirement 21 flow over the real job lifecycle.
 *
 * **Validates: Requirements 21.1, 21.3, 21.4, 21.6, 21.13, 21.15, 21.18, 34.6**
 *
 * The orchestrator, the credit ports and the refund path are the production ones (see
 * `test/support/bgm-harness.ts`), so the Requirement 21.18 refund is counted where every
 * other refund in the system is counted. The one fake is the seam onto engine-produced
 * audio, which is what lets "attempts 1 and 2 fail the seam, attempt 3 passes" be stated.
 */

const bpm = DEFAULT_BGM_BPM;
const timeSignature = DEFAULT_BGM_TIME_SIGNATURE;

/** 4 bars at 120 BPM in 4/4 — 8 seconds, meeting all four criteria. */
function goodLoop() {
  return compliantLoop({ bpm, timeSignature, barCount: 4 }).audio;
}

/** The same loop with a full-scale click at the seam: Requirement 21.8 fails. */
function clickingLoop() {
  const channel = goodLoop().channels[0];
  if (channel === undefined) throw new Error('no channel');
  return monoAudio(withClickAt(channel, channel.length - 1, 1.0));
}

/** The same loop with deep symmetric fades: Requirement 21.16 fails. */
function dippingLoop() {
  const channel = goodLoop().channels[0];
  if (channel === undefined) throw new Error('no channel');
  return monoAudio(withFadeIn(withFadeOut(channel, 400), 400));
}

describe('accepting a request (Requirements 21.1, 21.4)', () => {
  it('produces a bgm asset through the song gateway with assetKind bgm', async () => {
    const harness = createBgmHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmRequest(),
    });

    expect(outcome.kind).toBe('produced');
    // Design §3.6: `bgm` is ACE-Step with the instrumental parameters fixed. One
    // gateway, one validator, one wire mapping — reused, not duplicated.
    const stored = await harness.generation.store.find(
      outcome.kind === 'produced' ? outcome.jobId : '',
    );
    expect(stored?.input.assetKind).toBe('bgm');
  });

  it('sends the engine an instrumental request with no lyrics (Requirement 21.4)', async () => {
    const harness = createBgmHarness();

    await harness.service.generate({ accountId: 'user-1', request: bgmRequest() });

    const submitted = harness.generation.adapter.submitted[0];
    expect(submitted?.assetKind).toBe('bgm');
    // The caption is what carries mood, scene and instrumentation; there is no lyrics
    // field on a `bgm` request to leak vocals through.
    expect(submitted?.prompt).toContain('rain-soaked street');
  });

  it('records the ten metadata fields and the threshold version', async () => {
    const harness = createBgmHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });
    if (outcome.kind !== 'produced') throw new Error('expected audio');

    expect(outcome.metadata).toMatchObject({
      bpm,
      timeSignature,
      isLoop: true,
      channels: 1,
      sampleRate: 48_000,
      durationMs: 8_000,
      barCount: 4,
      intensityStep: 1,
      lyrics: '',
      qualityThresholdSetVersion: INITIAL_QUALITY_THRESHOLD_SET.version,
    });
    expect(Number.isFinite(outcome.metadata.integratedLoudnessLufs)).toBe(true);
  });

  it('overrides Requirement 4.2 with Requirement 21.2 bounds', () => {
    expect(BGM_DURATION_BOUNDS).toEqual({ minSeconds: 5, maxSeconds: 600 });
  });

  it('accepts a 5-second request, which Requirement 4.2 alone would refuse', async () => {
    // The reason `SongGateway` takes duration bounds at all: a 5-second loop is a normal
    // ask, and the song validator's 10 s floor would otherwise reject it.
    const harness = createBgmHarness();

    await expect(
      harness.service.generate({
        accountId: 'user-1',
        request: bgmRequest({ targetLengthSeconds: 5 }),
      }),
    ).resolves.toMatchObject({ kind: 'produced' });
  });
});

describe('rejecting a request before anything is charged (Requirement 21.3)', () => {
  it('throws bgm_request_invalid with the violated fields and their bounds', async () => {
    const harness = createBgmHarness();

    const error = await harness.service
      .generate({
        accountId: 'user-1',
        request: bgmRequest({ sceneDescription: '', targetLengthSeconds: 900 }),
      })
      .catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('bgm_request_invalid');
    const violations = (error.details as { violations: { field: string }[] }).violations;
    expect(violations.map((violation) => violation.field).sort()).toEqual([
      'sceneDescription',
      'targetLengthSeconds',
    ]);
  });

  it('charges nothing and creates no job for a rejected request', async () => {
    const harness = createBgmHarness();

    await harness.service
      .generate({ accountId: 'user-1', request: bgmRequest({ targetLengthSeconds: 1 }) })
      .catch(() => undefined);

    expect(harness.generation.charges.requests).toHaveLength(0);
    expect(harness.candidates.calls).toHaveLength(0);
  });
});

describe('the loop quality gate (Requirements 21.6, 21.18)', () => {
  it('makes only one attempt for a non-loop request', async () => {
    // The four seam criteria are all conditioned on "루프 배경음악을 선택한 경우", so a
    // non-loop cue is not judged against them and is never regenerated for them.
    const harness = createBgmHarness();
    harness.candidates.script({ kind: 'audio', audio: clickingLoop() });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmRequest({ loop: false }),
    });

    expect(outcome).toMatchObject({ kind: 'produced', attempts: 1 });
    expect(outcome.kind === 'produced' ? outcome.loop : undefined).toBeNull();
    expect(harness.candidates.calls).toHaveLength(1);
  });

  it('accepts a compliant loop on the first attempt', async () => {
    const harness = createBgmHarness();
    harness.candidates.script({ kind: 'audio', audio: goodLoop() });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });

    expect(outcome).toMatchObject({ kind: 'produced', attempts: 1 });
    expect(outcome.kind === 'produced' ? outcome.loop?.satisfied : undefined).toBe(true);
    expect(harness.generation.refunds.requests).toHaveLength(0);
  });

  it('regenerates after a failed seam and succeeds on the third attempt', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(
      { kind: 'audio', audio: clickingLoop() },
      { kind: 'audio', audio: dippingLoop() },
      { kind: 'audio', audio: goodLoop() },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });

    expect(outcome).toMatchObject({ kind: 'produced', attempts: 3 });
    // The two rejected attempts were each failed and refunded as they happened, rather
    // than left as succeeded jobs holding a charge.
    expect(harness.generation.refunds.requests).toHaveLength(2);
  });

  it('uses a different seed on every attempt (Requirement 21.18)', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(
      { kind: 'audio', audio: clickingLoop() },
      { kind: 'audio', audio: clickingLoop() },
      { kind: 'audio', audio: goodLoop() },
    );

    await harness.service.generate({ accountId: 'user-1', request: bgmLoopRequest() });

    const seeds = harness.seeds();
    expect(seeds).toHaveLength(3);
    expect(new Set(seeds).size).toBe(3);
  });

  it('keeps a caller-supplied seed for the first attempt and moves off it after', async () => {
    // Requirement 4.10's reproducibility promise applies to the request as made, so the
    // first attempt honours the seed; only the retries vary it.
    const harness = createBgmHarness();
    harness.candidates.script(
      { kind: 'audio', audio: clickingLoop() },
      { kind: 'audio', audio: goodLoop() },
    );

    await harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest({ seed: 4_242 }),
    });

    const seeds = harness.seeds();
    expect(seeds[0]).toBe(4_242);
    expect(seeds[1]).not.toBe(4_242);
  });

  it('fails after three attempts, refunds in full, and names the unmet criteria', async () => {
    const harness = createBgmHarness();
    harness.candidates.setDefault({ kind: 'audio', audio: clickingLoop() });

    const error = await harness.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('bgm_loop_quality_unmet');

    const details = error.details as {
      unmet: string[];
      attempts: number;
      refundedAmount: number;
      criteria: { criterion: string; requirement: string }[];
      qualityThresholdSetVersion: number;
    };
    expect(details.attempts).toBe(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
    expect(details.unmet).toEqual(['seam_sample_step']);
    expect(details.criteria).toEqual([
      { criterion: 'seam_sample_step', requirement: '21.8' },
    ]);
    expect(details.qualityThresholdSetVersion).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);

    // "차감된 크레딧 전액" — every attempt was charged, and every charge came back.
    expect(harness.candidates.calls).toHaveLength(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
    expect(harness.generation.charges.requests).toHaveLength(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
    expect(harness.generation.refunds.requests).toHaveLength(BGM_LOOP_QUALITY_MAX_ATTEMPTS);

    const debited = harness.generation.refunds.requests.reduce(
      (total, request) => total + request.amount,
      0,
    );
    expect(details.refundedAmount).toBe(debited);
    expect(details.refundedAmount).toBeGreaterThan(0);
  });

  it('fails each rejected attempt as a job, with the criteria in the failure detail', async () => {
    const harness = createBgmHarness();
    harness.candidates.setDefault({ kind: 'audio', audio: dippingLoop() });

    await harness.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch(() => undefined);

    const jobs = await Promise.all(
      harness.candidates.calls.map((call) => harness.generation.store.find(call.jobId)),
    );
    for (const job of jobs) {
      expect(job?.lifecycle.state).toBe('failed');
      expect(job?.lifecycle.failure?.reason).toBe('loop_quality_unmet');
      expect(job?.lifecycle.failure?.detail).toBe('edge_energy');
      // Classified as an engine error, so Requirement 6.4 lets the user retry it.
      expect(job?.lifecycle.failure?.retryable).toBe(true);
    }
  });

  it('names every unmet criterion, not just the first', async () => {
    const harness = createBgmHarness();
    // A fade-out only: an edge dip and a seam level jump at once.
    const channel = goodLoop().channels[0];
    if (channel === undefined) throw new Error('no channel');
    harness.candidates.setDefault({
      kind: 'audio',
      audio: monoAudio(withFadeOut(channel, 400)),
    });

    const error = await harness.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch((thrown: unknown) => thrown);

    if (!isGenerationError(error)) throw new Error('expected a GenerationError');
    const details = error.details as { unmet: string[] };
    expect(details.unmet).toContain('edge_energy');
    expect(details.unmet).toContain('seam_rms_difference');
  });
});

describe('thresholds are read from the set in force (Requirement 34)', () => {
  it('admits a loop a loosened set permits', async () => {
    const relaxed = changeThreshold(
      INITIAL_QUALITY_THRESHOLD_SET,
      'loop_seam_sample_step_ratio_max',
      0.25,
    );
    if (relaxed.kind !== 'applied') throw new Error('expected the change to apply');

    const harness = createBgmHarness({ thresholds: fixedThresholdSource(relaxed.set) });
    // A step of 20% of peak: refused by the initial 5% and admitted by the loosened 25%.
    const channel = goodLoop().channels[0];
    if (channel === undefined) throw new Error('no channel');
    harness.candidates.setDefault({
      kind: 'audio',
      audio: monoAudio(withClickAt(channel, channel.length - 1, 0.1)),
    });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });

    expect(outcome).toMatchObject({ kind: 'produced', attempts: 1 });
    // Requirement 34.6: the asset records the version it was admitted under.
    expect(outcome.kind === 'produced' ? outcome.metadata.qualityThresholdSetVersion : 0).toBe(2);
  });

  it('reads the set once per cue, so every attempt is judged against one version', async () => {
    const harness = createBgmHarness();
    harness.candidates.script(
      { kind: 'audio', audio: clickingLoop() },
      { kind: 'audio', audio: goodLoop() },
    );

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });
    if (outcome.kind !== 'produced') throw new Error('expected audio');

    expect(outcome.loop?.thresholdSetVersion).toBe(
      outcome.metadata.qualityThresholdSetVersion,
    );
  });
});

describe('reference asset agreement (Requirements 21.12, 21.13)', () => {
  it('reports BPM within ±1 and an identical key', async () => {
    const harness = createBgmHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmRequest({
        reference: { assetId: 'ref-1', bpm: 120, keyScale: 'C major' },
      }),
    });
    if (outcome.kind !== 'produced') throw new Error('expected audio');

    expect(outcome.reference).toEqual({
      bpmDeltaAbsolute: 0,
      bpmWithinTolerance: true,
      keyIdentical: true,
    });
  });

  it('pins the reference BPM and key onto the engine request (Requirement 21.12)', async () => {
    const harness = createBgmHarness();

    await harness.service.generate({
      accountId: 'user-1',
      request: bgmRequest({
        bpm: 90,
        keyScale: 'A minor',
        reference: { assetId: 'ref-1', bpm: 128, keyScale: 'F major' },
      }),
    });

    const stored = await harness.generation.store.find('id-001');
    expect(stored?.input.song).toMatchObject({ bpm: 128, keyScale: 'F major' });
  });

  it('reports a disagreement rather than hiding it', async () => {
    // 21.12 pins the reference as a *generation parameter*; the recorded metadata is
    // whatever the engine reported. So the agreement is measured and returned.
    const harness = createBgmHarness();
    harness.candidates.setDefault({ kind: 'audio', audio: goodLoop(), bpm: 124 });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmRequest({ reference: { assetId: 'ref-1', bpm: 120, keyScale: 'C major' } }),
    });
    if (outcome.kind !== 'produced') throw new Error('expected audio');

    expect(outcome.reference).toMatchObject({ bpmWithinTolerance: false, bpmDeltaAbsolute: 4 });
  });

  it('reports no agreement when no reference was named', async () => {
    const harness = createBgmHarness();

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmRequest(),
    });

    expect(outcome.kind === 'produced' ? outcome.reference : undefined).toBeNull();
  });
});
