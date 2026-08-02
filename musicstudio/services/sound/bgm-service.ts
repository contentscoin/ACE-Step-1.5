/**
 * BGM_Service (Requirement 21; design §5.3, §3.6).
 *
 * It owns three things and delegates everything else:
 *
 * 1. **Validation** (21.2, 21.3, 21.5, 21.9) — through `domain/bgm/validation.ts`.
 * 2. **The instrumental pin** (21.4) — by building the engine request through
 *    `bgmSongRequest`, whose `instrumental` is a literal `true`, and submitting it via
 *    `SongGateway` with `assetKind: 'bgm'`. There is no second gateway, no second
 *    validator and no second wire mapping: Requirement 21 reuses Requirements 3/4's.
 * 3. **The loop quality gate** (21.6, 21.7, 21.8, 21.16, 21.17, 21.18) — measure the
 *    produced audio, judge it against the Quality_Threshold_Set in force, and on a miss
 *    fail that job with a full refund and try again with a different seed, at most twice
 *    more.
 *
 * ### How 21.18's quality retry composes with 6.2's transport retry
 *
 * They count different events and neither can consume the other's budget.
 *
 * - Requirement 6.2 counts **re-requests of one submission** to a saturated engine: up
 *   to three, at least two seconds apart, inside a single `SongGateway.submit`. Its
 *   counter is `attemptsMade` on that one job record. When it is exhausted the
 *   orchestrator fails the job, refunds it and returns `kind: 'failed'`.
 * - Requirement 21.18 counts **complete generations that produced audio failing the
 *   seam criteria**: up to three, each a new Generation_Job with a different seed. Its
 *   counter is `attempt` in the loop below.
 *
 * The composition rule is one line of code and it is the important line: a
 * `kind: 'failed'` or `kind: 'blocked'` submission is returned **immediately**, without
 * advancing the quality counter. A transport failure produced no audio, so no criterion
 * was unmet, so 21.18's remedy — a different seed — has nothing to address. Conversely a
 * quality miss never touches `attemptsMade`, because it happens after the engine already
 * answered successfully. Worst case is therefore 3 quality attempts × 4 engine requests,
 * and a single failure is never counted twice.
 */

import {
  BGM_INTENSITY_STEP_MIN,
  BGM_LOOP_QUALITY_MAX_ATTEMPTS,
  BGM_TARGET_LENGTH_SECONDS_MAX,
  BGM_TARGET_LENGTH_SECONDS_MIN,
} from '../../domain/bgm/bounds';
import { evaluateLoopSeam, type LoopSeamCriterion } from '../../domain/bgm/loop-seam';
import {
  withIntensityCaption,
  type BgmGenerationRequest,
  type BgmParameters,
} from '../../domain/bgm/request';
import { bgmSongRequest } from '../../domain/bgm/song-request';
import { validateBgmRequest } from '../../domain/bgm/validation';
import { loopSeamThresholds } from '../../domain/quality/loop-seam-thresholds';
import {
  fixedThresholdSource,
  type QualityThresholdSource,
} from '../../domain/quality/threshold-source';
import type { SongDurationBounds } from '../../domain/song/validation';
import type { JobOrchestrator } from '../generation/job-orchestrator';
import { SongGateway } from '../generation/song-gateway';
import type { ModerationDecision } from '../moderation/decision';

import { bgmLoopQualityUnmet, bgmRequestInvalid } from './bgm-errors';
import type {
  BgmCandidate,
  BgmCandidatePort,
  BgmQualityRejectionPort,
} from './bgm-ports';
import { bgmMetadata, referenceAgreementFor, type BgmOutcome } from './bgm-result';
import type { AudioMeasurementPort } from './measurement';

/** Requirement 21.2, replacing Requirement 4.2's 10–600 s for `bgm` requests. */
export const BGM_DURATION_BOUNDS: SongDurationBounds = {
  minSeconds: BGM_TARGET_LENGTH_SECONDS_MIN,
  maxSeconds: BGM_TARGET_LENGTH_SECONDS_MAX,
};

