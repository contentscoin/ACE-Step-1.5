/**
 * V2A_Service — foley generation from video (Requirement 23; design §5.4).
 *
 * It owns six things and delegates everything else:
 *
 * 1. **Upload validation** (23.2–23.4) — through `domain/v2a/validation.ts` over a probed
 *    metadata record, and the discard of the rejected file, which is the half of 23.4 a
 *    predicate cannot express.
 * 2. **The rights-consent gate** (23.11) — through the *existing*
 *    `domain/moderation/upload-consent.ts`, which Requirement 16.14 already models for
 *    exactly this upload purpose. Nothing about video-rights consent is restated here.
 * 3. **Segmentation and sequential generation** (23.6, 23.7) — the plan and the 24 fps
 *    sampling come from `domain/v2a/`; this service walks the plan in order and joins what
 *    comes back with the cross-fade the same module implements.
 * 4. **The Visual_Event_Timeline** (23.15, 23.16) — segment-relative events shifted to
 *    clip-relative times, merged, sorted and given a detection status.
 * 5. **The three quality verdicts** (23.8, 23.9, 23.12) — measured, judged against the
 *    Quality_Threshold_Set in force, and on a miss the variant's job is failed with a refund
 *    through the one existing refund path.
 * 6. **The 900-second budget** (23.17) — checked against the same `JOB_TIMEOUT_MS` Requirement
 *    5.8 uses, reporting how many segments completed and storing no partial audio.
 *
 * ### Why one Generation_Job per variant
 *
 * The same reasoning as `sfx-service.ts`, reached from the other direction. Requirement 23.1
 * asks for a Generation_Job producing 1–4 assets; Requirement 23.17 fails "해당
 * Generation_Job" as a unit. Making each variant its own job keeps both true — each job
 * produces one asset and fails as a unit — and means a quality miss on one variant refunds
 * exactly that variant through `createJobQualityRejection`, the same function Requirements
 * 21.18 and 22.19 use. **One refund path in the system, not two.**
 *
 * The segments of 23.7 are *inside* one variant's job, not jobs of their own: 23.7 calls them
 * "구간" of a single generation and 23.17 counts them as progress within one job, so a segment
 * has no independent lifecycle, no independent charge and nothing to refund.
 *
 * ### Requirement 23.16's ambience path
 *
 * A clip with no confident visual event is not a failure. 23.16 requires ambience audio of the
 * clip's length, with a status saying nothing was detected — so the alignment verdict for such
 * a clip is `no_confident_events`, which `isAlignmentSatisfied` treats as satisfied, and the
 * asset is published with `onsetAlignmentRate: null`. The length invariant of 23.9 still
 * applies, because 23.16 says the ambience is "영상 길이와 같은 길이".
 *
 * ### What is not built here
 *
 * No video decoding, no frame extraction and no container muxing. All three are task 3.1's
 * Python DSP worker and sit behind the ports in `v2a-ports.ts`. **No V2A engine exists in
 * design §3.6's engine↔Asset_Kind table**, which is a genuine gap reported with this task:
 * the service submits `sfx` jobs with `inputModality: 'video'`, so routing (Requirement
 * 20.5/20.6) needs an `sfx` engine whose declared maximum output duration covers Requirement
 * 23.3's 60 s ceiling — the Woosh descriptors declare 10 s, which is Requirement 22.4's cap
 * and not this one.
 */

