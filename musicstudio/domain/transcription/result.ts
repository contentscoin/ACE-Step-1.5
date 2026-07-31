/**
 * Transcription results and the three invariants they must always satisfy
 * (Requirements 27.1, 27.4, 27.6, 27.7, 27.8, 27.11, 27.12, 27.17).
 *
 * ### The invariants are enforced on the way in, not checked on the way out
 *
 * 27.6, 27.7 and 27.8 are stated as things the service *maintains*, and there are two ways to
 * maintain them: normalise whatever the engine returned, or refuse it. Both are used, and the
 * split matters:
 *
 * - **Engine output is normalised.** A model that returns lines out of order, or a line whose end
 *   is past the audio, is a model behaving normally at its edges — so lines are sorted, clamped
 *   to the audio length, and dropped when they are still degenerate. Refusing here would mean a
 *   perfectly usable transcription is lost because one line's end was 3 ms long.
 * - **A user's edit is refused.** 27.17 says so explicitly: an edit breaking any of the three
 *   invariants is rejected with the invariant's name and the permitted range, and the prior times
 *   are kept. Normalising a user's edit would silently move a timestamp they chose.
 *
 * ### 27.11 and 27.17 are different edits
 *
 * 27.11 edits *text* and requires the times to be untouched. 27.17 edits *times* and requires the
 * invariants. They are two functions here, because a single "update line" that took both would
 * make 27.11's "타이밍을 동일하게 유지" a rule the caller had to remember rather than a
 * consequence of the signature.
 */

import { rangeViolation, type SongFieldViolation } from '../song/violation';
import { isLanguageCode } from '../speech/language';

import {
  LANGUAGE_CONFIDENCE_UNDETERMINED_BELOW,
  TRANSCRIPTION_LINE_COUNT_MAX,
  TRANSCRIPTION_LINE_TEXT_MAX_LENGTH,
  TRANSCRIPTION_LINE_TEXT_MIN_LENGTH,
} from './bounds';

