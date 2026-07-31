/**
 * SFX_Service (Requirement 22; design §3.6, §5.3, §5.4).
 *
 * It owns four things and delegates everything else:
 *
 * 1. **Validation** (22.2–22.5, 22.10–22.13, 22.17, 22.18) — through
 *    `domain/sfx/validation.ts`, which also applies and records 22.17's defaults.
 * 2. **Engine selection by tier** (22.9–22.11, design §3.6) — 고속 is `woosh-dflow` and
 *    고품질 is `woosh-flow`, so the tier picks the engine identifier and the request names it
 *    explicitly under Requirement 20.3. A caller that named an engine itself keeps it.
 * 3. **Fan-out over variants** (22.5, 22.16) — one Generation_Job per variant, each with a
 *    seed derived from the base by `domain/sfx/seed.ts`. See the note below on why per-variant
 *    jobs rather than one job with a batch.
 * 4. **The per-variant quality gate** (22.14, 22.15, 22.19) — measure, judge against the
 *    Quality_Threshold_Set in force, and on a miss fail *that variant's* job with a refund and
 *    keep the others.
 *
 * ### Why one job per variant
 *
 * Requirement 22.19 is the reason. It requires that when some variants fail and others
 * succeed, only the successes are stored and "실패한 변형 개수에 해당하는 크레딧" is refunded
 * — a *partial* refund proportional to the failures. The credit machinery refunds whole jobs
 * (`CreditRefundPort`, used by Requirements 5.7, 5.8, 6.3, 20.15, 21.18), so making each
 * variant its own job makes 22.19's partial refund fall out of the existing full-refund path
 * with no new arithmetic and no new ledger entry type. One job with `resultCount: 8` would
 * have needed a second, proportional refund path, and two refund paths is how a ledger stops
 * balancing.
 *
 * It also makes 22.5's "서로 다른 시드" and 22.8's reproducibility one mechanism: the base seed
 * plus the variant index determines the seed, so the same request re-submitted asks the engine
 * the same `variantCount` questions in the same order.
 *
 * ### How the quality gate composes with the engine-failure path
 *
 * They are counted separately and neither refunds the other's charge.
 *
 * - A variant whose engine produced nothing comes back `kind: 'unproduced'`. Requirements
 *   6.1–6.3 have already failed and refunded that job, so this service records the failure and
 *   touches no credits.
 * - A variant whose audio misses 22.14 or 22.15 arrived successfully, so its job is still
 *   holding a charge. It is failed and refunded here, through the same
 *   `createJobQualityRejection` Requirement 21.18 uses.
 *
 * Requirement 22 gives quality misses **no regeneration remedy** — contrast 21.18, which
 * explicitly grants two retries with different seeds. So none is invented: a variant that
 * misses is a failed variant, which is exactly the case 22.19 legislates for. That reading is
 * documented in the report for this task as an interpretation, because 22.14 and 22.15 are
 * written as invariants without naming the consequence of violating them.
 */

import { oneShotTailThresholds } from '../../domain/quality/one-shot-tail-thresholds';
import { loopSeamThresholds } from '../../domain/quality/loop-seam-thresholds';
import {
  fixedThresholdSource,
  type QualityThresholdSource,
} from '../../domain/quality/threshold-source';
import { rankByAlignment } from '../../domain/sfx/alignment';
import { SFX_SEAM_WINDOW_MS } from '../../domain/sfx/bounds';
import { SFX_NO_TEMPO, evaluateSfxLoopSeam } from '../../domain/sfx/loop-seam';
import {
  targetDurationMs,
  type SfxGenerationRequest,
  type SfxParameters,
} from '../../domain/sfx/request';
import { variantSeed, type SeedSource } from '../../domain/sfx/seed';
import { evaluateTailDecay } from '../../domain/sfx/tail-decay';
import type { PromptTokenizer } from '../../domain/sfx/tokenize';
import { validateSfxRequest } from '../../domain/sfx/validation';
import { wooshEngineIdFor } from '../../adapters/woosh/model-tier';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { JobOrchestrator } from '../generation/job-orchestrator';
import type { BlockedModeration, ModerationDecision } from '../moderation/decision';

import type { AudioMeasurementPort } from './measurement';
import { sfxAllVariantsFailed, sfxRequestInvalid } from './sfx-errors';
import type { SfxCandidate, SfxCandidatePort, SfxQualityRejectionPort } from './sfx-ports';
import {
  appliedDefaultsOf,
  sfxMetadata,
  type FailedSfxVariant,
  type ProducedSfxVariant,
  type SfxOutcome,
  type SfxQualityCriterion,
} from './sfx-result';