import { fixedThresholdSource, type QualityThresholdSource } from '../../domain/quality/threshold-source';
import {
  v2aDurationThresholds,
  v2aOnsetAlignmentThresholds,
  v2aPreviewSyncThresholds,
} from '../../domain/quality/v2a-thresholds';
import type { JobFailure } from '../../domain/generation-job/failure';
import { jobTimeoutFailure } from '../../domain/generation-job/failure';
import { JOB_TIMEOUT_MS } from '../../domain/generation-job/timeout';
import {
  hasValidRightsConsent,
  type UploadDeclaration,
} from '../../domain/moderation/upload-consent';
import { variantSeed, type SeedSource } from '../../domain/sfx/seed';
import { evaluateOnsetAlignment, isAlignmentSatisfied } from '../../domain/v2a/alignment';
import { V2A_SAMPLE_FRAME_RATE } from '../../domain/v2a/bounds';
import { evaluateOutputDuration } from '../../domain/v2a/duration';
import { planFrameSampling } from '../../domain/v2a/frame-sampling';
import { evaluatePreviewSync } from '../../domain/v2a/preview';
import { resolveV2aParameters, type V2aGenerationRequest, type V2aParameters } from '../../domain/v2a/request';
import { previewRetainedUntilMs, sourceVideoDeletionWindow } from '../../domain/v2a/retention';
import { crossfadeJoin, segmentPlan, type SegmentPlan, type VideoSegment } from '../../domain/v2a/segmentation';
import { onsetTimesMs } from '../../domain/v2a/onset';
import { validateV2aUpload, validateV2aVariantCount } from '../../domain/v2a/validation';
import { sourceFrameCount, type ProbedVideoMetadata } from '../../domain/v2a/video-metadata';
import {
  buildVisualEventTimeline,
  type VisualEvent,
  type VisualEventTimeline,
} from '../../domain/v2a/visual-event-timeline';
import type { PcmAudio } from '../../domain/audio/pcm';
import type { Clock } from '../clock';
import type { JobOrchestrator } from '../generation/job-orchestrator';
import type { BlockedModeration, ModerationDecision } from '../moderation/decision';

import type { AudioMeasurementPort } from './measurement';
import {
  v2aConsentMissing,
  v2aGenerationFailed,
  v2aRequestRejected,
  v2aUploadRejected,
  v2aUploadUnreadable,
} from './v2a-errors';
import type {
  V2aFrameSourcePort,
  V2aPreviewMuxPort,
  V2aQualityRejectionPort,
  V2aSegmentPort,
  V2aUploadPort,
} from './v2a-ports';
import {
  v2aAppliedDefaults,
  v2aMetadata,
  type FailedV2aVariant,
  type ProducedV2aVariant,
  type V2aOutcome,
  type V2aQualityCriterion,
} from './v2a-result';

export interface V2aServiceOptions {
  readonly orchestrator: JobOrchestrator;
  readonly uploads: V2aUploadPort;
  readonly frames: V2aFrameSourcePort;
  readonly segments: V2aSegmentPort;
  readonly preview: V2aPreviewMuxPort;
  readonly measurement: AudioMeasurementPort;
  /** Requirements 23.8/23.9/23.12's fail-and-refund step. */
  readonly rejection: V2aQualityRejectionPort;
  /** Requirement 23.14's draw. */
  readonly seeds: SeedSource;
  readonly clock: Clock;
  /** Requirement 34: the set in force. Defaults to the initial values (34.3). */
  readonly thresholds?: QualityThresholdSource;
  /** Requirement 23.17's budget. Defaults to Requirement 5.8's 900 s. */
  readonly jobBudgetMs?: number;
}

export interface V2aSubmissionInput {
  readonly accountId: string;
  readonly request: V2aGenerationRequest;
  /**
   * Requirement 23.11 / 16.14: the uploader's declaration for this video.
   *
   * Required rather than optional. 23.11 refuses a request whose consent "기록되지 않은" —
   * absent consent is the case it legislates for, and making the declaration optional here
   * would let a caller reach generation by simply not mentioning it.
   */
  readonly upload: UploadDeclaration;
  /** Engine named by the caller (Requirement 20.3). */
  readonly engineId?: string;
  /** Content policy verdict, evaluated lazily by the orchestrator (design §9.1). */
  readonly moderate?: () => ModerationDecision;
}

export class V2aService {
  private readonly orchestrator: JobOrchestrator;
  private readonly uploads: V2aUploadPort;
  private readonly frames: V2aFrameSourcePort;
  private readonly segments: V2aSegmentPort;
  private readonly preview: V2aPreviewMuxPort;
  private readonly measurement: AudioMeasurementPort;
  private readonly rejection: V2aQualityRejectionPort;
  private readonly seeds: SeedSource;
  private readonly clock: Clock;
  private readonly thresholds: QualityThresholdSource;
  private readonly jobBudgetMs: number;

  constructor(options: V2aServiceOptions) {
    this.orchestrator = options.orchestrator;
    this.uploads = options.uploads;
    this.frames = options.frames;
    this.segments = options.segments;
    this.preview = options.preview;
    this.measurement = options.measurement;
    this.rejection = options.rejection;
    this.seeds = options.seeds;
    this.clock = options.clock;
    this.thresholds = options.thresholds ?? fixedThresholdSource();
    this.jobBudgetMs = options.jobBudgetMs ?? JOB_TIMEOUT_MS;
  }

