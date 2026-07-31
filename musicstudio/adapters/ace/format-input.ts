/**
 * ACE-Step's `/format_input` route (Requirement 8.1).
 *
 * The engine's lyric/caption enrichment. It rides the same `AceTransport` port and
 * the same `unwrapEnvelope` decoding as `/release_task` and `/query_result`, so
 * design §1.4.4's single HTTP coupling point stays single: there is no second HTTP
 * client, no second envelope reader, and no second place that knows the engine's
 * base URL or token.
 *
 * It is a free function rather than a method on `AceEngineAdapter` because it is not
 * part of `EngineAdapter`. That interface is the submit/poll/fetch job lifecycle;
 * enrichment is a synchronous request/response that creates no Generation_Job,
 * charges nothing (Requirement 8.6) and is offered by no other engine.
 *
 * Wire contract, transcribed from `acestep/api/http/sample_format_routes.py`:
 *
 * - Request: `prompt`, `lyrics`, `temperature`, and a `param_obj` object holding
 *   `bpm`, `key`, `time_signature`, `duration`, `language`. The route accepts
 *   `param_obj` as either an object or a JSON string; the object form is sent, being
 *   the typed one. Fields the caller left empty are omitted rather than sent null —
 *   the route builds `user_metadata_for_format` from truthy values only, so an
 *   omitted field is how "engine, you decide" is expressed (the same rule as
 *   Requirements 3.3 and 4.7).
 * - Response `data`: `caption`, `lyrics`, `bpm`, `key_scale`, `time_signature`,
 *   `duration`, `vocal_language` — exactly the seven values Requirement 8.1 lists.
 *   Note the response spells the key as `key_scale` while the request spells it
 *   `key`; that asymmetry is the engine's, and this module is where it stops.
 * - Failure: reported *inside* a 200 as `code: 500`, which `unwrapEnvelope` already
 *   converts into a thrown `AceEngineError`. That is what Requirement 8.5 keys on.
 */

import { isSongTimeSignature, type SongTimeSignature } from '../../domain/song/engine-bounds';
import type { LyricsFormatPort } from '../../services/lyrics/format-port';

import { asFiniteNumber, asRecord, asReportedText, unwrapEnvelope } from './envelope';
import { aceMalformedResponse } from './errors';
import type { AceTransport } from './transport';

export const ACE_FORMAT_INPUT_PATH = '/format_input';

/** The engine's own default; sent explicitly so the value is visible on the wire. */
export const ACE_FORMAT_INPUT_DEFAULT_TEMPERATURE = 0.85;

/**
 * What the caller already has. Every musical field is optional: `/format_input`
 * treats a supplied value as a constraint to respect and an absent one as a value to
 * invent.
 */
export interface AceFormatInputRequest {
  /** The draft caption, sent as `prompt`. */
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
 * The seven values Requirement 8.1 requires back.
 *
 * Typed with the `domain/song/` vocabulary rather than with the engine's, so a
 * caller can hand these straight to `validateSongRequest`. `null` means the engine
 * reported nothing usable for that field; `asReportedText` already maps the engine's
 * `"N/A"` marker to nothing, and `"unknown"` is mapped here for the same reason —
 * `VOCAL_LANGUAGE_AUTO` is the engine's "not determined" sentinel, not a language.
 */
export interface AceFormattedSample {
  readonly caption: string | null;
  readonly lyrics: string | null;
  readonly bpm: number | null;
  readonly keyScale: string | null;
  readonly timeSignature: SongTimeSignature | null;
  readonly durationSeconds: number | null;
  readonly vocalLanguage: string | null;
}

export async function requestAceFormatInput(
  transport: AceTransport,
  request: AceFormatInputRequest,
): Promise<AceFormattedSample> {
  const response = await transport.postJson({
    path: ACE_FORMAT_INPUT_PATH,
    body: buildFormatInputBody(request),
  });

  const data = asRecord(unwrapEnvelope(ACE_FORMAT_INPUT_PATH, response));
  if (data === null) {
    throw aceMalformedResponse(
      ACE_FORMAT_INPUT_PATH,
      'ACE-Step returned no object for /format_input.',
    );
  }

  return {
    caption: asReportedText(data.caption),
    lyrics: asReportedText(data.lyrics),
    bpm: asFiniteNumber(data.bpm),
    keyScale: asReportedText(data.key_scale),
    timeSignature: readTimeSignature(data.time_signature),
    durationSeconds: asFiniteNumber(data.duration),
    vocalLanguage: readVocalLanguage(data.vocal_language),
  };
}

/**
 * Binds `/format_input` to the `LyricsFormatPort` Lyrics_Assistant depends on.
 *
 * The whole adapter is this one line, because `AceFormatInputRequest` and
 * `AceFormattedSample` were defined in the service layer's vocabulary to begin with.
 * The engine's field names never leave this file.
 */
export function createAceLyricsFormatPort(transport: AceTransport): LyricsFormatPort {
  return { format: (input) => requestAceFormatInput(transport, input) };
}

/** Exported so a test can assert the wire body without a transport double. */
export function buildFormatInputBody(
  request: AceFormatInputRequest,
): Readonly<Record<string, unknown>> {
  const paramObj: Record<string, unknown> = {
    ...(request.bpm === undefined ? {} : { bpm: request.bpm }),
    ...(request.keyScale === undefined ? {} : { key: request.keyScale }),
    ...(request.timeSignature === undefined
      ? {}
      : { time_signature: String(request.timeSignature) }),
    ...(request.durationSeconds === undefined ? {} : { duration: request.durationSeconds }),
    ...(request.vocalLanguage === undefined ? {} : { language: request.vocalLanguage }),
  };

  return {
    prompt: request.caption,
    lyrics: request.lyrics,
    temperature: request.temperature ?? ACE_FORMAT_INPUT_DEFAULT_TEMPERATURE,
    param_obj: paramObj,
  };
}

/**
 * `"4"` and `"4/4"` both mean a numerator of 4.
 *
 * `domain/song/engine-bounds.ts` models a time signature as that single integer
 * (the engine stores only the numerator), so the denominator is dropped. A value
 * outside the four accepted numerators becomes `null` rather than being passed on:
 * feeding it forward would only get it rejected later by `validateSongRequest`,
 * which is the single place Requirement 4.4's bound is enforced.
 */
function readTimeSignature(value: unknown): SongTimeSignature | null {
  const text = asReportedText(typeof value === 'number' ? String(value) : value);
  if (text === null) return null;
  const numerator = Number(text.split('/')[0]);
  return isSongTimeSignature(numerator) ? numerator : null;
}

function readVocalLanguage(value: unknown): string | null {
  const text = asReportedText(value);
  if (text === null || text.toLowerCase() === 'unknown') return null;
  return text;
}