export interface SfxServiceOptions {
  readonly orchestrator: JobOrchestrator;
  readonly candidates: SfxCandidatePort;
  readonly measurement: AudioMeasurementPort;
  /** Requirements 22.14/22.15's fail-and-refund step. */
  readonly rejection: SfxQualityRejectionPort;
  /** Requirement 22.13's draw. Defaults to the platform CSPRNG. */
  readonly seeds: SeedSource;
  /** Requirement 34: the set in force. Defaults to the initial values (34.3). */
  readonly thresholds?: QualityThresholdSource;
  /** Requirements 22.2/22.3. Defaults to the local estimate in `domain/sfx/tokenize.ts`. */
  readonly tokenizer?: PromptTokenizer;
}

export interface SfxSubmissionInput {
  readonly accountId: string;
  readonly request: SfxGenerationRequest;
  /**
   * Engine named by the caller (Requirement 20.3).
   *
   * Overrides the tier's engine. Present because Requirement 20.3 lets a user choose, and
   * because design §3.6 gives `sfx` an ACE-Step fallback that a caller may want explicitly.
   */
  readonly engineId?: string;
  /** Content policy verdict, evaluated lazily by the orchestrator (design §9.1). */
  readonly moderate?: () => ModerationDecision;
}

export class SfxService {
  private readonly orchestrator: JobOrchestrator;
  private readonly candidates: SfxCandidatePort;
  private readonly measurement: AudioMeasurementPort;
  private readonly rejection: SfxQualityRejectionPort;
  private readonly seeds: SeedSource;
  private readonly thresholds: QualityThresholdSource;
  private readonly tokenizer: PromptTokenizer | undefined;

  constructor(options: SfxServiceOptions) {
    this.orchestrator = options.orchestrator;
    this.candidates = options.candidates;
    this.measurement = options.measurement;
    this.rejection = options.rejection;
    this.seeds = options.seeds;
    this.thresholds = options.thresholds ?? fixedThresholdSource();
    this.tokenizer = options.tokenizer;
  }

  /**
   * Requirements 22.1, 22.5–22.8, 22.13–22.19.
   *
   * Throws `sfx_request_invalid` (22.3, 22.18) before anything is charged, and
   * `sfx_all_variants_failed` when no variant survived. Everything else — including a partial
   * success under 22.19 — comes back as an `SfxOutcome`.
   */
  async generate(input: SfxSubmissionInput): Promise<SfxOutcome> {
    const validation = validateSfxRequest(
      input.request,
      this.tokenizer === undefined ? {} : { tokenizer: this.tokenizer },
    );
    if (validation.kind === 'invalid') {
      throw sfxRequestInvalid({ violations: validation.violations, prompt: validation.prompt });
    }

    return this.runVariants(input, validation.parameters);
  }

  /** Requirements 22.5, 22.16, 22.19: the fan-out and the partial-success accounting. */
  private async runVariants(
    input: SfxSubmissionInput,
    parameters: SfxParameters,
  ): Promise<SfxOutcome> {
    // Read once per request, not once per variant: an operator change landing mid-request
    // would otherwise judge siblings against different sets, and Requirement 34.6 records one
    // version per asset.
    const set = this.thresholds.current();
    const seamThresholds = loopSeamThresholds(set);
    const tailThresholds = oneShotTailThresholds(set);

    // Requirement 22.13: the caller's seed, or one drawn now and recorded on every asset.
    const baseSeed = parameters.seed ?? this.seeds.draw();
    const engineId = input.engineId ?? wooshEngineIdFor(parameters.modelTier);

    const produced: ProducedSfxVariant[] = [];
    const failures: FailedSfxVariant[] = [];
    let refundedAmount = 0;

    for (let index = 0; index < parameters.variantCount; index += 1) {
      const seed = variantSeed(baseSeed, index);
      const submitted = await this.submitVariant(input, parameters, engineId, seed);

      // Requirements 16.2/16.11: the prompt is shared, so one block refuses the whole request
      // and the remaining variants are never attempted or charged for.
      if (submitted.kind === 'blocked') return submitted;

      if (submitted.kind === 'unproduced') {
        // Requirements 6.1–6.3 already refunded this job; nothing to settle here.
        failures.push({
          seed,
          jobId: submitted.jobId,
          reason: 'engine_failure',
          unmet: [],
          failure: submitted.failure,
        });
        continue;
      }

      const { candidate, jobId } = submitted;
      const unmet = await this.judge(candidate, parameters, seamThresholds, tailThresholds);

      if (unmet.criteria.length > 0) {
        const rejected = await this.rejection.reject({
          jobId,
          accountId: input.accountId,
          unmet: unmet.criteria,
        });
        refundedAmount += rejected.refundedAmount;
        failures.push({
          seed,
          jobId,
          reason: 'quality_unmet',
          unmet: unmet.criteria,
          failure: null,
        });
        continue;
      }

      const shape = await this.measurement.measureShape({ kind: 'pcm', audio: candidate.audio });
      const metadata = sfxMetadata({
        candidate,
        parameters,
        shape,
        qualityThresholdSetVersion: set.version,
      });

      produced.push({
        jobId,
        assetId: candidate.assetId,
        metadata,
        alignmentScore: metadata.alignmentScore,
        seed: candidate.seed,
        loopSeam: unmet.loopSeam,
        tailDecay: unmet.tailDecay,
      });
    }

    if (produced.length === 0) {
      throw sfxAllVariantsFailed({
        failures,
        refundedAmount,
        qualityThresholdSetVersion: set.version,
      });
    }

    return {
      kind: 'produced',
      // Requirement 22.6: the returned list is ordered, not merely accompanied by scores.
      variants: rankByAlignment(produced).map((ranked) => ranked.value),
      failures,
      refundedAmount,
      applied: appliedDefaultsOf(parameters),
      baseSeed,
      engineId,
    };
  }

