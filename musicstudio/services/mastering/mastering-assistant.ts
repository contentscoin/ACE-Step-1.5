/**
 * `Mastering_Assistant` (Requirements 30.1–30.26).
 *
 * Four operations, one shape: validate the request here, send it across
 * `MasteringDspPort`, **check the invariants the requirement states over the result**, and
 * fold a new `Generation_Version` in through task 3.2's `createDerivedVersion`.
 *
 * ### Validation precedes the port, always
 *
 * Requirement 30.26 requires a refusal naming the offending parameter and its range, *and*
 * requires that no new version be created. Both are only answerable synchronously if the
 * check precedes the queue — so `normaliseLoudness` and `duck` run their violation lists
 * before touching the port, and every refusal path returns before the version set is read.
 *
 * ### The result is checked, not trusted
 *
 * Requirements 30.7, 30.9, 30.10, 30.12 and 30.16 are stated as invariants of what
 * `Mastering_Assistant` produces. A result that breaches one is a failure of *this* service,
 * and reporting it is more useful than storing a version whose loudness nobody checked. This
 * is the same stance `services/effects/effects-service.ts` takes on Requirement 29.30, and
 * the same reason: an invariant nothing verifies is a comment.
 *
 * The bounds those checks use come from `domain/quality/mastering-thresholds.ts`, read once
 * per operation through the `QualityThresholdSource`, so a single verdict cannot mix two
 * threshold-set versions (Requirement 34.6) — and the version travels onto the result so the
 * caller can record it.
 *
 * ### Requirement 30.18's reproducibility is a property of the worker, not of this module
 *
 * "동일한 입력 오디오와 동일한 처리 파라미터로 … 매 회 샘플 단위로 동일한 오디오를 산출한다".
 * Nothing here reads a clock, draws a random number or depends on call order — identifiers
 * and timestamps arrive as arguments, exactly as `version-manager.ts` requires — so this
 * service cannot be the thing that breaks it. The determinism of the samples themselves is
 * `dsp/src/musicstudio_dsp/mastering.py`'s, and `dsp/test/test_mastering.py` asserts it.
 *
 * ### Requirement 30.4: both audios stay playable
 *
 * Every successful result names the input `MasteringAudioRef` as well as the output. The
 * input is never overwritten — the worker writes a new object and `createDerivedVersion`
 * adds a version rather than editing one (Requirement 29.14) — so "제안 적용 이전 오디오와
 * 이후 오디오를 모두 재생 가능한 상태로" holds because nothing is ever replaced. Requirement
 * 30.25's "입력 Generation_Version을 변경하지 않고 보존한다" is the same structural fact.
 */

import {
  TRUE_PEAK_CEILING_DBTP,
  type MasteringSubject,
} from '../../domain/mastering';
import {
  duckingDefects,
  type SpeechRegion,
  type TrackVolumeAutomation,
} from '../../domain/mastering/ducking';
import type { MasteringMeasurement } from '../../domain/mastering/measurement';
import { reportMeasurement } from '../../domain/mastering/measurement';
import type {
  DialogueCleanupRequest,
  DuckingRequest,
  DuckingParameters,
  LoudnessNormalizationParameters,
  LoudnessNormalizationRequest,
} from '../../domain/mastering/request';
import {
  builtInSuggestion,
  isUsableSuggestion,
  suggestionDefects,
  type MasteringSuggestion,
} from '../../domain/mastering/suggestion';
import {
  duckingRequestViolations,
  loudnessRequestViolations,
  resolveDuckingParameters,
  resolveLoudnessParameters,
} from '../../domain/mastering/validation';
import { toChain } from '../../domain/effects/chain';
import {
  dialogueCleanupThresholds,
  duckingThresholds,
  loudnessNormalizationThresholds,
} from '../../domain/quality/mastering-thresholds';
import { speechPresenceThresholds } from '../../domain/quality/speech-thresholds';
import type { QualityThresholdSource } from '../../domain/quality/threshold-source';
import type { GenerationVersion } from '../../domain/generation-version';

import { refuse, type MasteringRefusal } from './errors';
import type {
  MasteringAudioRef,
  MasteringDspPort,
  SuggestionModelPort,
} from './ports';
import { createDerivedVersion } from '../effects/version-manager';

