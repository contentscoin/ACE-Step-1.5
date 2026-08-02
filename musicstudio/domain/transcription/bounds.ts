/**
 * Bounds Requirement 27 states as structure.
 *
 * Every number Requirement 27 quotes is on the *structural* side of the split
 * `domain/v2a/bounds.ts` documents, and it is worth saying why none of them is a
 * Quality_Threshold_Set member:
 *
 * - The audio limits of 27.5 are the shape of an input the system can process, like 23.2's
 *   container list. A deployment that can transcribe a two-hour file has a different model, not
 *   a different calibration.
 * - The line count of 27.1 and the edit length of 27.11 are storage bounds.
 * - The response-time formula of 27.1 is a *contract*, and each tier's per-second cost is a
 *   declared property of a model rather than a judgement about output.
 * - 27.4's 0.50 confidence floor and 27.12's 200 ms speech floor look adjustable, and the second
 *   one nearly is — but 27.12's 200 ms is the same duration Requirement 30.12 gives as the
 *   minimum speech run, which is already the Quality_Threshold_Set member
 *   `speech_detection_min_duration_ms`. So 27.12 reads that member (see
 *   `domain/quality/speech-thresholds.ts`) rather than restating the number, and what is left
 *   here is only 27.4's language-confidence floor, which is a property of the *detector's*
 *   reported scale rather than of the audio.
 */

/** Requirement 27.1 — lines per transcription result. */
export const TRANSCRIPTION_LINE_COUNT_MIN = 1;
export const TRANSCRIPTION_LINE_COUNT_MAX = 2_000;

/** Requirement 27.5 — audio length, milliseconds. */
export const TRANSCRIPTION_DURATION_MS_MIN = 500;
export const TRANSCRIPTION_DURATION_MS_MAX = 3_600_000;

/** Requirement 27.5 — file size, bytes. 500 MB as the decimal megabyte the criterion means. */
export const TRANSCRIPTION_FILE_SIZE_BYTES_MAX = 500 * 1_000_000;

/** Requirement 27.5 — sample rate, hertz, inclusive at both ends. */
export const TRANSCRIPTION_SAMPLE_RATE_MIN = 8_000;
export const TRANSCRIPTION_SAMPLE_RATE_MAX = 48_000;

/** Requirement 27.2 — how many model tiers are offered. */
export const TRANSCRIPTION_TIER_COUNT_MIN = 2;
export const TRANSCRIPTION_TIER_COUNT_MAX = 5;

/** Requirement 27.2 — 오디오 길이 1초당 최대 처리 시간, seconds. */
export const TIER_SECONDS_PER_AUDIO_SECOND_MIN = 0.01;
export const TIER_SECONDS_PER_AUDIO_SECOND_MAX = 5.0;

/** Requirement 27.1 — the constant added to the per-second budget, milliseconds. */
export const TRANSCRIPTION_RESPONSE_OVERHEAD_MS = 60_000;

/** Requirement 27.4 — below this the language is reported as undetermined. */
export const LANGUAGE_CONFIDENCE_UNDETERMINED_BELOW = 0.5;

/** Requirement 27.4 — the confidence scale, inclusive. */
export const LANGUAGE_CONFIDENCE_MIN = 0.0;
export const LANGUAGE_CONFIDENCE_MAX = 1.0;

/** Requirement 27.11 — 행 텍스트 수정 길이 범위, characters. */
export const TRANSCRIPTION_LINE_TEXT_MIN_LENGTH = 1;
export const TRANSCRIPTION_LINE_TEXT_MAX_LENGTH = 500;

export function isTranscriptionDurationMs(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= TRANSCRIPTION_DURATION_MS_MIN &&
    value <= TRANSCRIPTION_DURATION_MS_MAX
  );
}

export function isTranscriptionSampleRate(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= TRANSCRIPTION_SAMPLE_RATE_MIN &&
    value <= TRANSCRIPTION_SAMPLE_RATE_MAX
  );
}

export function isLanguageConfidence(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= LANGUAGE_CONFIDENCE_MIN &&
    value <= LANGUAGE_CONFIDENCE_MAX
  );
}
