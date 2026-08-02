/**
 * The Speech_Service's rejections.
 *
 * All are `GenerationError`s, so `api/gateway/error-handler.ts` renders them with no new branch
 * and `details` reaches the client inside the `error` object — the same contract Requirements
 * 3.5/4.6, 7.2/7.4, 21.18, 22.3/22.19 and 23.4 already use.
 *
 * | criterion | status | code |
 * |---|---|---|
 * | 25.22 request out of range | 400 | `dialogue_request_invalid` |
 * | 25.14 stored line bounds unsatisfiable | 400 | `dialogue_lines_invalid` |
 * | 25.3 language unsupported by the chosen engine | 400 | `dialogue_language_unsupported` |
 * | 26.11 preset used with the wrong engine | 400 | `voice_profile_engine_locked` |
 * | 25.21 line index out of range | 400 | `dialogue_line_index_invalid` |
 * | 25.1 no line survived synthesis | 422 | `dialogue_generation_failed` |
 *
 * Every one of them is raised **before** anything is charged, except the last — which is raised
 * after Requirements 6.1–6.3 have already refunded the failed jobs. That is what discharges
 * 25.21's and 25.22's "크레딧을 차감하지 않는다" structurally rather than by a rule someone has to
 * remember: the refusals happen before `JobOrchestrator.submit` is ever called, so no code path
 * exists on which a debit could precede them.
 *
 * Note the status code chosen for 25.3 and 26.11. Both are 400 rather than 403: the request named
 * a combination that does not exist, which is a malformed request, not a permission problem. The
 * 403s of Requirement 26 belong to the share list (26.20) and the withdrawal states (26.29), both
 * of which are `services/voice/errors.ts`'s and reach the Speech_Service through
 * `ProfileAccessService.assertUsable` unchanged.
 */

import { describeViolation, type SongFieldViolation } from '../../domain/song/violation';
import {
  ACTING_INSTRUCTION_MAX_LENGTH,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  SCRIPT_MAX_LENGTH,
  SCRIPT_MIN_LENGTH,
  SPEAKING_RATE_MAX,
  SPEAKING_RATE_MIN,
  SPLIT_THRESHOLD_MAX,
  SPLIT_THRESHOLD_MIN,
} from '../../domain/speech/bounds';
import {
  DIALOGUE_LINE_COUNT_MAX,
  DIALOGUE_LINE_COUNT_MIN,
  DIALOGUE_LINE_LENGTH_MAX,
  DIALOGUE_LINE_LENGTH_MIN,
} from '../../domain/speech/bounds';
import {
  SCRIPT_LINE_CONSTRAINT_REQUIREMENT,
  type ScriptLineConstraint,
} from '../../domain/speech/lines';
import {
  SPEECH_REQUEST_CONSTRAINT_REQUIREMENT,
  type SpeechRequestConstraint,
} from '../../domain/speech/validation';
import { GenerationError } from '../generation/errors';

/** The allowances, echoed on every request rejection so a client can self-correct (25.22). */
export const DIALOGUE_REQUEST_ALLOWANCE = {
  scriptMinLength: SCRIPT_MIN_LENGTH,
  scriptMaxLength: SCRIPT_MAX_LENGTH,
  speakingRateMin: SPEAKING_RATE_MIN,
  speakingRateMax: SPEAKING_RATE_MAX,
  pitchSemitonesMin: PITCH_SEMITONES_MIN,
  pitchSemitonesMax: PITCH_SEMITONES_MAX,
  actingInstructionMaxLength: ACTING_INSTRUCTION_MAX_LENGTH,
  splitThresholdMin: SPLIT_THRESHOLD_MIN,
  splitThresholdMax: SPLIT_THRESHOLD_MAX,
} as const;

export const DIALOGUE_LINE_ALLOWANCE = {
  lineCountMin: DIALOGUE_LINE_COUNT_MIN,
  lineCountMax: DIALOGUE_LINE_COUNT_MAX,
  lineLengthMin: DIALOGUE_LINE_LENGTH_MIN,
  lineLengthMax: DIALOGUE_LINE_LENGTH_MAX,
} as const;

export interface DialogueRequestInvalidDetail {
  readonly violations: readonly SongFieldViolation[];
  readonly constraints: readonly SpeechRequestConstraint[];
}

/** Requirement 25.22 — the violated constraint names with their permitted ranges. */
export function dialogueRequestInvalid(detail: DialogueRequestInvalidDetail): GenerationError {
  return new GenerationError(
    400,
    'dialogue_request_invalid',
    detail.violations.map(describeViolation).join('; '),
    {
      violations: detail.violations,
      constraints: detail.constraints,
      requirements: detail.constraints.map(
        (constraint) => SPEECH_REQUEST_CONSTRAINT_REQUIREMENT[constraint],
      ),
      allowance: DIALOGUE_REQUEST_ALLOWANCE,
      creditsCharged: 0,
    },
  );
}

/**
 * Requirement 25.14 — the script cannot be stored as lines within the stated bounds.
 *
 * Presented in 25.22's form because 25.14 states bounds without stating a refusal; see the note
 * in `domain/speech/lines.ts` on why refusal is the only available outcome.
 */
