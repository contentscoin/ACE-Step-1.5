/**
 * The engine's formatting endpoint, as Lyrics_Assistant sees it (Requirement 8.1).
 *
 * Declared as a port in the service layer, not as a dependency on `adapters/ace/`,
 * for the reason design §1.2 gives: everything above the adapter layer speaks
 * musical vocabulary, so nothing here mentions `prompt`, `param_obj` or
 * `/format_input`. `createAceLyricsFormatPort` in `adapters/ace/format-input.ts` is
 * the one binding to ACE-Step, and it rides the shared `AceTransport`.
 *
 * `format` **throws** on engine failure rather than returning a union. That is not an
 * oversight: the adapter layer already has one failure vocabulary
 * (`AceEngineError`, raised by `unwrapEnvelope`), and translating it into a second
 * one at the port boundary would mean two representations of the same event. The
 * assistant catches it and produces Requirement 8.5's outcome, which is where the
 * requirement puts the decision.
 */

import type { SongTimeSignature } from '../../domain/song/engine-bounds';

/** What the user already has; any musical field may be absent (`engine, you decide`). */
export interface LyricsFormatInput {
  readonly caption: string;
  readonly lyrics: string;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: number;
  readonly durationSeconds?: number;
  readonly vocalLanguage?: string;
  readonly temperature?: number;
}

/**
 * The seven values Requirement 8.1 requires back, in the `domain/song/` vocabulary.
 *
 * `null` means the engine reported nothing usable for that field, which is different
 * from reporting a value the caller then has to second-guess.
 */
export interface FormattedLyricsSample {
  readonly caption: string | null;
  readonly lyrics: string | null;
  readonly bpm: number | null;
  readonly keyScale: string | null;
  readonly timeSignature: SongTimeSignature | null;
  readonly durationSeconds: number | null;
  readonly vocalLanguage: string | null;
}

export interface LyricsFormatPort {
  format(input: LyricsFormatInput): Promise<FormattedLyricsSample>;
}
