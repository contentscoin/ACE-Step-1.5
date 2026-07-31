/**
 * Transcription_Service rejections (Requirements 27.15, 27.16, 27.11, 27.17).
 *
 * `GenerationError`s, so the one gateway contract renders them. The four map onto the four things
 * Requirement 27 refuses:
 *
 * | criterion | status | code |
 * |---|---|---|
 * | 27.5, 27.15 audio out of bounds | 400 | `transcription_request_invalid` |
 * | 27.16 engine failed or budget elapsed | 422 | `transcription_failed` |
 * | 27.11 text outside 1–500 characters | 400 | `transcription_text_rejected` |
 * | 27.17 a time edit breaking 27.6–27.8 | 400 | `transcription_edit_rejected` |
 *
 * Every payload states what was left unchanged. 27.15 requires the audio file to be untouched,
 * 27.16 requires a previously stored result to survive, and 27.17 requires the line's prior times
 * to be kept — none of which a client can infer from a status code, so each is named.
 */

import { describeViolation, type SongFieldViolation } from '../../domain/song/violation';
import {
  TRANSCRIPTION_DURATION_MS_MAX,
  TRANSCRIPTION_DURATION_MS_MIN,
  TRANSCRIPTION_FILE_SIZE_BYTES_MAX,
  TRANSCRIPTION_LINE_TEXT_MAX_LENGTH,
  TRANSCRIPTION_LINE_TEXT_MIN_LENGTH,
  TRANSCRIPTION_SAMPLE_RATE_MAX,
  TRANSCRIPTION_SAMPLE_RATE_MIN,
} from '../../domain/transcription/bounds';
import type {
  TranscriptionDefect,
  TranscriptionReasonCode,
} from '../../domain/transcription/result';
import { GenerationError } from '../generation/errors';

/** Requirement 27.15's 허용 범위, echoed on every request rejection. */
export const TRANSCRIPTION_ALLOWANCE = {
  durationMsMin: TRANSCRIPTION_DURATION_MS_MIN,
  durationMsMax: TRANSCRIPTION_DURATION_MS_MAX,
  fileSizeBytesMax: TRANSCRIPTION_FILE_SIZE_BYTES_MAX,
  sampleRateMin: TRANSCRIPTION_SAMPLE_RATE_MIN,
  sampleRateMax: TRANSCRIPTION_SAMPLE_RATE_MAX,
} as const;

export const TRANSCRIPTION_CONSTRAINTS = [
  'duration',
  'fileSize',
  'sampleRate',
  'tierId',
  'languageCode',
] as const;

export type TranscriptionConstraint = (typeof TRANSCRIPTION_CONSTRAINTS)[number];

export const TRANSCRIPTION_CONSTRAINT_REQUIREMENT: Readonly<
  Record<TranscriptionConstraint, string>
> = {
  duration: '27.5',
  fileSize: '27.5',
  sampleRate: '27.5',
  tierId: '27.2',
  languageCode: '27.3',
};

/**
 * Requirement 27.15 — every violated constraint name with the measured value and the range.
 *
 * `audioUnchanged` is stated because 27.15 requires it ("대상 오디오 파일을 변경 없이 유지한다") and a
 * client cannot see it otherwise.
 */
export function transcriptionRequestInvalid(detail: {
  readonly audioId: string;
  readonly violations: readonly SongFieldViolation[];
  readonly constraints: readonly TranscriptionConstraint[];
}): GenerationError {
  return new GenerationError(
    400,
    'transcription_request_invalid',
    detail.violations.map(describeViolation).join('; '),
    {
      audioId: detail.audioId,
      violations: detail.violations,
      constraints: detail.constraints,
      requirements: detail.constraints.map(
        (constraint) => TRANSCRIPTION_CONSTRAINT_REQUIREMENT[constraint],
      ),
      allowance: TRANSCRIPTION_ALLOWANCE,
      audioUnchanged: true,
    },
  );
}

/**
 * Requirement 27.16 — the engine failed, or 27.1's response budget elapsed.
 *
 * One code with a reason code inside rather than two codes, because 27.16 treats the two the same
 * way and asks for a "실패 사유 코드" — which is exactly that reason code.
 * `previousResultPreserved` is the other half of the criterion, stated so a client knows whether an
 * earlier result is still there to fall back on.
 */
export function transcriptionFailed(detail: {
  readonly audioId: string;
  readonly reasonCode: TranscriptionReasonCode;
  readonly detail?: string;
  readonly previousResultPreserved: boolean;
  readonly budgetMs: number;
}): GenerationError {
  return new GenerationError(422, 'transcription_failed', `transcription failed: ${detail.reasonCode}`, {
    audioId: detail.audioId,
    reasonCode: detail.reasonCode,
    ...(detail.detail === undefined ? {} : { detail: detail.detail }),
    previousResultPreserved: detail.previousResultPreserved,
    responseBudgetMs: detail.budgetMs,
    requirements: ['27.16', '27.1'],
  });
}

/** Requirement 27.11 — the edited text is outside 1–500 characters. */
export function transcriptionTextRejected(detail: {
  readonly audioId: string;
  readonly lineIndex: number;
  readonly violation: SongFieldViolation;
}): GenerationError {
  return new GenerationError(
    400,
    'transcription_text_rejected',
    describeViolation(detail.violation),
    {
      audioId: detail.audioId,
      lineIndex: detail.lineIndex,
      violation: detail.violation,
      minLength: TRANSCRIPTION_LINE_TEXT_MIN_LENGTH,
      maxLength: TRANSCRIPTION_LINE_TEXT_MAX_LENGTH,
      timingsUnchanged: true,
      requirements: ['27.11'],
    },
  );
}

/**
 * Requirement 27.17 — the time edit would break one of the three invariants.
 *
 * `violatedInvariants` are the defect kinds of `domain/transcription/result.ts`, which is the same
 * vocabulary the invariant predicate produces — so the name a user sees is the name the check
 * produced rather than a second spelling of the same three rules.
 */
export function transcriptionEditRejected(detail: {
  readonly audioId: string;
  readonly lineIndex: number;
  readonly violated: readonly TranscriptionDefect['kind'][];
  readonly permittedFromMs: number;
  readonly permittedToMs: number;
}): GenerationError {
  return new GenerationError(
    400,
    'transcription_edit_rejected',
    `the edit violates ${detail.violated.join(', ')}`,
    {
      audioId: detail.audioId,
      lineIndex: detail.lineIndex,
      violatedInvariants: detail.violated,
      permittedFromMs: detail.permittedFromMs,
      permittedToMs: detail.permittedToMs,
      // Requirement 27.17: 수정 이전 시작 시각과 종료 시각을 유지한다.
      timingsUnchanged: true,
      requirements: ['27.17', '27.6', '27.7', '27.8'],
    },
  );
}

/** A transcription was requested for something with no stored result to edit. */
export function transcriptionNotFound(audioId: string): GenerationError {
  return new GenerationError(
    404,
    'transcription_request_invalid',
    'No stored transcription exists for this audio.',
    { audioId, audioUnchanged: true },
  );
}
