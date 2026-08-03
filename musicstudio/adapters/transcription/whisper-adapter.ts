/**
 * Whisper_Adapter — the ASR engine behind `Transcription_Service` (design §13, Requirement 27).
 *
 * The last piece of task 2.7: `TranscriptionEnginePort` had a shape and a scripted double, and no
 * implementation that could be pointed at a deployment. This is that implementation, and it is
 * deliberately thin — transport plus translation, with every rule Requirement 27 states about the
 * *result* left where it already lives:
 *
 * | criterion | who |
 * |---|---|
 * | 27.5, 27.15 — input validation | Transcription_Service, from the probe |
 * | 27.6, 27.7, 27.8 — the three invariants | `domain/transcription/result.ts` |
 * | 27.1's deadline, 27.16's expiry | Transcription_Service (`hasExceededBudget`) |
 * | 27.12 — no speech | Transcription_Service, before this adapter is called |
 * | 27.3, 27.4 — which language, and was it detected | `wire.ts` |
 *
 * ### It returns failures rather than throwing them
 *
 * Every other engine adapter here throws a typed error, because its caller is the Job_Orchestrator
 * and Requirement 6.2's retry schedule keys on the HTTP status. This port is different:
 * `TranscriptionEngineOutcome` has a `failed` arm, and Requirement 27.16 turns exactly that into a
 * reason code **while preserving any previously stored result**. A thrown exception would escape
 * that path — the caller would see a crash instead of the criterion's stated behaviour — so an
 * HTTP error, a malformed envelope and an engine-reported failure all become `{ kind: 'failed' }`
 * carrying a detail string. The detail is for an operator; the reason code the user sees is the
 * service's.
 *
 * A *programming* error still throws: a request with no `modelId` means routing sent work here
 * without choosing a tier, and inventing a model would transcribe with something nobody selected.
 *
 * ### It is not in the Provider_Registry
 *
 * Requirement 20's routing keys on Asset_Kind, and a transcription produces **no Audio_Asset** — it
 * produces text about one. So there is no Engine_Descriptor and no entry in
 * `ENGINE_ASSIGNMENTS`: registering one would create an engine that routing could select for a
 * generation it cannot perform. The tier list of Requirement 27.2 is this subsystem's own
 * selection mechanism, and `WHISPER_TRANSCRIPTION_TIERS` below is what it offers.
 */

import type {
  TranscriptionEngineOutcome,
  TranscriptionEnginePort,
  TranscriptionEngineRequest,
} from '../../services/transcription/ports';
import {
  isWellFormedTierSet,
  type TranscriptionTier,
} from '../../domain/transcription/model-tier';

import { decodeWhisperResponse, languageOf, linesFromSegments } from './wire';
import type { TranscriptionTransport } from './transport';

export const WHISPER_TRANSCRIPTION_PATH = '/v1/audio/transcriptions';

/**
 * Requirement 27.2's tier list, in real model names.
 *
 * `DEFAULT_TRANSCRIPTION_TIERS` in `domain/transcription/model-tier.ts` is a placeholder pair
 * (`asr-fast-v1`, `asr-accurate-v1`) that exists so the service is testable with no adapter. These
 * are what a Whisper deployment actually serves, and the per-second costs are **declarations a
 * deployment overrides**, not measurements — nothing here has run either model. They are ordered
 * and spaced the way the placeholders are, and for the same reason: two tiers an order of
 * magnitude apart make Requirement 27.1's deadline visibly different between them.
 *
 * `isWellFormedTierSet` is asserted over this list in the tests, so a deployment editing it cannot
 * quietly violate 27.2's 2–5 count or its 0.01–5.00 range.
 */
export const WHISPER_TRANSCRIPTION_TIERS: readonly TranscriptionTier[] = [
  { tierId: 'fast', modelId: 'whisper-base', secondsPerAudioSecond: 0.08 },
  { tierId: 'accurate', modelId: 'whisper-large-v3', secondsPerAudioSecond: 1.5 },
];