export interface TranscriptionLine {
  /** Requirement 27.1: milliseconds, integer. */
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/** Requirement 27.4's language report. */
export interface DetectedLanguage {
  readonly languageCode: string;
  /** `null` when the caller supplied the code as a hint (27.3) rather than it being detected. */
  readonly confidence: number | null;
  /** Requirement 27.4 — 판별 신뢰도가 0.50 미만인 경우 언어 미확정 표시. */
  readonly undetermined: boolean;
}

/** Requirement 27.12's reason code, and 27.16's. */
export const TRANSCRIPTION_REASON_CODES = [
  /** 27.12 — 발화 미검출. */
  'no_speech_detected',
  /** 27.16 — the engine reported a failure. */
  'engine_failure',
  /** 27.16 — 27.1's response budget elapsed. */
  'response_budget_exceeded',
] as const;

export type TranscriptionReasonCode = (typeof TRANSCRIPTION_REASON_CODES)[number];

export interface TranscriptionResult {
  readonly lines: readonly TranscriptionLine[];
  readonly language: DetectedLanguage;
  /** The audio this result describes — 27.6's upper bound. */
  readonly audioDurationMs: number;
  readonly tierId: string;
  readonly modelId: string;
  /**
   * Requirement 27.12 — set when no speech was found, in which case `lines` is empty.
   *
   * On the result rather than as a separate outcome type because 27.12 says the service
   * *returns* an empty line list plus a reason: it is a successful transcription of audio with
   * nothing in it, not a failure.
   */
  readonly reasonCode: TranscriptionReasonCode | null;
}

/** Requirement 27.4's rule, applied once so the flag and the confidence cannot disagree. */
export function detectedLanguage(languageCode: string, confidence: number | null): DetectedLanguage {
  return {
    languageCode,
    confidence,
    undetermined: confidence !== null && confidence < LANGUAGE_CONFIDENCE_UNDETERMINED_BELOW,
  };
}

/** Requirement 27.3: the hinted code is echoed with no confidence, because nothing detected it. */
export function hintedLanguage(languageCode: string): DetectedLanguage {
  return { languageCode, confidence: null, undetermined: false };
}

export type TranscriptionDefect =
  | { readonly kind: 'time_out_of_audio'; readonly lineIndex: number }
  | { readonly kind: 'non_positive_span'; readonly lineIndex: number }
  | { readonly kind: 'out_of_order'; readonly lineIndex: number }
  | { readonly kind: 'non_integer'; readonly lineIndex: number }
  | { readonly kind: 'text_out_of_range'; readonly lineIndex: number }
  | { readonly kind: 'line_count_out_of_range'; readonly count: number }
  | { readonly kind: 'malformed_language_code' };

/**
 * Requirements 27.6, 27.7, 27.8 (plus 27.1's count and 27.3/27.4's code), as one predicate.
 *
 * The invariant *names* are the defect kinds, which is what 27.17's rejection reports — so the
 * name a user sees when their edit is refused is the same name this predicate produced, rather
 * than a second vocabulary for the same three rules.
 */
export function transcriptionDefects(
  result: TranscriptionResult,
): readonly TranscriptionDefect[] {
  const defects: TranscriptionDefect[] = [];

  if (result.lines.length > TRANSCRIPTION_LINE_COUNT_MAX) {
    defects.push({ kind: 'line_count_out_of_range', count: result.lines.length });
  }
  if (!isLanguageCode(result.language.languageCode)) {
    defects.push({ kind: 'malformed_language_code' });
  }

  result.lines.forEach((line, index) => {
    if (!Number.isInteger(line.startMs) || !Number.isInteger(line.endMs)) {
      defects.push({ kind: 'non_integer', lineIndex: index });
    }
    // Requirement 27.6.
    if (
      line.startMs < 0 ||
      line.startMs > result.audioDurationMs ||
      line.endMs < 0 ||
      line.endMs > result.audioDurationMs
    ) {
      defects.push({ kind: 'time_out_of_audio', lineIndex: index });
    }
    // Requirement 27.7.
    if (!(line.startMs < line.endMs)) {
      defects.push({ kind: 'non_positive_span', lineIndex: index });
    }
    // Requirement 27.8.
    const previous = result.lines[index - 1];
    if (previous !== undefined && line.startMs < previous.startMs) {
      defects.push({ kind: 'out_of_order', lineIndex: index });
    }
    if (
      line.text.length < TRANSCRIPTION_LINE_TEXT_MIN_LENGTH ||
      line.text.length > TRANSCRIPTION_LINE_TEXT_MAX_LENGTH
    ) {
      defects.push({ kind: 'text_out_of_range', lineIndex: index });
    }
  });

  return defects;
}

export function isValidTranscription(result: TranscriptionResult): boolean {
  return transcriptionDefects(result).length === 0;
}

/**
 * Requirements 27.6, 27.7, 27.8 — normalise raw engine lines into a compliant list.
 *
 * Total: any input produces a valid list. In order:
 *
 * 1. times rounded to integers (27.1's millisecond integers);
 * 2. clamped into `[0, audioDurationMs]` (27.6);
 * 3. lines whose span is then non-positive are **dropped** (27.7) — a zero-length line has no
 *    audio to point at, and stretching it would invent a boundary the model did not report;
 * 4. text trimmed, over-long text truncated to 27.11's 500 characters, empty-text lines dropped;
 * 5. sorted by start, stably (27.8).
 *
 * The sort is stable so two lines the model gave the same start keep their transcription order —
 * the same reason `domain/lyrics/timed-lyrics.ts` insists on stability for a duet.
 */
export function normaliseTranscriptionLines(
  raw: readonly TranscriptionLine[],
  audioDurationMs: number,
): readonly TranscriptionLine[] {
  const bound = Math.max(0, Math.round(audioDurationMs));

  const cleaned = raw
    .map((line) => ({
      startMs: clamp(Math.round(line.startMs), 0, bound),
      endMs: clamp(Math.round(line.endMs), 0, bound),
      text: line.text.trim().slice(0, TRANSCRIPTION_LINE_TEXT_MAX_LENGTH),
    }))
    .filter((line) => line.startMs < line.endMs && line.text.length > 0);

  return cleaned
    .sort((left, right) => left.startMs - right.startMs)
    .slice(0, TRANSCRIPTION_LINE_COUNT_MAX);
}

/** Requirement 27.11's payload: what a text edit is allowed to be. */
export type LineTextEdit =
  | { readonly kind: 'applied'; readonly lines: readonly TranscriptionLine[] }
  | {
      readonly kind: 'rejected';
      readonly violation: SongFieldViolation;
    };

/**
 * Requirement 27.11 — replace one line's text, keeping its times.
 *
 * The times are copied from the existing line rather than accepted from the caller, so "시작
 * 시각과 종료 시각을 수정 이전 값과 동일하게 유지한다" is not a rule to obey but the only thing
 * the function can do.
 */
export function editLineText(
  lines: readonly TranscriptionLine[],
  lineIndex: number,
  text: string,
): LineTextEdit {
  const existing = lines[lineIndex];
  if (existing === undefined) {
    return {
      kind: 'rejected',
      violation: rangeViolation('lineIndex', lineIndex, 0, Math.max(0, lines.length - 1)),
    };
  }

  const trimmed = text.trim();
  if (
    trimmed.length < TRANSCRIPTION_LINE_TEXT_MIN_LENGTH ||
    trimmed.length > TRANSCRIPTION_LINE_TEXT_MAX_LENGTH
  ) {
    return {
      kind: 'rejected',
      violation: rangeViolation(
        'text',
        trimmed.length,
        TRANSCRIPTION_LINE_TEXT_MIN_LENGTH,
        TRANSCRIPTION_LINE_TEXT_MAX_LENGTH,
      ),
    };
  }

  return {
    kind: 'applied',
    lines: lines.map((line, index) =>
      index === lineIndex ? { startMs: line.startMs, endMs: line.endMs, text: trimmed } : line,
    ),
  };
}

export type LineTimingEdit =
  | { readonly kind: 'applied'; readonly lines: readonly TranscriptionLine[] }
  | {
      readonly kind: 'rejected';
      /** Requirement 27.17 — 위반된 불변식 이름. The defect kinds of this module. */
      readonly violated: readonly TranscriptionDefect['kind'][];
      /** Requirement 27.17 — 허용 시각 범위. */
      readonly permittedFromMs: number;
      readonly permittedToMs: number;
    };

/**
 * Requirement 27.17 — move one line's times, refusing anything that breaks 27.6–27.8.
 *
 * Refused rather than normalised, and the prior times are kept, because 27.17 says both. The
 * check is run over the *whole* candidate list rather than over the edited line alone: moving one
 * line's start past its successor's breaks 27.8 without breaking anything about the line itself,
 * and a per-line check would let it through.
 */
export function editLineTiming(
  result: TranscriptionResult,
  lineIndex: number,
  startMs: number,
  endMs: number,
): LineTimingEdit {
  const existing = result.lines[lineIndex];
  if (existing === undefined) {
    return {
      kind: 'rejected',
      violated: ['time_out_of_audio'],
      permittedFromMs: 0,
      permittedToMs: result.audioDurationMs,
    };
  }

  const candidate: readonly TranscriptionLine[] = result.lines.map((line, index) =>
    index === lineIndex ? { startMs, endMs, text: line.text } : line,
  );
  const defects = transcriptionDefects({ ...result, lines: candidate });

  if (defects.length > 0) {
    return {
      kind: 'rejected',
      violated: [...new Set(defects.map((defect) => defect.kind))],
      permittedFromMs: 0,
      permittedToMs: result.audioDurationMs,
    };
  }

  return { kind: 'applied', lines: candidate };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
