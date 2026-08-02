/**
 * Voice conversion (Requirements 26.24, 26.25, 26.26; 26.16/26.17 through moderation).
 *
 * ### What is verified and what is assumed
 *
 * This is stated first because it is the honest summary of the whole service, and it is repeated
 * in the task report rather than left in a comment:
 *
 * - **26.25's length invariant is verified.** Both durations are measured, the error is judged
 *   against `voice_conversion_length_tolerance_ms`, and a result outside the window **fails the
 *   job with a refund** through the one existing refund path. Nothing is published on that path.
 * - **26.24's content preservation is assumed**, as an explicit contract on
 *   `VoiceConversionPort`. It cannot be verified here: deciding that two recordings say the same
 *   words needs a model this environment does not have, and a check that compared two transcripts
 *   would be testing the transcriber. What the asset records instead is *how* the claim was
 *   established — `contentPreservation.basis` is `port_contract` today — so a reader can tell an
 *   asserted guarantee from a measured one. See `domain/voice/conversion.ts`.
 *
 * ### The order of the gates
 *
 * 1. **Profile access** (26.18, 26.20, 26.22, 26.29) through task 6.2's `ProfileAccessService`.
 *    First, because a withdrawn profile must be refused before a consent record for a conversion
 *    that will not happen is written.
 * 2. **The conversion consent record** (26.26) through task 6.2's `ConsentService`. 26.26 makes
 *    the record a *precondition of creating the Generation_Job*, so it is taken before submission
 *    and a refusal charges nothing.
 * 3. **The source utterance** must exist.
 * 4. **Submission**, which is where 26.16/26.17's prohibited-use inspection of the
 *    `voice_conversion_profile_designation` field happens — through the moderation gate, using
 *    task 6.1's classifier, not anything restated here.
 * 5. **Conversion**, then 26.25's verdict.
 *
 * Steps 1–3 all precede step 4, which is what discharges 26.26's "크레딧을 차감하지 않는다"
 * structurally: no code path exists on which a debit could precede them.
 */

import { durationMs as audioDurationMs, channelCount } from '../../domain/audio/pcm';
import { voiceConversionThresholds } from '../../domain/quality/speech-thresholds';
import {
  fixedThresholdSource,
  type QualityThresholdSource,
} from '../../domain/quality/threshold-source';
import { variantSeed, type SeedSource } from '../../domain/sfx/seed';
import type { VoiceConvertConsentRecordDraft } from '../../domain/voice/consent-record';
import {
  contentPreservationClaim,
  evaluateConversionLength,
  type VoiceConversionMetadata,
} from '../../domain/voice/conversion';
import { boundEngineIdOf } from '../../domain/voice/profile';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { Clock } from '../clock';
import type { JobOrchestrator } from '../generation/job-orchestrator';
import type { BlockedModeration, ModerationDecision } from '../moderation/decision';
import type { SpeechFailureRejectionPort } from '../speech/ports';

import type { ConsentService } from './consent-service';
import { profileNotFound } from './errors';
import type { ProfileAccessService } from './profile-access-service';
import {
  voiceConversionFailed,
  voiceConversionLengthUnmet,
  voiceConversionSourceNotFound,
} from './profile-errors';
import type {
  SourceUtterancePort,
  VoiceConversionPort,
  VoiceProfileRecordStorePort,
} from './profile-ports';

export interface VoiceConversionServiceDependencies {
  readonly orchestrator: JobOrchestrator;
  readonly conversion: VoiceConversionPort;
  readonly sourceAudio: SourceUtterancePort;
  readonly profiles: VoiceProfileRecordStorePort;
  /** Requirements 26.18–26.22, 26.29's gate — task 6.2's. */
  readonly access: ProfileAccessService;
  /** Requirement 26.26's record — task 6.2's. */
  readonly consent: ConsentService;
  /** Requirement 26.25's fail-and-refund step. The one refund path. */
  readonly rejection: SpeechFailureRejectionPort;
  readonly seeds: SeedSource;
  readonly clock: Clock;
  /** Design §3.6's 기본 엔진 for `dialogue`, used when the profile binds none. */
  readonly defaultEngineId: string;
  readonly thresholds?: QualityThresholdSource;
}

