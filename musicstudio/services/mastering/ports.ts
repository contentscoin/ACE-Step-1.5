/**
 * The two seams `Mastering_Assistant` reaches across (design §5.5, §11.3).
 *
 * **`MasteringDspPort`** is the DSP worker: `dsp/src/musicstudio_dsp/loudness.py` and
 * `mastering.py`, over `pyloudnorm` and NumPy, reached through Celery. Declared as an
 * interface for the same reason `services/effects/ports.ts` declares its own — so the
 * product-layer rules of Requirement 30 are testable without a broker, and so the
 * measurement contract is written down on the side that consumes it.
 *
 * **`SuggestionModelPort`** is the parameter-suggestion service, which Requirement 30.19
 * requires to be deployed *separately* from MusicStudio's own runtime. It is behind a port
 * because Requirements 30.20 and 30.21 are entirely about what happens when it does not
 * answer, and neither of those is testable against a service that is reachable.
 *
 * ### Why the DSP results carry measurements rather than verdicts
 *
 * Requirements 30.6, 30.8, 30.9, 30.10, 30.12 and 30.16 are all bounds on *measured*
 * quantities, and every one of those bounds is a Quality_Threshold_Set member that an
 * operator may retune between two runs (Requirement 34.4). A worker that returned
 * `ok: true` would be baking a threshold-set version into a process that has no way to know
 * which version the request was judged under. So the worker measures and the service judges,
 * and the version recorded on the resulting `Generation_Version` is the one the service held
 * (Requirement 34.6).
 *
 * The one exception is Requirement 30.7's true-peak ceiling, which the worker *enforces*
 * rather than reports — because it is not a threshold, it is a fixed output invariant
 * (`TRUE_PEAK_CEILING_DBTP`), and enforcing it requires changing the samples, which only the
 * worker can do. The worker still reports the achieved peak so the service can verify it.
 *
 * ### The thresholds travel with the request
 *
 * Every call passes the numbers the worker needs from the threshold set in force. That is
 * what keeps the seam honest under Requirement 34.4: the worker holds a checked-in JSON
 * mirror of the *initial* values (`mastering_registry.json`) as its defaults, and the
 * product layer overrides them per call with whatever version is current. Without that, a
 * threshold change would take effect in the product layer and not in the worker, which
 * would put the judgement and the processing on different numbers.
 */

import type { SpeechRegion, VolumeAutomationPoint } from '../../domain/mastering/ducking';
import type { MasteringMeasurement } from '../../domain/mastering/measurement';

/** Where the audio lives. Mirrors `EffectProcessingSubject`. */
export interface MasteringAudioRef {
  readonly objectKey: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameCount: number;
}

/** Requirement 30.22, 30.24: analysis with no processing. */
export interface AnalyseRequest {
  readonly source: MasteringAudioRef;
}

export interface AnalyseResult {
  readonly measurement: MasteringMeasurement;
}

export interface NormaliseLoudnessRequest {
  readonly source: MasteringAudioRef;
  /** Requirement 30.5: already validated and defaulted by the service. */
  readonly targetLufs: number;
}

export interface NormaliseLoudnessResult {
  readonly output: MasteringAudioRef;
  /** Requirement 30.6: measured before the gain was applied. */
  readonly before: MasteringMeasurement;
  /** Requirements 30.6, 30.7, 30.25: measured after. */
  readonly after: MasteringMeasurement;
  /**
   * The gain actually applied, in dB. **This is the quantity Property 15 is about.**
   *
   * Reported rather than derived from the two loudness values, because Requirement 30.7 lets
   * the true-peak ceiling reduce it below what the target asked for — so
   * `after − before` and the applied gain are *different numbers* whenever the ceiling
   * binds, and Requirement 30.8 bounds the change in the applied gain specifically.
   */
  readonly appliedGainDb: number;
  /**
   * Requirement 30.25: true when the true-peak ceiling prevented the target being reached.
   *
   * The shortfall in LUFS is `targetLufs − after.integratedLoudnessLufs`, which the service
   * computes; this flag says whether it is a shortfall or a rounding residue.
   */
  readonly targetMissed: boolean;
  /** Requirement 30.6: false when no block cleared the −70 LUFS absolute gate. */
  readonly measurable: boolean;
}