  /**
   * Requirements 23.1, 23.5–23.17.
   *
   * The order is load-bearing and mirrors `JobOrchestrator.submit`'s: request parameters, then
   * consent, then probe, then validate, then generate. The variant cap of 23.1 first because it
   * is decidable from the request alone and a request that cannot be satisfied must not cause a
   * probe; consent next because 23.11 refuses the request outright; validation before any
   * submission because 23.4 must reject before anything is charged.
   */
  async generate(input: V2aSubmissionInput): Promise<V2aOutcome> {
    // Requirement 23.1's 1–4 cap. Before the consent check because it needs nothing but the
    // request, and before the probe because 23.1 cannot be satisfied for a count outside it.
    const requestCheck = validateV2aVariantCount(input.request.variantCount);
    if (requestCheck.kind === 'invalid') throw v2aRequestRejected(requestCheck.violations);

    const parameters = resolveV2aParameters(input.request);

    // Requirement 23.11 / 16.14 — before the file is even opened.
    if (!hasValidRightsConsent(input.upload)) {
      await this.uploads.discard(parameters.uploadId);
      throw v2aConsentMissing(parameters.uploadId, ['holdsRights']);
    }

    const metadata = await this.probeAndValidate(parameters.uploadId);
    return this.runVariants(input, parameters, metadata);
  }

  /** Requirements 23.2–23.4, including the "not stored" half of 23.4. */
  private async probeAndValidate(uploadId: string): Promise<ProbedVideoMetadata> {
    const probed = await this.uploads.probe(uploadId);

    if (probed.kind === 'unreadable') {
      await this.uploads.discard(uploadId);
      throw v2aUploadUnreadable(uploadId, probed.detail);
    }

    const validation = validateV2aUpload(probed.metadata);
    if (validation.kind === 'invalid') {
      // Requirement 23.4: "해당 업로드 파일을 저장하지 않는다". The discard happens before the
      // rejection is thrown, so there is no path on which the caller learns of the refusal
      // while the file is still held.
      await this.uploads.discard(uploadId);
      throw v2aUploadRejected({
        uploadId,
        violations: validation.violations,
        constraints: validation.constraints,
        uploadDiscarded: true,
      });
    }

    return validation.metadata;
  }