export interface VoiceConversionInput {
  readonly accountId: string;
  /** Requirement 26.24 — 원본 음성. */
  readonly sourceAssetId: string;
  /** Requirement 26.24 — 대상 Voice_Profile. */
  readonly voiceProfileId: string;
  /** Requirement 26.26's two confirmations. Absent is refused exactly like a negative record. */
  readonly consent?: Omit<
    VoiceConvertConsentRecordDraft,
    'kind' | 'targetProfileId' | 'submittedAtMs'
  >;
  readonly engineId?: string;
  readonly seed?: number;
  readonly moderate?: () => ModerationDecision;
}

export interface ConvertedVoice {
  readonly kind: 'converted';
  readonly jobId: string;
  readonly assetId: string;
  readonly audio: import('../../domain/audio/pcm').PcmAudio;
  readonly metadata: VoiceConversionMetadata;
  readonly seed: number;
}

export type VoiceConversionOutcomeView =
  | ConvertedVoice
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration };

export class VoiceConversionService {
  private readonly deps: VoiceConversionServiceDependencies;
  private readonly thresholds: QualityThresholdSource;

  constructor(deps: VoiceConversionServiceDependencies) {
    this.deps = deps;
    this.thresholds = deps.thresholds ?? fixedThresholdSource();
  }

  /** Requirements 26.24, 26.25, 26.26. */
  async convert(input: VoiceConversionInput): Promise<VoiceConversionOutcomeView> {
    // Requirements 26.18, 26.20, 26.22, 26.29 — task 6.2's gate.
    this.deps.access.assertUsable(input.voiceProfileId, input.accountId);

    const profile = this.deps.profiles.find(input.voiceProfileId);
    if (profile === undefined) throw profileNotFound(input.voiceProfileId);

    // Requirement 26.26 — a precondition of creating the Generation_Job, so it is taken before
    // submission and raises 422 with the unmet item names when it is not met.
    const record = this.deps.consent.requireVoiceConvertConsent(
      input.consent === undefined
        ? undefined
        : {
            ...input.consent,
            kind: 'voice_convert',
            targetProfileId: input.voiceProfileId,
            submittedAtMs: this.deps.clock.now().getTime(),
          },
    );

    const sourceAudio = await this.deps.sourceAudio.find(input.sourceAssetId);
    if (sourceAudio === undefined) throw voiceConversionSourceNotFound(input.sourceAssetId);

    const set = this.thresholds.current();
    const lengthThresholds = voiceConversionThresholds(set);
    const seed = input.seed ?? this.deps.seeds.draw();
    // Requirement 26.10: a `preset` profile's engine wins. A clone uses the caller's engine or the
    // Asset_Kind default, which routing may still substitute under Requirement 20.10.
    const engineId = boundEngineIdOf(profile) ?? input.engineId ?? this.deps.defaultEngineId;

    const submitted = await this.submit({ input, engineId, sourceAudio, seed });
    if (submitted.kind === 'blocked') return submitted;
    if (submitted.kind === 'unproduced') {
      // Requirements 6.1–6.3 already refunded this job.
      throw voiceConversionFailed({
        jobId: submitted.jobId,
        voiceProfileId: input.voiceProfileId,
        failure: submitted.failure,
      });
    }

    const outcome = await this.deps.conversion.convert({
      jobId: submitted.jobId,
      accountId: input.accountId,
      sourceAssetId: input.sourceAssetId,
      sourceAudio,
      voiceProfileId: input.voiceProfileId,
      voicePromptId: profile.kind === 'cloned' ? profile.voicePromptId : null,
      engineId: submitted.engineId,
      // A derived seed rather than the base, for the reason `domain/sfx/seed.ts` gives: variant 0
      // *is* the base, so a single-output request uses exactly the seed the caller named.
      seed: variantSeed(seed, 0),
    });

    if (outcome.kind === 'unproduced') {
      await this.deps.rejection.reject({
        jobId: submitted.jobId,
        accountId: input.accountId,
        unmet: ['line_synthesis'],
      });
      throw voiceConversionFailed({
        jobId: submitted.jobId,
        voiceProfileId: input.voiceProfileId,
        failure: outcome.failure,
      });
    }

    // Requirement 26.25 — measured on both files, not asserted.
    const verdict = evaluateConversionLength(
      {
        sourceDurationMs: audioDurationMs(sourceAudio),
        outputDurationMs: audioDurationMs(outcome.audio),
      },
      lengthThresholds,
    );

    if (!verdict.satisfied) {
      // The invariant is stated as something the service *maintains* (불변식), and the only way to
      // maintain it against an engine that returned the wrong length is to refuse the result. The
      // job is failed and refunded through the same path Requirements 21.18, 22.19 and 23.17 use,
      // and no asset is published — so a stored conversion always satisfies 26.25.
      const rejected = await this.deps.rejection.reject({
        jobId: submitted.jobId,
        accountId: input.accountId,
        unmet: ['line_synthesis'],
      });
      throw voiceConversionLengthUnmet({
        jobId: submitted.jobId,
        voiceProfileId: input.voiceProfileId,
        verdict,
        refundedAmount: rejected.refundedAmount,
      });
    }

    const metadata: VoiceConversionMetadata = {
      sourceAssetId: input.sourceAssetId,
      voiceProfileId: input.voiceProfileId,
      engineId: submitted.engineId,
      sourceDurationMs: Math.round(verdict.sourceDurationMs),
      durationMs: Math.round(verdict.outputDurationMs),
      sampleRate: outcome.audio.sampleRate,
      channels: channelCount(outcome.audio),
      lengthVerdict: verdict,
      // Requirement 26.24 — asserted by the port, recorded as such. See the module comment.
      contentPreservation: contentPreservationClaim('port_contract'),
      consentRecordId: record.consentRecordId,
      qualityThresholdSetVersion: set.version,
    };

    return {
      kind: 'converted',
      jobId: submitted.jobId,
      assetId: submitted.assetId,
      audio: outcome.audio,
      metadata,
      seed,
    };
  }