export function dialogueLinesInvalid(detail: {
  readonly violations: readonly SongFieldViolation[];
  readonly constraints: readonly ScriptLineConstraint[];
  readonly lineCount: number;
}): GenerationError {
  return new GenerationError(
    400,
    'dialogue_lines_invalid',
    detail.violations.map(describeViolation).join('; '),
    {
      violations: detail.violations,
      constraints: detail.constraints,
      requirements: detail.constraints.map(
        (constraint) => SCRIPT_LINE_CONSTRAINT_REQUIREMENT[constraint],
      ),
      lineCount: detail.lineCount,
      allowance: DIALOGUE_LINE_ALLOWANCE,
      creditsCharged: 0,
    },
  );
}

/**
 * Requirement 25.3 — the chosen engine does not support the requested language.
 *
 * `supportingEngineIds` is the criterion's own payload ("해당 언어를 지원하는 엔진 식별자 목록").
 * An empty list is a meaningful answer: no engine speaks it. `languageCatalogue` travels too, so
 * a client can satisfy 25.2's presentation obligation from the refusal alone rather than making a
 * second call.
 */
export function dialogueLanguageUnsupported(detail: {
  readonly languageCode: string;
  readonly engineId: string;
  readonly supportingEngineIds: readonly string[];
  readonly languageCatalogue: readonly { readonly engineId: string; readonly languageCodes: readonly string[] }[];
}): GenerationError {
  return new GenerationError(
    400,
    'dialogue_language_unsupported',
    `engine ${detail.engineId} does not support language ${detail.languageCode}`,
    {
      languageCode: detail.languageCode,
      engineId: detail.engineId,
      supportingEngineIds: detail.supportingEngineIds,
      languageCatalogue: detail.languageCatalogue,
      requirements: ['25.3', '25.2'],
      creditsCharged: 0,
    },
  );
}

/** Requirement 26.11 — a `preset` profile may only be used with its catalogue engine. */
export function voiceProfileEngineLocked(detail: {
  readonly voiceProfileId: string;
  readonly boundEngineId: string;
  readonly requestedEngineId: string;
}): GenerationError {
  return new GenerationError(
    400,
    'voice_profile_engine_locked',
    `this preset Voice_Profile is fixed to engine ${detail.boundEngineId}`,
    { ...detail, requirements: ['26.10', '26.11'], creditsCharged: 0 },
  );
}

/**
 * Requirement 25.21 — the line index named for re-synthesis does not exist.
 *
 * `validFromIndex`/`validToIndex` is the criterion's "유효 행 인덱스 범위", and
 * `timingsUnchanged` states the other half of it — that the existing audio and every line's
 * timing were left alone — so a client is not left inferring it from a separate read.
 */
export function dialogueLineIndexInvalid(detail: {
  readonly assetId: string;
  readonly requestedIndex: number;
  readonly lineCount: number;
}): GenerationError {
  return new GenerationError(
    400,
    'dialogue_line_index_invalid',
    `line index ${String(detail.requestedIndex)} is outside 0..${String(Math.max(0, detail.lineCount - 1))}`,
    {
      assetId: detail.assetId,
      requestedIndex: detail.requestedIndex,
      validFromIndex: 0,
      validToIndex: Math.max(0, detail.lineCount - 1),
      lineCount: detail.lineCount,
      timingsUnchanged: true,
      audioUnchanged: true,
      requirements: ['25.21'],
      creditsCharged: 0,
    },
  );
}

/** The asset a re-synthesis request named is not a dialogue asset this service produced. */
export function dialogueAssetNotFound(assetId: string): GenerationError {
  return new GenerationError(404, 'dialogue_asset_not_found', 'No such dialogue asset exists.', {
    assetId,
  });
}

export interface DialogueGenerationFailedDetail {
  readonly jobId: string | null;
  readonly lineCount: number;
  /** How many lines were synthesised before the failure. */
  readonly completedLineCount: number;
  readonly failure: import('../../domain/generation-job/failure').JobFailure | null;
}

/**
 * Requirement 25.1 — the job produced no audio.
 *
 * 422, because nothing about the request was wrong. `completedLineCount` is reported for the same
 * reason Requirement 23.17 asks for a segment count: it says how far along the script the job
 * got, which is the only useful diagnosis for a sequential synthesis. Nothing partial is stored —
 * stated in the payload so a client is not left guessing whether a half-finished asset exists.
 */
export function dialogueGenerationFailed(
  detail: DialogueGenerationFailedDetail,
): GenerationError {
  return new GenerationError(
    422,
    'dialogue_generation_failed',
    `dialogue synthesis produced no audio; ${String(detail.completedLineCount)} of ${String(detail.lineCount)} lines completed`,
    {
      jobId: detail.jobId,
      lineCount: detail.lineCount,
      completedLineCount: detail.completedLineCount,
      partialAudioStored: false,
      ...(detail.failure === null ? {} : { failure: detail.failure }),
    },
  );
}
