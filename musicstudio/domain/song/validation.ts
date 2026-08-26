/**
 * Song request validation (Requirements 3.5, 3.7, 3.8, 4.2–4.6, 4.8, 4.10).
 *
 * Pure and total: one request in, either the resolved `SongParameters` or the
 * complete list of violations out. Nothing here throws and nothing reaches for the
 * network, so the whole of Requirements 3 and 4's rejection surface is testable
 * without a gateway, an orchestrator or an engine.
 *
 * Two behaviours are deliberate and load-bearing:
 *
 * - **Every** violated field is reported, not just the first. Requirement 4.6 names
 *   four fields that can each be out of range, and a caller fixing them one round
 *   trip at a time is a worse product than one told everything at once.
 * - An omitted field is never defaulted. Requirements 3.3 and 4.7 make emptiness
 *   the instruction "engine, decide this", so a default here would silently
 *   overrule the user's choice to not choose.
 */

import {
  SONG_BATCH_SIZE_MAX,
  SONG_BATCH_SIZE_MIN,
  SONG_BPM_MAX,
  SONG_BPM_MIN,
  SONG_CAPTION_MAX_LENGTH,
  SONG_CAPTION_MIN_LENGTH,
  SONG_DESCRIPTION_MAX_LENGTH,
  SONG_DESCRIPTION_MIN_LENGTH,
  SONG_DURATION_SECONDS_MAX,
  SONG_DURATION_SECONDS_MIN,
  SONG_TIME_SIGNATURES,
  isSongBatchSize,
  isSongBpm,
  isSongTimeSignature,
} from './engine-bounds';
import { VALID_KEY_SCALES, isKeyScale } from './key-scale';
import {
  INSTRUMENTAL_LYRICS,
  type SongGenerationRequest,
  type SongParameters,
} from './request';
import { ACCEPTED_VOCAL_LANGUAGES, isVocalLanguage } from './vocal-language';
import {
  enumViolation,
  lengthViolation,
  rangeViolation,
  type SongFieldViolation,
} from './violation';

export type SongValidation =
  | { readonly kind: 'valid'; readonly parameters: SongParameters }
  | { readonly kind: 'invalid'; readonly violations: readonly SongFieldViolation[] };

/**
 * The one bound that is not the same for every Asset_Kind.
 *
 * Requirement 4.2 gives a song 10–600 seconds; Requirement 21.2 gives background music
 * 5–600. Every other bound in this module is a property of the engine's parameter space
 * and is identical whatever is being generated, so this is the only one taken as an
 * argument. Passing it in rather than branching on Asset_Kind keeps this module free of
 * any knowledge of what the request is *for*.
 */