/** What every successful operation reports. */
interface MasteringSuccessBase {
  readonly ok: true;
  /** Requirements 30.4, 30.25: the input, still playable and still stored. */
  readonly input: MasteringAudioRef;
  readonly output: MasteringAudioRef;
  /** Requirement 34.6: the threshold-set version this run was judged against. */
  readonly qualityThresholdSetVersion: number;
  readonly versions: readonly GenerationVersion[];
  readonly created: GenerationVersion;
}

export interface NormaliseLoudnessSuccess extends MasteringSuccessBase {
  readonly parameters: LoudnessNormalizationParameters;
  /** Requirement 30.24's reported form: rounded to 0.1. */
  readonly before: MasteringMeasurement;
  readonly after: MasteringMeasurement;
  /** Requirement 30.8's quantity, unrounded — what Property 15 bounds. */
  readonly appliedGainDb: number;
  /** Requirement 30.25: `0` when the target was reached, else how far short, in LUFS. */
  readonly shortfallLufs: number;
  readonly targetMissed: boolean;
}

export interface DialogueCleanupSuccess extends MasteringSuccessBase {
  readonly speechRegions: readonly SpeechRegion[];
  /** Requirement 30.9: how far the non-speech sections actually came down, in dB. */
  readonly nonSpeechAttenuationDb: number;
  /** Requirement 30.9: how far the speech sections' loudness moved, in LUFS. */
  readonly speechLoudnessDeltaLufs: number;
  /** Requirement 30.10: |output − input| length error, in ms. */
  readonly lengthErrorMs: number;
}

export interface DuckingSuccess extends MasteringSuccessBase {
  readonly parameters: DuckingParameters;
  /** Requirement 30.17: the stored, user-editable curve. */
  readonly automation: TrackVolumeAutomation;
}

export interface SuggestSuccess {
  readonly ok: true;
  readonly suggestion: MasteringSuggestion;
  /** Requirement 30.22/30.24: the same measurement, rounded for display. */
  readonly reported: MasteringMeasurement;
}

export type NormaliseLoudnessOutcome = NormaliseLoudnessSuccess | MasteringRefusal;
export type DialogueCleanupOutcome = DialogueCleanupSuccess | MasteringRefusal;
export type DuckingOutcome = DuckingSuccess | MasteringRefusal;
export type SuggestOutcome = SuggestSuccess | MasteringRefusal;

/**
 * The bookkeeping a new version needs, supplied by the caller.
 *
 * Identifiers and the timestamp are arguments rather than generated here for the reason the
 * module comment gives about Requirement 30.18: a service that minted a UUID or read a clock
 * could not be called twice with identical inputs.
 */
export interface VersionWrite {
  readonly versions: readonly GenerationVersion[];
  readonly newVersionId: string;
  readonly name: string;
  readonly createdAtMs: number;
}

export interface MasteringAssistant {
  suggest(source: MasteringAudioRef): Promise<SuggestOutcome>;
  normaliseLoudness(
    request: LoudnessNormalizationRequest,
    source: MasteringAudioRef,
    write: VersionWrite,
  ): Promise<NormaliseLoudnessOutcome>;
  cleanDialogue(
    request: DialogueCleanupRequest,
    source: MasteringAudioRef,
    write: VersionWrite,
  ): Promise<DialogueCleanupOutcome>;
  duck(
    request: DuckingRequest,
    dialogueSource: MasteringAudioRef,
    musicSource: MasteringAudioRef,
    write: VersionWrite,
  ): Promise<DuckingOutcome>;
}

export interface MasteringAssistantDependencies {
  readonly dsp: MasteringDspPort;
  /**
   * Requirements 30.19–30.21. Optional: an operator who has not deployed the suggestion
   * service at all is in exactly the state 30.21 describes, so omitting it takes the
   * built-in path rather than being a configuration error.
   */
  readonly suggestionModel?: SuggestionModelPort;
  readonly thresholds: QualityThresholdSource;
}