  /** Requirements 23.1, 23.14: the fan-out over variants and the seed derivation. */
  private async runVariants(
    input: V2aSubmissionInput,
    parameters: V2aParameters,
    metadata: ProbedVideoMetadata,
  ): Promise<V2aOutcome> {
    // Read once per request, not once per variant or once per segment: an operator change
    // landing mid-generation would otherwise judge one segment against version 3 and the next
    // against version 4, and Requirement 34.6 records one version per asset.
    const set = this.thresholds.current();
    const alignmentThresholds = v2aOnsetAlignmentThresholds(set);
    const durationThresholds = v2aDurationThresholds(set);
    const syncThresholds = v2aPreviewSyncThresholds(set);

    // Requirement 23.7 — the split is a property of the clip, so it is computed once and
    // shared by every variant. Two variants of one request must be segmented identically or
    // Requirement 23.14's reproducibility would depend on which variant you asked for.
    const plan = segmentPlan(metadata.durationMs);

    // Requirement 23.14: the caller's seed, or one drawn now and recorded on every asset.
    const baseSeed = parameters.seed ?? this.seeds.draw();

    const produced: ProducedV2aVariant[] = [];
    const failures: FailedV2aVariant[] = [];
    let refundedAmount = 0;
    let deepestSegmentCount = 0;
    let timedOut = false;
    let lastFailure: JobFailure | null = null;
    let lastJobId: string | null = null;
    // Requirement 23.13's `notBefore`: the source may only be deleted once *every* preview
    // referencing it exists, so the latest preview instant is the binding one.
    let latestPreviewCreatedAtMs = Number.NEGATIVE_INFINITY;
    // Whichever engine routing actually chose, which is not necessarily the one the caller
    // named — Requirement 20.10 may have substituted a fallback.
    let engineId = input.engineId ?? '';

    for (let index = 0; index < parameters.variantCount; index += 1) {
      const seed = variantSeed(baseSeed, index);
      const submitted = await this.submitVariant(input, parameters, metadata, seed);

      // Requirements 16.2/16.11: the prompt and the video are shared, so one block refuses the
      // whole request and the remaining variants are never attempted or charged for.
      if (submitted.kind === 'blocked') return submitted;

      if (submitted.kind === 'unproduced') {
        // Requirements 6.1–6.3 already refunded this job; nothing to settle here.
        lastFailure = submitted.failure;
        lastJobId = submitted.jobId;
        failures.push({
          seed,
          jobId: submitted.jobId,
          reason: 'engine_failure',
          unmet: [],
          failure: submitted.failure,
          completedSegmentCount: 0,
        });
        continue;
      }

      const { jobId } = submitted;
      lastJobId = jobId;
      engineId = submitted.engineId;
      const run = await this.runSegments({
        jobId,
        accountId: input.accountId,
        parameters,
        metadata,
        plan,
        seed,
        // Requirement 34.6: the same version every other verdict for this request is taken
        // against, passed down rather than re-read, so a mid-request operator change cannot
        // split one asset's judgements across two sets.
        confidenceMin: alignmentThresholds.visualEventConfidenceMin,
      });
      deepestSegmentCount = Math.max(deepestSegmentCount, run.completedSegmentCount);

      if (run.kind !== 'complete') {
        // Requirement 23.17: the job is failed and refunded, and no partial audio is stored.
        // The refund goes through the same path a quality miss uses, because the job is still
        // holding a charge either way — a timeout is not an engine refusal that Requirement
        // 6.3 has already settled.
        const rejected = await this.rejection.reject({
          jobId,
          accountId: input.accountId,
          unmet: [],
        });
        refundedAmount += rejected.refundedAmount;
        if (run.kind === 'timed_out') timedOut = true;
        lastFailure = run.failure;
        failures.push({
          seed,
          jobId,
          reason: 'engine_failure',
          unmet: [],
          failure: run.failure,
          completedSegmentCount: run.completedSegmentCount,
        });
        continue;
      }

      const judged = await this.judge({
        joined: run.audio,
        timeline: run.timeline,
        metadata,
        alignmentThresholds,
        durationThresholds,
      });

      // Requirement 23.12 — the preview is muxed before the verdict is final, because the sync
      // offset is one of the three criteria. A variant rejected for sync has a preview file
      // that nothing references; discarding it is the preview store's own lifecycle concern,
      // not a second refund path.
      const muxed = await this.preview.mux({
        uploadId: parameters.uploadId,
        jobId,
        audio: run.audio,
      });
      const previewSync = evaluatePreviewSync(muxed, syncThresholds);

      const unmet: V2aQualityCriterion[] = [...judged.unmet];
      if (!previewSync.satisfied) unmet.push('preview_sync');

      if (unmet.length > 0) {
        const rejected = await this.rejection.reject({
          jobId,
          accountId: input.accountId,
          unmet,
        });
        refundedAmount += rejected.refundedAmount;
        failures.push({
          seed,
          jobId,
          reason: 'quality_unmet',
          unmet,
          failure: null,
          completedSegmentCount: run.completedSegmentCount,
        });
        continue;
      }

      const shape = await this.measurement.measureShape({ kind: 'pcm', audio: run.audio });
      const completedAtMs = this.clock.now().getTime();
      latestPreviewCreatedAtMs = Math.max(latestPreviewCreatedAtMs, muxed.createdAtMs);

      produced.push({
        jobId,
        assetId: submitted.assetId,
        seed,
        alignment: judged.alignment,
        duration: judged.duration,
        previewSync,
        segmentCount: plan.segments.length,
        metadata: v2aMetadata({
          parameters,
          seed,
          timeline: run.timeline,
          alignment: judged.alignment,
          shape,
          inputVideoDurationMs: metadata.durationMs,
          segmentCount: plan.segments.length,
          preview: muxed,
          previewSync,
          previewRetainedUntilMs: previewRetainedUntilMs(completedAtMs),
          qualityThresholdSetVersion: set.version,
        }),
      });
    }

    if (produced.length === 0) {
      throw v2aGenerationFailed({
        jobId: lastJobId,
        failures,
        refundedAmount,
        completedSegmentCount: deepestSegmentCount,
        segmentCount: plan.segments.length,
        qualityThresholdSetVersion: set.version,
        timedOut,
        failure: lastFailure,
      });
    }

    // Requirement 23.13 — the source video is deleted once every preview referencing it exists
    // ("미리보기 영상 파일 생성이 완료된 이후"), and the outer bound of the permitted window
    // travels back so a sweep or an audit can check it. The discard therefore happens here,
    // after the loop, not per variant: deleting after the first preview would starve the second.
    const completedAtMs = this.clock.now().getTime();
    const deletionWindow = sourceVideoDeletionWindow(completedAtMs, latestPreviewCreatedAtMs);
    await this.uploads.discard(parameters.uploadId);

    return {
      kind: 'produced',
      variants: produced,
      failures,
      refundedAmount,
      applied: v2aAppliedDefaults(parameters),
      baseSeed,
      engineId,
      segmentCount: plan.segments.length,
      inputVideoDurationMs: metadata.durationMs,
      sourceVideoDeletionNotAfterMs: deletionWindow.notAfterMs,
    };
  }