export interface SongDurationBounds {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/** Requirement 4.2. */
export const SONG_DURATION_BOUNDS: SongDurationBounds = {
  minSeconds: SONG_DURATION_SECONDS_MIN,
  maxSeconds: SONG_DURATION_SECONDS_MAX,
};

export function validateSongRequest(
  request: SongGenerationRequest,
  durationBounds: SongDurationBounds = SONG_DURATION_BOUNDS,
): SongValidation {
  const violations: SongFieldViolation[] = [
    ...validateShared(request, durationBounds),
    ...(request.mode === 'simple' ? validateSimple(request) : validateCustom(request)),
  ];

  if (violations.length > 0) return { kind: 'invalid', violations };
  return { kind: 'valid', parameters: resolve(request) };
}

/** Fields both modes share: length, language, batch size, seed. */
function validateShared(
  request: SongGenerationRequest,
  durationBounds: SongDurationBounds,
): readonly SongFieldViolation[] {
  const violations: SongFieldViolation[] = [];

  // Requirement 4.2. Applies to Simple_Mode too: a length the caller *did* give is
  // held to the same bound whichever mode asked for it.
  if (
    request.durationSeconds !== undefined &&
    !isWithinDurationBounds(request.durationSeconds, durationBounds)
  ) {
    violations.push(
      rangeViolation(
        'durationSeconds',
        request.durationSeconds,
        durationBounds.minSeconds,
        durationBounds.maxSeconds,
        false,
      ),
    );
  }

  // Requirement 3.8: the rejection carries the full supported list.
  if (request.vocalLanguage !== undefined && !isVocalLanguage(request.vocalLanguage)) {
    violations.push(
      enumViolation('vocalLanguage', request.vocalLanguage, ACCEPTED_VOCAL_LANGUAGES),
    );
  }

  // Requirement 4.8.
  if (request.batchSize !== undefined && !isSongBatchSize(request.batchSize)) {
    violations.push(
      rangeViolation('batchSize', request.batchSize, SONG_BATCH_SIZE_MIN, SONG_BATCH_SIZE_MAX),
    );
  }

  // Requirement 4.10 needs the seed to survive a round trip through the engine
  // unchanged, which a non-integer or negative value would not.
  if (request.seed !== undefined && (!Number.isInteger(request.seed) || request.seed < 0)) {
    violations.push(rangeViolation('seed', request.seed, 0, Number.MAX_SAFE_INTEGER));
  }

  return violations;
}

function isWithinDurationBounds(value: number, bounds: SongDurationBounds): boolean {
  return Number.isFinite(value) && value >= bounds.minSeconds && value <= bounds.maxSeconds;
}

/** Requirement 3.5: a supplied description is 1–2000 characters. */
function validateSimple(
  request: Extract<SongGenerationRequest, { mode: 'simple' }>,
): readonly SongFieldViolation[] {
  const { description } = request;
  if (description === undefined) return [];

  if (
    description.length < SONG_DESCRIPTION_MIN_LENGTH ||
    description.length > SONG_DESCRIPTION_MAX_LENGTH
  ) {
    return [
      lengthViolation(
        'description',
        description.length,
        SONG_DESCRIPTION_MIN_LENGTH,
        SONG_DESCRIPTION_MAX_LENGTH,
      ),
    ];
  }
  return [];
}

/** Requirements 4.3, 4.4, 4.5 — each checked only when the caller supplied it (4.7). */
function validateCustom(
  request: Extract<SongGenerationRequest, { mode: 'custom' }>,
): readonly SongFieldViolation[] {
  const violations: SongFieldViolation[] = [];

  // Not a numbered requirement — the engine's own bound, which nothing in the product enforced.
  // Above 512 the engine tokenises with truncation and generates from the remainder, so the whole
  // failure was invisible: the request succeeded and the music quietly answered half the caption.
  // See `SONG_CAPTION_MAX_LENGTH`.
  if (
    request.caption !== undefined &&
    (request.caption.length < SONG_CAPTION_MIN_LENGTH ||
      request.caption.length > SONG_CAPTION_MAX_LENGTH)
  ) {
    violations.push(
      lengthViolation(
        'caption',
        request.caption.length,
        SONG_CAPTION_MIN_LENGTH,
        SONG_CAPTION_MAX_LENGTH,
      ),
    );
  }

  if (request.bpm !== undefined && !isSongBpm(request.bpm)) {
    violations.push(rangeViolation('bpm', request.bpm, SONG_BPM_MIN, SONG_BPM_MAX));
  }
  if (request.timeSignature !== undefined && !isSongTimeSignature(request.timeSignature)) {
    violations.push(enumViolation('timeSignature', request.timeSignature, SONG_TIME_SIGNATURES));
  }
  if (request.keyScale !== undefined && !isKeyScale(request.keyScale)) {
    violations.push(enumViolation('keyScale', request.keyScale, VALID_KEY_SCALES));
  }

  return violations;
}

/**
 * The validated form.
 *
 * Only three values are decided here, and each is a requirement rather than a
 * convenience: `thinking` defaults to true (3.2), `sampleMode` follows the mode
 * (3.1), and `batchSize` resolves to 1 (4.8). Everything else is copied through or
 * left absent.
 *
 * The `x === undefined ? {} : { x }` spreads are not stylistic: under
 * `exactOptionalPropertyTypes` an absent property differs from one set to
 * `undefined`, and that difference is precisely what Requirements 3.3 and 4.7 rest
 * on, so the absent case has to produce no property at all.
 */
function resolve(request: SongGenerationRequest): SongParameters {
  if (request.mode === 'simple') {
    return {
      mode: 'simple',
      sampleMode: true,
      instrumental: false,
      thinking: request.thinking ?? true,
      batchSize: request.batchSize ?? 1,
      ...sharedOptionals(request),
      ...(request.description === undefined ? {} : { description: request.description }),
    };
  }

  const instrumental = request.instrumental ?? false;
  // Requirement 4.9: the indicator replaces the lyrics, because that field *is*
  // how the engine is told the track carries no vocal.
  const lyrics = instrumental ? INSTRUMENTAL_LYRICS : request.lyrics;

  return {
    mode: 'custom',
    sampleMode: false,
    instrumental,
    thinking: request.thinking ?? true,
    batchSize: request.batchSize ?? 1,
    ...sharedOptionals(request),
    ...(request.caption === undefined ? {} : { caption: request.caption }),
    ...(lyrics === undefined ? {} : { lyrics }),
    ...(request.bpm === undefined ? {} : { bpm: request.bpm }),
    ...(request.keyScale === undefined ? {} : { keyScale: request.keyScale }),
    // Validation has already accepted the value, so the guard is what narrows it
    // to `SongTimeSignature` without a cast.
    ...(isSongTimeSignature(request.timeSignature) ? { timeSignature: request.timeSignature } : {}),
  };
}

type SharedOptionals = Pick<SongParameters, 'durationSeconds' | 'vocalLanguage' | 'seed'>;

function sharedOptionals(request: SongGenerationRequest): Partial<SharedOptionals> {
  return {
    ...(request.durationSeconds === undefined ? {} : { durationSeconds: request.durationSeconds }),
    ...(request.vocalLanguage === undefined ? {} : { vocalLanguage: request.vocalLanguage }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
  };
}