export function createMasteringAssistant(
  dependencies: MasteringAssistantDependencies,
): MasteringAssistant {
  const { dsp, suggestionModel, thresholds } = dependencies;

  return {
    /**
     * Requirements 30.1, 30.2, 30.4, 30.21, 30.22, 30.23.
     *
     * The analysis happens first and unconditionally, because Requirement 30.22 puts the
     * measurements in the response whichever source the suggestion came from — and because
     * the built-in fallback of 30.21 needs them too. So an unreachable model costs the
     * suggestion, never the report.
     *
     * A model answer that fails Requirement 30.2 or 30.22 falls back to the built-in
     * exactly as an unreachable one does. See `domain/mastering/suggestion.ts` on why:
     * a service answering with something unusable is, for this clause, unavailable — and
     * clamping the model's numbers into range would return values it did not choose while
     * still labelling them a model suggestion.
     */
    async suggest(source) {
      const { measurement } = await dsp.analyse({ source });
      const fallback = builtInSuggestion(measurement);

      if (suggestionModel === undefined) {
        return succeedSuggestion(fallback);
      }

      let response;
      try {
        response = await suggestionModel.suggest({ source, measurement });
      } catch {
        // Requirements 30.20, 30.21: an error and a timeout are the same state — the
        // service is unavailable — and the adapter has already decided which by the time
        // this rejects. Swallowed rather than propagated because 30.21 requires an answer.
        return succeedSuggestion(fallback);
      }

      let candidate: MasteringSuggestion;
      try {
        candidate = {
          chain: toChain(response.items),
          source: 'model',
          measurement,
          engineId: response.engineId,
          commercialUseAllowed: response.commercialUseAllowed,
        };
      } catch {
        // `toChain` throws on a structurally invalid chain. Requirement 30.2's invariant
        // covers ranges; a chain that is not even an array of items fails earlier.
        return succeedSuggestion(fallback);
      }

      if (!isUsableSuggestion(candidate)) {
        if (!isUsableSuggestion(fallback)) {
          // Both unusable means our own built-in is broken, which is a defect rather than
          // an availability problem, so it is reported instead of hidden.
          return refuse('suggestion_unusable', {
            suggestionDefects: suggestionDefects(fallback),
          });
        }
        return succeedSuggestion(fallback);
      }

      return succeedSuggestion(candidate);
    },

    /** Requirements 30.5–30.8, 30.25, 30.26. */
    async normaliseLoudness(request, source, write) {
      const violations = loudnessRequestViolations(request);
      if (violations.length > 0) return refuse('parameter_out_of_range', { violations });

      const set = thresholds.current();
      const bounds = loudnessNormalizationThresholds(set);
      const parameters = resolveLoudnessParameters(request);

      const result = await dsp.normaliseLoudness({
        source,
        targetLufs: parameters.targetLufs,
      });

      // Requirement 30.6's precondition. Refused rather than silently returning the input,
      // for the reason `errors.ts` states on `not_measurable`.
      if (!result.measurable) {
        return refuse('not_measurable', {
          detail: 'no gating block cleared the -70.0 LUFS absolute gate',
        });
      }

      // Requirement 30.7 is an invariant of the output, so it is verified. The comparison
      // uses the *reported* peak, because 30.24 defines the true peak as the number rounded
      // to 0.1 and an unrounded -0.96 dBTP would otherwise fail a ceiling it reports as
      // meeting.
      const reportedAfter = reportMeasurement(result.after);
      if (reportedAfter.truePeakDbtp > TRUE_PEAK_CEILING_DBTP) {
        return refuse('true_peak_ceiling_exceeded', {
          measured: reportedAfter.truePeakDbtp,
          bound: TRUE_PEAK_CEILING_DBTP,
        });
      }

      // Requirement 30.25. The shortfall is measured against the *unrounded* loudness and
      // is zero unless it exceeds the tolerance, so a result inside 30.6's band is not
      // reported as missing its target by a rounding residue.
      const gap = parameters.targetLufs - result.after.integratedLoudnessLufs;
      const missed = result.targetMissed || Math.abs(gap) > bounds.targetToleranceLufs;
      const shortfallLufs = missed ? gap : 0;

      const versionOutcome = createDerivedVersion({
        assetId: request.subject.assetId,
        versions: write.versions,
        derivedFromVersionId: request.subject.versionId,
        newVersionId: write.newVersionId,
        name: write.name,
        // A normalisation is a gain change, expressed as the one-item chain Requirement
        // 29.6 already defines. Recording it as an `Effect_Chain` rather than as a bespoke
        // field means the version's provenance reads the same whether it came from
        // `Effects_Service` or from here, and it is replayable by the same worker task.
        chain: toChain([{ kind: 'gain', parameters: { gain_db: result.appliedGainDb } }]),
        durationMs: durationMsOf(result.output),
        createdAtMs: write.createdAtMs,
      });
      if (!versionOutcome.ok) {
        return refuse(versionOutcome.code, { versionRefusal: versionOutcome });
      }
      const created = versionOutcome.created;
      if (created === undefined) {
        return refuse('version_set_invalid', { detail: 'no version was created' });
      }

      return {
        ok: true,
        input: source,
        output: result.output,
        parameters,
        before: reportMeasurement(result.before),
        after: reportedAfter,
        appliedGainDb: result.appliedGainDb,
        shortfallLufs,
        targetMissed: missed,
        qualityThresholdSetVersion: set.version,
        versions: versionOutcome.versions,
        created,
      };
    },

    /** Requirements 30.9, 30.10, 30.11. */
    async cleanDialogue(request, source, write) {
      const set = thresholds.current();
      const bounds = dialogueCleanupThresholds(set);
      const speech = speechPresenceThresholds(set);

      const result = await dsp.cleanDialogue({
        source,
        speechRmsThresholdDb: speech.speechRmsThresholdDb,
        speechMinDurationMs: speech.speechMinDurationMs,
        nonSpeechAttenuationDb: bounds.nonSpeechAttenuationMinDb,
      });

      // Requirement 30.9's first half. Positive when the level came *down*, which is the
      // direction the clause asks for ("10.0데시벨 이상 낮추고"). Skipped — not passed —
      // when there is no non-speech section for the clause to be about; see
      // `DialogueCleanupResultDsp.hasNonSpeech` on why that is a flag and not an inference.
      const nonSpeechAttenuationDb = result.hasNonSpeech
        ? result.nonSpeechRmsBeforeDb - result.nonSpeechRmsAfterDb
        : Number.POSITIVE_INFINITY;
      if (result.hasNonSpeech && nonSpeechAttenuationDb < bounds.nonSpeechAttenuationMinDb) {
        return refuse('non_speech_attenuation_insufficient', {
          measured: nonSpeechAttenuationDb,
          bound: bounds.nonSpeechAttenuationMinDb,
        });
      }

      // Requirement 30.9's second half. `speechLoudnessDeltaLufs` is signed so the response
      // says which way it moved; the check is on the magnitude.
      //
      // Both loudnesses are `-Infinity` for audio with no speech in it, making the
      // difference `NaN`. That case is *also* vacuous — there is no speech whose loudness
      // could have moved — so it is skipped explicitly rather than relying on `NaN > x`
      // being false.
      const speechMeasured =
        Number.isFinite(result.speechLoudnessBeforeLufs) &&
        Number.isFinite(result.speechLoudnessAfterLufs);
      const speechLoudnessDeltaLufs = speechMeasured
        ? result.speechLoudnessAfterLufs - result.speechLoudnessBeforeLufs
        : 0;
      if (
        speechMeasured &&
        Math.abs(speechLoudnessDeltaLufs) > bounds.speechLoudnessToleranceLufs
      ) {
        return refuse('speech_loudness_moved', {
          measured: speechLoudnessDeltaLufs,
          bound: bounds.speechLoudnessToleranceLufs,
        });
      }

      // Requirement 30.10.
      const lengthErrorMs = Math.abs(result.outputDurationMs - result.inputDurationMs);
      if (lengthErrorMs > bounds.lengthToleranceMs) {
        return refuse('length_not_preserved', {
          measured: lengthErrorMs,
          bound: bounds.lengthToleranceMs,
        });
      }

      const versionOutcome = createDerivedVersion({
        assetId: request.subject.assetId,
        versions: write.versions,
        derivedFromVersionId: request.subject.versionId,
        newVersionId: write.newVersionId,
        name: write.name,
        // Requirement 30.9's cleanup is a time-varying envelope, not a chain of the eight
        // kinds Requirement 29.1 defines, so the chain recorded on the version is the
        // identity `gain` of 0 dB: the version's audio is authoritative and the chain field
        // is provenance. Recording one of the eight kinds with invented parameters would be
        // a claim that replaying it reproduces the audio, which is false.
        chain: toChain([{ kind: 'gain', parameters: { gain_db: 0 } }]),
        durationMs: result.outputDurationMs,
        createdAtMs: write.createdAtMs,
      });
      if (!versionOutcome.ok) {
        return refuse(versionOutcome.code, { versionRefusal: versionOutcome });
      }
      const created = versionOutcome.created;
      if (created === undefined) {
        return refuse('version_set_invalid', { detail: 'no version was created' });
      }

      return {
        ok: true,
        input: source,
        output: result.output,
        speechRegions: result.speechRegions,
        nonSpeechAttenuationDb,
        speechLoudnessDeltaLufs,
        lengthErrorMs,
        qualityThresholdSetVersion: set.version,
        versions: versionOutcome.versions,
        created,
      };
    },

    /** Requirements 30.12–30.17, 30.26. */
    async duck(request, dialogueSource, musicSource, write) {
      const violations = duckingRequestViolations(request);
      if (violations.length > 0) return refuse('parameter_out_of_range', { violations });

      const set = thresholds.current();
      const bounds = duckingThresholds(set);
      const speech = speechPresenceThresholds(set);
      const parameters = resolveDuckingParameters(request);

      const result = await dsp.duck({
        dialogueSource,
        musicSource,
        depthDb: parameters.depthDb,
        attackMs: parameters.attackMs,
        releaseMs: parameters.releaseMs,
        speechRmsThresholdDb: speech.speechRmsThresholdDb,
        speechMinDurationMs: speech.speechMinDurationMs,
      });

      const automation: TrackVolumeAutomation = {
        points: result.automationPoints,
        speechRegions: result.speechRegions,
        depthDb: parameters.depthDb,
        attackMs: parameters.attackMs,
        releaseMs: parameters.releaseMs,
        durationMs: result.durationMs,
      };

      // Requirements 30.12 and 30.16, verified against the curve the worker returned. See
      // `domain/mastering/ducking.ts` on why this is a check and not a regeneration.
      const defects = duckingDefects(automation, bounds);
      if (defects.length > 0) {
        return refuse('ducking_curve_invalid', { automationDefects: defects });
      }

      const versionOutcome = createDerivedVersion({
        assetId: request.musicSubject.assetId,
        versions: write.versions,
        derivedFromVersionId: request.musicSubject.versionId,
        newVersionId: write.newVersionId,
        name: write.name,
        // As with cleanup: the audio is authoritative and Requirement 30.17's automation
        // curve is the replayable artefact, so the chain field is the identity gain.
        chain: toChain([{ kind: 'gain', parameters: { gain_db: 0 } }]),
        durationMs: result.durationMs,
        createdAtMs: write.createdAtMs,
      });
      if (!versionOutcome.ok) {
        return refuse(versionOutcome.code, { versionRefusal: versionOutcome });
      }
      const created = versionOutcome.created;
      if (created === undefined) {
        return refuse('version_set_invalid', { detail: 'no version was created' });
      }

      return {
        ok: true,
        // Requirement 30.12: the *music* track is the one processed, so it is the input
        // reported. The dialogue track is read and never modified.
        input: musicSource,
        output: result.output,
        parameters,
        automation,
        qualityThresholdSetVersion: set.version,
        versions: versionOutcome.versions,
        created,
      };
    },
  };
}

function succeedSuggestion(suggestion: MasteringSuggestion): SuggestSuccess {
  return { ok: true, suggestion, reported: reportMeasurement(suggestion.measurement) };
}

function durationMsOf(ref: MasteringAudioRef): number {
  if (ref.sampleRate <= 0) return 0;
  return (ref.frameCount * 1000) / ref.sampleRate;
}

/** Re-exported so a caller can name a subject without importing the domain module. */
export type { MasteringSubject };
