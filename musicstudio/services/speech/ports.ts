/**
 * Narrow outbound ports of the Speech_Service.
 *
 * Same discipline as `services/sound/{bgm,sfx,v2a}-ports.ts`: each is the seam to something this
 * task does not build, stated in the shape Requirement 25 needs rather than waiting for it to
 * exist. Requirement 25 needs three of them, and each stands in for something unreachable from
 * this environment.
 *
 * What is *not* a port, and why: the script split (25.10–25.13), the line list (25.14), the
 * timing arithmetic (25.14–25.17, 25.20), the tag rules (25.8, 25.9), the tail-silence rule
 * (25.19) and the cross-fade join (25.11, 25.15) are pure functions in `domain/speech/` and
 * `domain/audio/`. Making any of them a port would have moved the substance of this task behind a
 * fake and left nothing testable.
 *
 * ### The three ports
 *
 * - `SpeechSynthesisPort` — the seam onto *decoded* audio for one synthesised line. It sits
 *   between the engine result and job completion for the reason `SfxCandidatePort` does:
 *   Requirement 25.19's tail adjustment and 25.14's timings both have to be computed from the
 *   samples *before* the asset is published, and nothing in this repository decodes audio.
 *   **Integration point (tasks 3.1, 5.1)**: `job-poller.ts` already fetches the engine's results
 *   in `completeJob()`; the composition that owns the DSP worker decodes them and supplies them
 *   here.
 *
 * - `DialogueRenditionStorePort` — where a produced dialogue asset's per-line audio and layout
 *   live. Requirement 25.15 re-synthesises **one line** and requires every other line's samples
 *   to be preserved outside the splice regions, which is only possible if the other lines' audio
 *   is still available as separate pieces. Storing only the joined file would make 25.15
 *   unimplementable — the pieces cannot be recovered from the mix. **Integration point (task
 *   5.1)**: Library_Service owns the object store; this is the whole surface 25.15 needs from it.
 *
 * - `ReferenceTranscriptionPort` — Requirement 26.6's 참조 텍스트 for a reference sample, and the
 *   `dialogue` side of Requirement 27. Declared here rather than imported from
 *   `services/transcription/` so the Voice_Service's dependency is one method rather than a whole
 *   service; `services/transcription/transcription-service.ts` implements it.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { DialogueAssetMetadata } from '../../domain/speech/metadata';
import type { DialogueLayout, DialogueTiming } from '../../domain/speech/line-timing';
import type { SpeechParameters } from '../../domain/speech/request';

/* --------------------------------------------------------------------- synthesis */

export interface SpeechSynthesisRequest {
  readonly jobId: string;
  readonly accountId: string;
  /** Requirement 25.14's index, so a port implementation can echo it back. */
  readonly lineIndex: number;
  /** The text of this line, tags resolved per 25.8/25.9. */
  readonly text: string;
  /** Requirements 25.5, 25.6, 25.7 — the values 25.15 must reuse on a re-synthesis. */
  readonly parameters: SpeechParameters;
  /** The engine routing actually chose. */
  readonly engineId: string;
  /** Requirement 25.18: this line's seed, derived from the base. */
  readonly seed: number;
}

export interface SynthesisedLine {
  readonly lineIndex: number;
  readonly audio: PcmAudio;
  /** Requirement 25.18: the seed the engine actually used. */
  readonly seed: number;
}

export type SpeechSynthesisOutcome =
  | { readonly kind: 'produced'; readonly line: SynthesisedLine }
  /**
   * The engine produced no audio for this line.
   *
   * Distinct from a validation refusal on purpose: Requirements 6.1–6.3 already own this case and
   * have already refunded the job, so the Speech_Service records it and touches no credits — the
   * same split `sfx-ports.ts` documents.
   */
  | { readonly kind: 'unproduced'; readonly failure: JobFailure };

export interface SpeechSynthesisPort {
  /** Resolves once the engine's audio for one line is decoded and available. */
  synthesiseLine(request: SpeechSynthesisRequest): Promise<SpeechSynthesisOutcome>;
}