  /**
   * One Generation_Job producing one `dialogue` asset (Requirement 26.24).
   *
   * `inputModality: 'audio'`, because the input is an utterance rather than a script — which is
   * also why the engine descriptors in `adapters/tts/license.ts` declare both modalities. The
   * `prompt` carries the profile designation, which is Requirement 26.16's third inspected text
   * (`voice_conversion_profile_designation` in `domain/moderation/fields.ts`).
   */
  private async submit(input: {
    readonly input: VoiceConversionInput;
    readonly engineId: string;
    readonly sourceAudio: import('../../domain/audio/pcm').PcmAudio;
    readonly seed: number;
  }): Promise<SubmittedConversion> {
    const outcome = await this.deps.orchestrator.submit({
      accountId: input.input.accountId,
      assetKind: 'dialogue',
      inputModality: 'audio',
      // Requirement 26.25 makes the output the source's length, so that is what is priced and
      // routed by — not an estimate.
      durationMs: Math.round(audioDurationMs(input.sourceAudio)),
      prompt: input.input.voiceProfileId,
      inputAssetIds: [input.input.sourceAssetId],
      seed: input.seed,
      engineId: input.engineId,
      resultCount: 1,
      ...(input.input.moderate === undefined ? {} : { moderate: input.input.moderate }),
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
    };
  }
}

type SubmittedConversion =
  | {
      readonly kind: 'accepted';
      readonly jobId: string;
      readonly engineId: string;
      readonly assetId: string;
    }
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration }
  | { readonly kind: 'unproduced'; readonly jobId: string; readonly failure: JobFailure };