  /**
   * One submission plus the wait for its audio.
   *
   * `resultCount: 1` because a variant is one asset; the request's `variantCount` is expressed
   * as the number of submissions, which is what makes Requirement 22.19's refund a whole-job
   * refund. `durationMs` is the target length, which is what Requirement 2.2 prices and
   * Requirement 20.6 routes by.
   */
  private async submitVariant(
    input: SfxSubmissionInput,
    parameters: SfxParameters,
    engineId: string,
    seed: number,
  ): Promise<SubmittedVariant> {
    const outcome = await this.orchestrator.submit({
      accountId: input.accountId,
      assetKind: 'sfx',
      inputModality: 'text',
      durationMs: targetDurationMs(parameters),
      // The prompt is the text the Moderation_Service inspects (design §9.1).
      prompt: parameters.prompt,
      seed,
      engineId,
      resultCount: 1,
      sfx: parameters,
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    });

    if (outcome.kind === 'blocked') return { kind: 'blocked', decision: outcome.decision };
    if (outcome.kind === 'failed') {
      return { kind: 'unproduced', jobId: outcome.jobId, failure: outcome.failure };
    }

    const jobId = outcome.acceptance.jobId;
    const awaited = await this.candidates.awaitCandidate({
      jobId,
      accountId: input.accountId,
      seed,
    });
    if (awaited.kind === 'unproduced') {
      return { kind: 'unproduced', jobId, failure: awaited.failure };
    }

    return { kind: 'produced', jobId, candidate: awaited.candidate };
  }

  /**
   * Requirement 22.14 for a loop, Requirement 22.15 for a one-shot — never both.
   *
   * The two are mutually exclusive in the requirement text: 22.14 is a `WHERE 루프를 선택한
   * 경우` and 22.15 is a `WHERE 루프를 선택하지 않은 경우`. So exactly one verdict is taken per
   * variant and the other is `null`, which is why `ProducedSfxVariant` carries a nullable slot
   * for each rather than one union — a reader can see which rule was applied and which was not
   * applicable.
   */
  private async judge(
    candidate: SfxCandidate,
    parameters: SfxParameters,
    seamThresholds: ReturnType<typeof loopSeamThresholds>,
    tailThresholds: ReturnType<typeof oneShotTailThresholds>,
  ): Promise<QualityJudgement> {
    const subject = { kind: 'pcm', audio: candidate.audio } as const;

    if (parameters.loop) {
      const measurement = await this.measurement.measureLoop({
        subject,
        // A sound effect has no tempo; see `SFX_NO_TEMPO`. Bar alignment is not among the
        // criteria `evaluateSfxLoopSeam` applies, so the value is never judged.
        bpm: SFX_NO_TEMPO,
        timeSignature: SFX_NO_TEMPO,
        seamWindowMs: SFX_SEAM_WINDOW_MS,
      });
      const verdict = evaluateSfxLoopSeam(measurement, seamThresholds);
      return {
        criteria: verdict.satisfied ? [] : ['loop_seam'],
        loopSeam: verdict,
        tailDecay: null,
      };
    }

    const measurement = await this.measurement.measureTailDecay({ subject });
    const verdict = evaluateTailDecay(measurement, tailThresholds);
    return {
      criteria: verdict.satisfied ? [] : ['one_shot_tail'],
      loopSeam: null,
      tailDecay: verdict,
    };
  }
}

/** What one variant's submission-and-wait resolved to. */
type SubmittedVariant =
  | { readonly kind: 'produced'; readonly jobId: string; readonly candidate: SfxCandidate }
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration }
  | { readonly kind: 'unproduced'; readonly jobId: string; readonly failure: JobFailure };

interface QualityJudgement {
  readonly criteria: readonly SfxQualityCriterion[];
  readonly loopSeam: ProducedSfxVariant['loopSeam'];
  readonly tailDecay: ProducedSfxVariant['tailDecay'];
}