export interface DialogueCleanupRequestDsp {
  readonly source: MasteringAudioRef;
  /** Requirement 30.12's speech rule, from the threshold set in force. */
  readonly speechRmsThresholdDb: number;
  readonly speechMinDurationMs: number;
  /** Requirement 30.9's target attenuation, from the threshold set in force. */
  readonly nonSpeechAttenuationDb: number;
}

export interface DialogueCleanupResultDsp {
  readonly output: MasteringAudioRef;
  readonly speechRegions: readonly SpeechRegion[];
  /** Requirement 30.9: mean non-speech RMS before and after, in dB. */
  readonly nonSpeechRmsBeforeDb: number;
  readonly nonSpeechRmsAfterDb: number;
  /**
   * False when the audio is speech from end to end.
   *
   * Requirement 30.9's first clause is about "발화 구간이 아닌 구간", so with no such
   * section there is nothing for it to constrain and the service skips the check. Reported
   * as a flag rather than left to be inferred from two `-Infinity` RMS values, because
   * `-Infinity - -Infinity` is `NaN` and `NaN < bound` is `false` — the right answer for
   * the wrong reason, and one that would silently invert if the comparison were ever
   * rewritten the other way round.
   */
  readonly hasNonSpeech: boolean;
  /** The envelope floor the worker's solver settled on, in dB. For audit, not a check. */
  readonly appliedFloorDb: number;
  /** Requirement 30.9: integrated loudness of the speech sections only, before and after. */
  readonly speechLoudnessBeforeLufs: number;
  readonly speechLoudnessAfterLufs: number;
  /** Requirement 30.10: both lengths, so the service checks rather than trusts. */
  readonly inputDurationMs: number;
  readonly outputDurationMs: number;
}

export interface DuckingRequestDsp {
  /** Requirement 30.12: speech is detected here and this track is never modified. */
  readonly dialogueSource: MasteringAudioRef;
  /** Requirement 30.12: this one is attenuated. */
  readonly musicSource: MasteringAudioRef;
  readonly depthDb: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly speechRmsThresholdDb: number;
  readonly speechMinDurationMs: number;
}

export interface DuckingResultDsp {
  readonly output: MasteringAudioRef;
  readonly speechRegions: readonly SpeechRegion[];
  /**
   * Requirement 30.17: the curve the worker applied, which becomes the stored artefact.
   *
   * Returned rather than regenerated in the product layer, so that what is stored for the
   * user to edit is provably the curve the audio was rendered with. `domain/mastering/
   * ducking.ts` verifies it against Requirements 30.12 and 30.16.
   */
  readonly automationPoints: readonly VolumeAutomationPoint[];
  readonly durationMs: number;
}

export interface MasteringDspPort {
  analyse(request: AnalyseRequest): Promise<AnalyseResult>;
  normaliseLoudness(request: NormaliseLoudnessRequest): Promise<NormaliseLoudnessResult>;
  cleanDialogue(request: DialogueCleanupRequestDsp): Promise<DialogueCleanupResultDsp>;
  duck(request: DuckingRequestDsp): Promise<DuckingResultDsp>;
}

/**
 * The separately deployed parameter-suggestion model (Requirements 30.19–30.21, 30.23).
 *
 * `suggest` returns the raw chain items rather than a validated `EffectChain`, because
 * Requirement 30.2 makes range conformance something the *assistant* must establish about
 * the model's output — a port typed as already-valid would make the invariant unfalsifiable.
 */
export interface SuggestionModelRequest {
  readonly source: MasteringAudioRef;
  readonly measurement: MasteringMeasurement;
}

export interface SuggestionModelResponse {
  readonly engineId: string;
  /** Unvalidated. See above. */
  readonly items: unknown;
  /** Requirement 30.23: the model's `License_Descriptor` ruling. */
  readonly commercialUseAllowed: boolean;
}

export interface SuggestionModelPort {
  /**
   * Requirement 30.20: the caller imposes the 120-second budget, not this method.
   *
   * The port has no timeout parameter because the budget is a policy of the assistant and
   * must hold for every implementation — including one whose transport has no timeout of its
   * own. `adapters/deepafx/` applies it through the injectable `TimeoutRunner`, so the
   * timeout path is testable without waiting 120 seconds.
   */
  suggest(request: SuggestionModelRequest): Promise<SuggestionModelResponse>;
}