export interface BgmServiceOptions {
  readonly orchestrator: JobOrchestrator;
  readonly candidates: BgmCandidatePort;
  readonly measurement: AudioMeasurementPort;
  /** Requirement 21.18's fail-and-refund step. */
  readonly rejection: BgmQualityRejectionPort;
  /** Requirement 34: the set in force. Defaults to the initial values (34.3). */
  readonly thresholds?: QualityThresholdSource;
  /**
   * Seed for attempt `n` (0-based) of one cue, when the caller named none.
   *
   * Injected rather than drawn here so a test can pin the three seeds Requirement 21.18
   * requires to differ. A caller that *did* name a seed keeps it for the first attempt;
   * see `seedFor`.
   */
  readonly seedForAttempt?: (attempt: number) => number;
}

export interface BgmSubmissionInput {
  readonly accountId: string;
  readonly request: BgmGenerationRequest;
  /** Engine named by the caller (Requirement 20.3). */
  readonly engineId?: string;
  /** Content policy verdict, evaluated lazily by the orchestrator (design §9.1). */
  readonly moderate?: () => ModerationDecision;
  /** Requirement 21.11: the step this cue is being generated as. 1 by default. */
  readonly intensityStep?: number;
  /**
   * How many steps the ladder this cue belongs to has (Requirement 21.9).
   *
   * Only the caption needs it — "intensity level 2 of 4" tells the engine where on the
   * ladder to arrange, and a step with no ladder around it has nothing to be relative
   * to. 1 means a standalone cue, which `withIntensityCaption` leaves uncaptioned.
   */
  readonly intensityVariantCount?: number;
  /** Offset applied to every attempt's seed, so sibling variants differ. */
  readonly seedOffset?: number;
}

/** Base for the default seed sequence, chosen so attempts are visibly distinct. */
const DEFAULT_SEED_STRIDE = 1;

export class BgmService {
  private readonly gateway: SongGateway;
  private readonly candidates: BgmCandidatePort;
  private readonly measurement: AudioMeasurementPort;
  private readonly rejection: BgmQualityRejectionPort;
  private readonly thresholds: QualityThresholdSource;
  private readonly seedForAttempt: (attempt: number) => number;

  constructor(options: BgmServiceOptions) {
    // Design §3.6: `bgm` is ACE-Step with the instrumental parameters fixed and loop
    // post-processing, which is the song gateway with one option changed.
    this.gateway = new SongGateway({
      orchestrator: options.orchestrator,
      assetKind: 'bgm',
      durationBounds: BGM_DURATION_BOUNDS,
    });
    this.candidates = options.candidates;
    this.measurement = options.measurement;
    this.rejection = options.rejection;
    this.thresholds = options.thresholds ?? fixedThresholdSource();
    this.seedForAttempt =
      options.seedForAttempt ?? ((attempt) => attempt * DEFAULT_SEED_STRIDE);
  }

  /**
   * Requirements 21.1–21.8, 21.12, 21.13, 21.15–21.18.
   *
   * Throws `bgm_request_invalid` (21.3) before anything is charged, and
   * `bgm_loop_quality_unmet` (21.18) after three attempts have each been failed and
   * refunded. Everything else comes back as a `BgmOutcome`.
   */
  async generate(input: BgmSubmissionInput): Promise<BgmOutcome> {
    const validation = validateBgmRequest(input.request);
    if (validation.kind === 'invalid') throw bgmRequestInvalid(validation.violations);

    return this.runAttempts(input, validation.parameters);
  }