  /** One variant's Generation_Job. `resultCount: 1`, so 23.1's cap is the variant count. */
  private async submitVariant(
    input: V2aSubmissionInput,
    parameters: V2aParameters,
    metadata: ProbedVideoMetadata,
    seed: number,
  ): Promise<SubmittedV2aVariant> {
    const outcome = await this.orchestrator.submit({
      accountId: input.accountId,
      // Requirement 23.1: foley produces `sfx` assets.
      assetKind: 'sfx',
      inputModality: 'video',
      // The whole clip, not one segment: this is what the user receives, what Requirement 2.2
      // prices and what Requirement 20.6 routes by. See the note in the module comment about
      // design §3.6 declaring no engine with the reach Requirement 23.3 needs.
      durationMs: Math.round(metadata.durationMs),
      ...(parameters.prompt === null ? {} : { prompt: parameters.prompt }),
      inputAssetIds: [parameters.uploadId],
      seed,
      ...(input.engineId === undefined ? {} : { engineId: input.engineId }),
      resultCount: 1,
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    });

    if (outcome.kind === 'blocked') return { kind: 'blocked', decision: outcome.decision };
    if (outcome.kind === 'failed') {
      return { kind: 'unproduced', jobId: outcome.jobId, failure: outcome.failure };
    }

    return {
      kind: 'accepted',
      jobId: outcome.acceptance.jobId,
      engineId: outcome.acceptance.engineId,
      assetId: `${outcome.acceptance.jobId}-asset-0`,
      acceptedAtMs: this.clock.now().getTime(),
    };
  }

  /**
   * Requirements 23.6, 23.7, 23.15, 23.17 — the sequential walk over the segments.
   *
   * Sequential rather than concurrent because 23.7 says "순차 생성" and because the join
   * consumes each overlap once, in order. Concurrency would also make the segment count of
   * 23.17 ambiguous: "how many completed" is only meaningful for an ordered walk.
   */
  private async runSegments(input: SegmentRunInput): Promise<SegmentRun> {
    const startedAtMs = this.clock.now().getTime();
    const audios: PcmAudio[] = [];
    const events: VisualEvent[] = [];

    for (const segment of input.plan.segments) {
      // Requirement 23.17, checked *before* each segment rather than after: a job already past
      // its budget must not start more engine work, and the count reported is the number that
      // genuinely finished.
      if (this.clock.now().getTime() - startedAtMs >= this.jobBudgetMs) {
        return {
          kind: 'timed_out',
          completedSegmentCount: audios.length,
          failure: jobTimeoutFailure(
            `${String(audios.length)}/${String(input.plan.segments.length)} foley segments completed`,
          ),
        };
      }

      const sampled = await this.frames.sample({
        uploadId: input.parameters.uploadId,
        segment,
        // Requirement 23.6: 24 fps, with the previous frame duplicated when the source is
        // slower. The plan is per segment because a segment's frame indices are relative to
        // its own start.
        plan: planFrameSampling({
          sourceFrameRate: input.metadata.frameRate,
          sourceFrameCount: segmentSourceFrameCount(input.metadata, segment),
          durationMs: segment.durationMs,
          targetFrameRate: V2A_SAMPLE_FRAME_RATE,
        }),
      });

      const outcome = await this.segments.generateSegment({
        jobId: input.jobId,
        accountId: input.accountId,
        segment,
        frames: sampled,
        prompt: input.parameters.prompt,
        seed: input.seed,
      });

      if (outcome.kind === 'unproduced') {
        return {
          kind: 'failed',
          completedSegmentCount: audios.length,
          failure: outcome.failure,
        };
      }

      audios.push(outcome.result.audio);
      // Requirement 23.15: the timeline is clip-relative, and only this loop knows the offset.
      for (const event of outcome.result.events) {
        events.push({ ...event, timeMs: segment.startMs + event.timeMs });
      }
    }

    const joined = crossfadeJoin(audios, input.plan.overlapMs);

    return {
      kind: 'complete',
      completedSegmentCount: audios.length,
      audio: joined.audio,
      timeline: buildVisualEventTimeline(events, input.confidenceMin),
    };
  }