/* -------------------------------------------------------------- job rejection */

/**
 * Why a dialogue Generation_Job was ended by the Speech_Service itself.
 *
 * One member, because Requirement 25 defines exactly one way for a dialogue job to fail on this
 * side of the engine: a line came back with no audio, so the asset cannot be assembled.
 * Requirement 25 states **no quality gate** on the produced audio — 25.19 *adjusts* the tail
 * rather than refusing it — which is the substantive difference from Requirements 21, 22 and 23,
 * and the reason this list has one entry rather than three.
 */
export const SPEECH_FAILURE_CRITERIA = ['line_synthesis'] as const;

export type SpeechFailureCriterion = (typeof SPEECH_FAILURE_CRITERIA)[number];

export interface SpeechFailureRejection {
  readonly jobId: string;
  readonly accountId: string;
  readonly unmet: readonly SpeechFailureCriterion[];
}

export interface SpeechFailureRejectionResult {
  /** Credits returned. 0 when the job was never charged or was already terminal. */
  readonly refundedAmount: number;
}

/**
 * The fail-and-refund step, implemented by the *existing* `createJobQualityRejection` over
 * `JobRuntime`.
 *
 * **One refund path in the system**: the same `CreditRefundPort` Requirements 5.7, 5.8, 6.3,
 * 20.15, 21.18, 22.19 and 23.17 all use. No second refund path is added by this task, and this
 * port exists only so the intersection type in `services/sound/job-quality-rejection.ts` covers
 * dialogue too.
 */
export interface SpeechFailureRejectionPort {
  reject(rejection: SpeechFailureRejection): Promise<SpeechFailureRejectionResult>;
}

/* -------------------------------------------------------------------- renditions */

/**
 * A produced dialogue asset, as everything 25.15 needs to edit one line of it.
 *
 * The per-line audio *and* the layout, because the layout is what makes the timings derivable
 * (see `domain/speech/line-timing.ts`) and the pieces are what make the re-join possible. The
 * joined audio is deliberately **not** stored here: it is a function of the pieces, and keeping a
 * second copy would create a way for the two to disagree.
 */
export interface DialogueRendition {
  readonly assetId: string;
  readonly jobId: string;
  readonly accountId: string;
  /** One piece per line, in line order. */
  readonly linePieces: readonly PcmAudio[];
  readonly layout: DialogueLayout;
  readonly timing: DialogueTiming;
  readonly metadata: DialogueAssetMetadata;
  /** Requirement 25.18: the base seed, so a line's seed can be re-derived by index. */
  readonly baseSeed: number;
}

export interface DialogueRenditionStorePort {
  save(rendition: DialogueRendition): Promise<void>;
  /** `undefined` for an asset that was never produced, or is not a dialogue asset. */
  find(assetId: string): Promise<DialogueRendition | undefined>;
}

/* ----------------------------------------------------------------- transcription */

export interface ReferenceTranscriptionRequest {
  readonly uploadId: string;
  /** Requirement 27.3's hint, when the caller supplied one. */
  readonly languageCode?: string;
}

export type ReferenceTranscriptionOutcome =
  | { readonly kind: 'transcribed'; readonly text: string; readonly languageCode: string }
  /**
   * Requirement 27.12's case, and any engine failure.
   *
   * A reference sample with no detectable speech is refused by Requirement 26.5's ratio check
   * before it reaches here, so this branch means the transcriber itself could not answer — which
   * Requirement 26.6 does not legislate for. See `services/voice/profile-service.ts` for the
   * reading applied.
   */
  | { readonly kind: 'unavailable'; readonly reasonCode: string };

export interface ReferenceTranscriptionPort {
  /** Requirement 26.6 — 참조 텍스트 for one reference sample. */
  transcribeReference(
    request: ReferenceTranscriptionRequest,
  ): Promise<ReferenceTranscriptionOutcome>;
}
