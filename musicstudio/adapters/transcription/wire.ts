/**
 * Decoding one ASR answer (Requirements 27.1, 27.3, 27.4).
 *
 * Separated from the adapter because the two decisions below are the whole of what this adapter
 * *decides*, and they are worth being able to test without a transport at all.
 *
 * ### Seconds to milliseconds
 *
 * Whisper-family servers report segment boundaries as floating-point **seconds**; Requirement 27.1
 * requires integer **milliseconds**. Rounding is therefore not a formatting choice, it is where a
 * boundary moves, and two rules follow:
 *
 * - **Round, do not truncate.** `Math.trunc` biases every boundary earlier by up to a millisecond,
 *   and the bias is systematic — over a 2000-line transcript every line drifts the same direction.
 *   Rounding halves the error and centres it.
 * - **Round both ends independently, and let the service drop what collapses.** A segment shorter
 *   than half a millisecond rounds to a zero-length line; `normaliseTranscriptionLines` drops it
 *   (Requirement 27.7). Widening it here would invent a boundary the model did not report, and
 *   inventing timings is exactly what Requirement 27.9 makes this service the sole source of.
 *
 * ### The confidence is null when the caller supplied a hint
 *
 * Requirement 27.3 (hinted) and 27.4 (detected) are different criteria, and `services/transcription/
 * ports.ts` fixes the distinction: `confidence` is a number only when the engine *detected* the
 * language. A hinted run still gets a `language_probability` back from most servers — the model
 * scores the language it was told to use — and passing that through would report a detection that
 * did not happen, and would let a hinted request come back marked "undetermined" (27.4's
 * sub-0.50 flag) for a language the caller chose.
 */

import type { TranscriptionLine } from '../../domain/transcription/result';

/** A segment as a Whisper-family server reports it. Times in seconds. */
export interface WhisperSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface WhisperResponse {
  readonly language: string;
  readonly languageProbability: number | null;
  readonly segments: readonly WhisperSegment[];
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read the envelope, or `null` if it is not one.
 *
 * Deliberately lenient about *extra* fields and strict about the three it needs. A server that
 * adds `words` or `avg_logprob` is still a server this adapter understands; one that omits
 * `segments` is not, and pretending its answer was an empty transcription would report silence for
 * audio the probe already found speech in.
 */
export function decodeWhisperResponse(body: unknown): WhisperResponse | null {
  const record = asRecord(body);
  if (record === null) return null;

  const language = record['language'];
  if (typeof language !== 'string' || language.length === 0) return null;

  const rawSegments = record['segments'];
  if (!Array.isArray(rawSegments)) return null;

  const segments: WhisperSegment[] = [];
  for (const entry of rawSegments) {
    const segment = asRecord(entry);
    if (segment === null) return null;

    const start = finiteNumber(segment['start']);
    const end = finiteNumber(segment['end']);
    const text = segment['text'];
    if (start === null || end === null || typeof text !== 'string') return null;

    segments.push({ start, end, text });
  }

  return {
    language,
    languageProbability: finiteNumber(record['language_probability']),
    segments,
  };
}

/** Seconds to integer milliseconds. See the header on why this rounds. */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * Segments to lines.
 *
 * The text is trimmed here because Whisper emits a leading space on nearly every segment, and a
 * line whose text begins with a space is a line every downstream consumer — the LRC printer of
 * Requirement 27.10, the plain-text download of 27.13 — would have to trim again or render wrong.
 * Nothing else about the text is touched: 27.11's length bound is the service's to apply.
 */
export function linesFromSegments(segments: readonly WhisperSegment[]): TranscriptionLine[] {
  return segments.map((segment) => ({
    startMs: secondsToMs(segment.start),
    endMs: secondsToMs(segment.end),
    text: segment.text.trim(),
  }));
}

/**
 * Requirements 27.3, 27.4 — what to report as the language, and whether it was detected.
 *
 * `hinted` decides, not the presence of a probability in the response. See the header.
 */
export function languageOf(
  response: WhisperResponse,
  hintedCode: string | undefined,
): { readonly languageCode: string; readonly confidence: number | null } {
  if (hintedCode !== undefined) return { languageCode: hintedCode, confidence: null };

  // Clamped to Requirement 27.4's 0.00–1.00 scale: a server reporting 1.0000000002 or a negative
  // log-probability in this field would otherwise produce a confidence outside the range the
  // criterion publishes, and 27.4's sub-0.50 flag is read off this number.
  const probability = response.languageProbability;
  const confidence = probability === null ? null : Math.max(0, Math.min(1, probability));
  return { languageCode: response.language, confidence };
}