  /**
   * Requirements 23.8 and 23.9 over the joined audio.
   *
   * The onsets are detected on the *joined* audio, not per segment, which is the only correct
   * place: a transient straddling an overlap exists in both segments and in the cross-fade
   * between them, and detecting per segment would count it twice or miss it entirely
   * depending on which side of the fade it landed on.
   */
  private async judge(input: JudgeInput): Promise<Judgement> {
    const alignment = evaluateOnsetAlignment(
      {
        timeline: input.timeline,
        onsetTimesMs: onsetTimesMs(input.joined, {
          riseDb: input.alignmentThresholds.onsetRiseDb,
        }),
      },
      input.alignmentThresholds,
    );

    const shape = await this.measurement.measureShape({ kind: 'pcm', audio: input.joined });
    const duration = evaluateOutputDuration(
      { inputDurationMs: input.metadata.durationMs, outputDurationMs: shape.durationMs },
      input.durationThresholds,
    );

    const unmet: V2aQualityCriterion[] = [];
    if (!isAlignmentSatisfied(alignment)) unmet.push('onset_alignment');
    if (!duration.satisfied) unmet.push('output_duration');

    return { alignment, duration, unmet };
  }

}

/**
 * Source frames available inside one segment.
 *
 * Derived from the segment's own length rather than the clip's, so a segment's frame indices
 * start at 0 and `planFrameSampling` never addresses a frame the sampler was not asked for.
 */
function segmentSourceFrameCount(
  metadata: ProbedVideoMetadata,
  segment: VideoSegment,
): number {
  return Math.max(
    1,
    Math.min(
      sourceFrameCount(metadata),
      Math.round((segment.durationMs * metadata.frameRate) / 1000),
    ),
  );
}

type SubmittedV2aVariant =
  | {
      readonly kind: 'accepted';
      readonly jobId: string;
      readonly engineId: string;
      readonly assetId: string;
      readonly acceptedAtMs: number;
    }
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration }
  | { readonly kind: 'unproduced'; readonly jobId: string; readonly failure: JobFailure };

interface SegmentRunInput {
  readonly jobId: string;
  readonly accountId: string;
  readonly parameters: V2aParameters;
  readonly metadata: ProbedVideoMetadata;
  readonly plan: SegmentPlan;
  readonly seed: number;
  /** Requirements 23.15/23.16's floor, from the set read once for the whole request. */
  readonly confidenceMin: number;
}

type SegmentRun =
  | {
      readonly kind: 'complete';
      readonly completedSegmentCount: number;
      readonly audio: PcmAudio;
      readonly timeline: VisualEventTimeline;
    }
  /** Requirement 23.17. */
  | {
      readonly kind: 'timed_out';
      readonly completedSegmentCount: number;
      readonly failure: JobFailure;
    }
  | {
      readonly kind: 'failed';
      readonly completedSegmentCount: number;
      readonly failure: JobFailure;
    };

interface JudgeInput {
  readonly joined: PcmAudio;
  readonly timeline: VisualEventTimeline;
  readonly metadata: ProbedVideoMetadata;
  readonly alignmentThresholds: ReturnType<typeof v2aOnsetAlignmentThresholds>;
  readonly durationThresholds: ReturnType<typeof v2aDurationThresholds>;
}

interface Judgement {
  readonly alignment: ReturnType<typeof evaluateOnsetAlignment>;
  readonly duration: ReturnType<typeof evaluateOutputDuration>;
  readonly unmet: readonly V2aQualityCriterion[];
}