export interface WhisperAdapterOptions {
  readonly transport: TranscriptionTransport;
  /**
   * How an `audioId` becomes the object reference the deployment reads.
   *
   * Defaults to identity, which is right when the service's audio identifiers *are* object keys.
   * A deployment that stores them differently supplies the mapping rather than having this adapter
   * guess at a bucket layout it cannot know.
   */
  readonly objectKeyOf?: (audioId: string) => string;
  /** Overridable so a deployment can point at its own route. */
  readonly path?: string;
}

export function createWhisperTranscriptionAdapter(
  options: WhisperAdapterOptions,
): TranscriptionEnginePort {
  const objectKeyOf = options.objectKeyOf ?? ((audioId: string) => audioId);
  const path = options.path ?? WHISPER_TRANSCRIPTION_PATH;

  return {
    async transcribe(request: TranscriptionEngineRequest): Promise<TranscriptionEngineOutcome> {
      if (request.modelId.length === 0) {
        throw new Error('a transcription was submitted with no model identifier');
      }

      const response = await callEngine(options.transport, path, wireBody(request, objectKeyOf));
      if (response.kind === 'failed') return response;

      const decoded = decodeWhisperResponse(response.body);
      if (decoded === null) {
        return { kind: 'failed', detail: `${path} returned an envelope this adapter cannot read` };
      }

      const language = languageOf(decoded, request.languageCode);
      return {
        kind: 'transcribed',
        output: {
          lines: linesFromSegments(decoded.segments),
          languageCode: language.languageCode,
          confidence: language.confidence,
        },
      };
    },
  };
}

/**
 * The request body, in one place so the wire form is a single assertable value.
 *
 * `language` is present only when the caller supplied one, because that absence *is* Requirement
 * 27.4's instruction to detect: a server sent `language: null` may treat it as a literal setting,
 * and a server sent nothing detects. The audio duration goes along because a server that knows the
 * length ahead of time can size its own work, and it costs nothing — the service has it from the
 * probe (27.5) and re-deriving it engine-side would be a second measurement of the same file.
 */
function wireBody(
  request: TranscriptionEngineRequest,
  objectKeyOf: (audioId: string) => string,
): Readonly<Record<string, unknown>> {
  return {
    model: request.modelId,
    audio: {
      id: request.audioId,
      object_key: objectKeyOf(request.audioId),
      duration_ms: request.audioDurationMs,
    },
    // Whisper's own name for the segmented form. Word timings are not requested: Requirement 27.1
    // is a *line* list, and per-word boundaries would be a payload nothing here reads.
    response_format: 'verbose_json',
    ...(request.languageCode === undefined ? {} : { language: request.languageCode }),
  };
}

type EngineCall =
  | { readonly kind: 'ok'; readonly body: unknown }
  | { readonly kind: 'failed'; readonly detail: string };

/** Transport and status handling. Everything that goes wrong here is 27.16's failure. */
async function callEngine(
  transport: TranscriptionTransport,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<EngineCall> {
  let response;
  try {
    response = await transport.requestJson({ path, method: 'POST', body });
  } catch (error: unknown) {
    // A transport that threw — DNS, TLS, a socket reset — is an engine failure, not a crash of
    // the service that asked. 27.16 keeps whatever result was already stored.
    return { kind: 'failed', detail: `transport error: ${describe(error)}` };
  }

  if (response.httpStatus < 200 || response.httpStatus >= 300) {
    return {
      kind: 'failed',
      detail: `${path} answered HTTP ${String(response.httpStatus)}`,
    };
  }

  // Some deployments answer 200 with an error envelope. Read it rather than letting the decoder
  // report a shape problem, so an operator sees the engine's own words in the detail.
  const record =
    typeof response.body === 'object' && response.body !== null && !Array.isArray(response.body)
      ? (response.body as Record<string, unknown>)
      : null;
  const declaredError = record?.['error'];
  if (typeof declaredError === 'string' && declaredError.length > 0) {
    return { kind: 'failed', detail: declaredError };
  }

  return { kind: 'ok', body: response.body };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Guard for a deployment editing the tier list. See `WHISPER_TRANSCRIPTION_TIERS`. */
export function areWhisperTiersWellFormed(
  tiers: readonly TranscriptionTier[] = WHISPER_TRANSCRIPTION_TIERS,
): boolean {
  return isWellFormedTierSet(tiers);
}