  /** Requirement 21.6's ladder of attempts; one attempt when the cue is not a loop. */
  private async runAttempts(
    input: BgmSubmissionInput,
    cue: BgmParameters,
  ): Promise<BgmOutcome> {
    // Read once per cue, not once per attempt: an operator change landing between two
    // attempts of the same cue would otherwise judge them against different sets, and
    // Requirement 34.6 records one version on the asset.
    const thresholds = loopSeamThresholds(this.thresholds.current());
    // Requirement 21.9's variants differ only in arrangement intensity, and the caption
    // is where that is said. Applied here rather than in the validator because the step
    // belongs to the submission and not to the request the user wrote.
    const parameters = withIntensityCaption(
      cue,
      input.intensityStep ?? BGM_INTENSITY_STEP_MIN,
      input.intensityVariantCount ?? 1,
    );
    const maxAttempts = parameters.loop ? BGM_LOOP_QUALITY_MAX_ATTEMPTS : 1;

    let unmet: readonly LoopSeamCriterion[] = [];
    let refundedAmount = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const submitted = await this.submitAttempt(input, parameters, attempt);
      // Requirements 6.1–6.3 and 16.2 exit here without spending a quality attempt:
      // no audio was produced, so no seam criterion was tested.
      if (submitted.kind !== 'produced') return submitted;

      const { candidate, jobId } = submitted;
      const measurement = await this.measurement.measureLoop({
        subject: { kind: 'pcm', audio: candidate.audio },
        bpm: candidate.bpm,
        timeSignature: candidate.timeSignature,
      });

      const verdict = parameters.loop ? evaluateLoopSeam(measurement, thresholds) : null;

      if (verdict === null || verdict.satisfied) {
        const metadata = bgmMetadata({
          candidate,
          measurement,
          parameters,
          thresholds,
          verdict,
          ...(input.intensityStep === undefined ? {} : { intensityStep: input.intensityStep }),
        });
        return {
          kind: 'produced',
          jobId,
          assetId: candidate.assetId,
          metadata,
          loop: verdict,
          reference: referenceAgreementFor(metadata, input.request.reference),
          attempts: attempt + 1,
        };
      }

      // Requirement 21.18: this attempt's job is failed and refunded now rather than at
      // the end, so a rejected loop is never left as a succeeded job holding a charge.
      unmet = verdict.unmet;
      const rejected = await this.rejection.reject({
        jobId,
        accountId: input.accountId,
        unmet: verdict.unmet,
      });
      refundedAmount += rejected.refundedAmount;
    }

    throw bgmLoopQualityUnmet({
      unmet,
      attempts: maxAttempts,
      refundedAmount,
      qualityThresholdSetVersion: thresholds.version,
    });
  }

  /** One submission plus the wait for its audio. */
  private async submitAttempt(
    input: BgmSubmissionInput,
    parameters: BgmParameters,
    attempt: number,
  ): Promise<
    | { readonly kind: 'produced'; readonly jobId: string; readonly candidate: BgmCandidate }
    | Exclude<BgmOutcome, { readonly kind: 'produced' }>
  > {
    const outcome = await this.gateway.submit({
      accountId: input.accountId,
      request: bgmSongRequest(parameters, { seed: this.seedFor(input, parameters, attempt) }),
      ...(input.engineId === undefined ? {} : { engineId: input.engineId }),
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    });

    if (outcome.kind === 'blocked') return { kind: 'blocked', decision: outcome.decision };
    if (outcome.kind === 'failed') {
      return { kind: 'failed', jobId: outcome.jobId, failure: outcome.failure };
    }

    const jobId = outcome.acceptance.jobId;
    const awaited = await this.candidates.awaitCandidate({ jobId, accountId: input.accountId });
    if (awaited.kind === 'unproduced') return { kind: 'failed', jobId, failure: awaited.failure };

    return { kind: 'produced', jobId, candidate: awaited.candidate };
  }

  /**
   * Requirement 21.18's "서로 다른 시드".
   *
   * A caller-supplied seed is honoured for the first attempt — Requirement 4.10's
   * reproducibility promise applies to the request as made — and the retries move off it.
   * Without one, the injected sequence supplies all three. `seedOffset` separates sibling
   * intensity variants, which share every other parameter by Requirement 21.9 and would
   * otherwise be the same audio at different levels.
   */
  private seedFor(
    input: BgmSubmissionInput,
    parameters: BgmParameters,
    attempt: number,
  ): number {
    const offset = input.seedOffset ?? 0;
    const base = parameters.seed;
    if (base !== undefined) return base + offset + attempt;
    return this.seedForAttempt(attempt) + offset;
  }
}
