/**
 * Outbound ports for Voice_Profile creation, lookup and voice conversion (Requirements 26.1–26.11,
 * 26.24, 26.25).
 *
 * A separate file from `ports.ts` on purpose. `ports.ts` is task 6.2's consent machinery — identity
 * verification, asset visibility, erasure, notification, operator review — and these are task
 * 2.7's. Keeping them apart means neither task's seams are widened by the other's, and the
 * ownership split the two tasks agreed on is visible in the file layout rather than only in
 * comments.
 *
 * | port | owner | criteria |
 * |---|---|---|
 * | `VoiceProfileRecordStorePort` | storage | 26.1, 26.7, 26.9, 26.10 |
 * | `ReferenceSampleProbePort` | DSP worker, **task 3.1** | 26.2, 26.3, 26.5 |
 * | `ReferenceSampleStagingPort` | upload staging | 26.13's discard |
 * | `VoicePromptPort` | embedding cache | 26.8 |
 * | `VoiceConversionPort` | a conversion engine | 26.24, 26.25 |
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { VoiceProfile } from '../../domain/voice/profile';
import type { ProbedReferenceSample } from '../../domain/voice/reference-sample';

/* ------------------------------------------------------------------ profiles */

/**
 * Where the Voice_Profile's own fields live.
 *
 * The consent *state* is not here: it is `VoiceProfileStatePort` in `store.ts`, on the same row
 * (see `db/migrations/0011_voice_consent.sql`). Two ports over one row rather than one port over
 * both, because the mutability rules differ — task 6.2's state machine is the only thing allowed
 * to move the state, and a combined repository would hand 2.7's creation path a `saveContext` it
 * has no business calling.
 */
export interface VoiceProfileRecordStorePort {
  save(profile: VoiceProfile): void;
  /** `undefined` for an id that was never created. */
  find(voiceProfileId: string): VoiceProfile | undefined;
  /** Requirement 26.9's picker, and the owner's own list. */
  listForOwner(ownerId: string): readonly VoiceProfile[];
}

/* ---------------------------------------------------------- reference samples */

export type ReferenceProbeOutcome =
  | { readonly kind: 'probed'; readonly sample: ProbedReferenceSample }
  /**
   * The file could not be read at all.
   *
   * Distinct from a sample that fails validation: an unreadable file has no measurements, so
   * Requirement 26.4's "허용값" can be reported but the measured value cannot, and the rejection
   * says which stage failed instead of inventing numbers. The same split
   * `services/sound/v2a-ports.ts` draws for a video probe.
   */
  | { readonly kind: 'unreadable'; readonly detail: string };

export interface ReferenceSampleProbePort {
  /**
   * Requirements 26.2, 26.3, 26.5 — measure one staged upload.
   *
   * **Integration point (task 3.1)**: the DSP worker's decoder fills this. The speech-region
   * measurement it reports must use Requirement 30.12's rule, which is where the glossary points
   * 26.5 — see `domain/voice/reference-sample.ts`. The thresholds are passed in so the worker
   * cannot apply a second, stale copy of them.
   */
  probe(request: {
    readonly uploadId: string;
    readonly speechRmsThresholdDb: number;
    readonly speechMinDurationMs: number;
  }): Promise<ReferenceProbeOutcome>;
}

/**
 * Requirement 26.13 — the uploads discarded when consent is not met.
 *
 * `discard` exists because 26.13 does not merely refuse the request, it requires the sample to be
 * dropped "영구 저장 없이": an effect needs a seam a test can observe. `promote` is the other half —
 * the moment a staged upload becomes a stored reference sample, which 26.12 requires to come
 * *after* the consent record.
 */
export interface ReferenceSampleStagingPort {
  promote(uploadId: string, voiceProfileId: string): Promise<void>;
  discard(uploadIds: readonly string[]): Promise<void>;
}

/**
 * Requirement 26.8 — the combined voice prompt.
 *
 * One handle for the whole profile rather than one per sample, because 26.8 asks for "결합한 단일
 * 음성 프롬프트". Returning a handle rather than audio keeps the embedding cache's representation
 * out of the product layer; Requirement 26.21 (task 6.2) erases it through
 * `VoiceDataErasurePort`, which is why nothing here deletes.
 */
export interface VoicePromptPort {
  combine(request: {
    readonly voiceProfileId: string;
    readonly uploadIds: readonly string[];
  }): Promise<string>;
}

/* ---------------------------------------------------------------- conversion */

export interface VoiceConversionRequest {
  readonly jobId: string;
  readonly accountId: string;
  /** The Audio_Asset whose utterance is being re-voiced. */
  readonly sourceAssetId: string;
  readonly sourceAudio: PcmAudio;
  readonly voiceProfileId: string;
  /** The prompt handle of 26.8, when the target profile has one. */
  readonly voicePromptId: string | null;
  readonly engineId: string;
  readonly seed: number;
}

export type VoiceConversionOutcome =
  | { readonly kind: 'converted'; readonly audio: PcmAudio }
  /** Requirements 6.1–6.3 own this case and have already refunded the job. */
  | { readonly kind: 'unproduced'; readonly failure: JobFailure };

/**
 * Requirement 26.24's engine seam — and the place its content-preservation obligation lands.
 *
 * ### The contract an implementation accepts
 *
 * 1. **Content preservation (26.24).** The returned audio SHALL contain the same utterance as
 *    `sourceAudio`: the same words, in the same order, with the same prosodic phrasing. Only
 *    timbre may change. **This is not verified by the product layer** — see
 *    `domain/voice/conversion.ts` for why it cannot be, and for how the claim's basis is recorded
 *    on the asset instead of being assumed silently.
 * 2. **Length (26.25).** The returned audio SHOULD be within the Quality_Threshold_Set's
 *    `voice_conversion_length_tolerance_ms` of the source. This one *is* verified: the service
 *    measures both and refuses the result if it is not, so an implementation that stretches the
 *    utterance is caught rather than trusted.
 * 3. **Determinism.** The same request SHALL produce the same samples, so that a re-request
 *    behaves the way Requirement 25.18 makes dialogue generation behave.
 *
 * Stated here, on the interface, because a requirement written only in a service's comment
 * evaporates when the service is replaced. **Integration point**: no conversion engine is
 * reachable from this environment.
 */
export interface VoiceConversionPort {
  convert(request: VoiceConversionRequest): Promise<VoiceConversionOutcome>;
}

/**
 * Where a conversion's source audio comes from.
 *
 * Narrow on purpose: the Library_Service (task 5.1) owns Audio_Assets, and this is the whole
 * surface Requirement 26.24 needs from it — the decoded samples of one asset the caller may use.
 */
export interface SourceUtterancePort {
  find(assetId: string): Promise<PcmAudio | undefined>;
}
