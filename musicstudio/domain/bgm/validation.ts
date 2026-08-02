/**
 * Background-music request validation (Requirements 21.2, 21.3, 21.5, 21.9, 21.12).
 *
 * Pure and total, like `domain/song/validation.ts`, and reporting *every* violated
 * field rather than the first — Requirement 21.3 names two fields that can each be
 * out of range in one request, and a caller told about one at a time makes two round
 * trips to learn what it could have sent.
 *
 * The violation type is Requirement 3/4's `SongFieldViolation`, not a new one. 21.3
 * asks for the field name and its permitted minimum and maximum; that is exactly
 * what a `range` or `length` allowance already carries, and a second violation
 * vocabulary would mean two renderings of the same rejection in the same API.
 */

import { isSongTimeSignature } from '../song/engine-bounds';
import { isKeyScale, VALID_KEY_SCALES } from '../song/key-scale';
import {
  enumViolation,
  lengthViolation,
  rangeViolation,
  type SongFieldViolation,
} from '../song/violation';

import {
  BGM_INTENSITY_GAP_MAX_LUFS,
  BGM_INTENSITY_GAP_MIN_LUFS,
  BGM_INTENSITY_VARIANT_COUNT_MAX,
  BGM_INTENSITY_VARIANT_COUNT_MIN,
  BGM_SCENE_DESCRIPTION_MAX_LENGTH,
  BGM_SCENE_DESCRIPTION_MIN_LENGTH,
  BGM_TARGET_LENGTH_SECONDS_MAX,
  BGM_TARGET_LENGTH_SECONDS_MIN,
  isBgmSceneDescription,
  isBgmTargetLengthSeconds,
  isBgmVariantCount,
} from './bounds';
import {
  BGM_BASE_LOUDNESS_LUFS,
  bgmCaption,
  type BgmGenerationRequest,
  type BgmIntensityVariantParameters,
  type BgmIntensityVariantRequest,
  type BgmParameters,
} from './request';

export type BgmValidation =
  | { readonly kind: 'valid'; readonly parameters: BgmParameters }
  | { readonly kind: 'invalid'; readonly violations: readonly SongFieldViolation[] };

export type BgmVariantValidation =
  | { readonly kind: 'valid'; readonly parameters: BgmIntensityVariantParameters }
  | { readonly kind: 'invalid'; readonly violations: readonly SongFieldViolation[] };

export function validateBgmRequest(request: BgmGenerationRequest): BgmValidation {
  const violations = collectViolations(request);
  if (violations.length > 0) return { kind: 'invalid', violations };
  return { kind: 'valid', parameters: resolve(request) };
}

/** Requirement 21.9 on top of everything Requirement 21.2/21.5 already check. */
export function validateBgmVariantRequest(
  request: BgmIntensityVariantRequest,
): BgmVariantValidation {
  const violations = [...collectViolations(request)];

  if (!isBgmVariantCount(request.variantCount)) {
    violations.push(
      rangeViolation(
        'variantCount',
        request.variantCount,
        BGM_INTENSITY_VARIANT_COUNT_MIN,
        BGM_INTENSITY_VARIANT_COUNT_MAX,
      ),
    );
  }

  const gap = request.intensityGapLufs;
  if (
    gap !== undefined &&
    (!Number.isFinite(gap) || gap < BGM_INTENSITY_GAP_MIN_LUFS || gap > BGM_INTENSITY_GAP_MAX_LUFS)
  ) {
    violations.push(
      rangeViolation(
        'intensityGapLufs',
        gap,
        BGM_INTENSITY_GAP_MIN_LUFS,
        BGM_INTENSITY_GAP_MAX_LUFS,
        false,
      ),
    );
  }

  if (violations.length > 0) return { kind: 'invalid', violations };

  return {
    kind: 'valid',
    parameters: {
      cue: resolve(request),
      variantCount: request.variantCount,
      // Requirement 21.11 gives a window and no default. The midpoint is audibly a
      // step without being a jump, and it keeps a four-step ladder inside 11 LUFS.
      intensityGapLufs:
        gap ?? (BGM_INTENSITY_GAP_MIN_LUFS + BGM_INTENSITY_GAP_MAX_LUFS) / 2,
      baseLoudnessLufs: request.baseLoudnessLufs ?? BGM_BASE_LOUDNESS_LUFS,
    },
  };
}

function collectViolations(request: BgmGenerationRequest): readonly SongFieldViolation[] {
  const violations: SongFieldViolation[] = [];

  // Requirement 21.5, reported with its permitted length window (21.3).
  if (!isBgmSceneDescription(request.sceneDescription)) {
    violations.push(
      lengthViolation(
        'sceneDescription',
        typeof request.sceneDescription === 'string' ? request.sceneDescription.length : undefined,
        BGM_SCENE_DESCRIPTION_MIN_LENGTH,
        BGM_SCENE_DESCRIPTION_MAX_LENGTH,
      ),
    );
  }

  // Requirement 21.2, reported with its permitted range (21.3).
  if (!isBgmTargetLengthSeconds(request.targetLengthSeconds)) {
    violations.push(
      rangeViolation(
        'targetLengthSeconds',
        request.targetLengthSeconds,
        BGM_TARGET_LENGTH_SECONDS_MIN,
        BGM_TARGET_LENGTH_SECONDS_MAX,
        false,
      ),
    );
  }

  // Musical metadata is checked against Requirement 4's bounds, because it reaches
  // the same engine fields. Only what the caller supplied is checked; an omitted
  // value stays omitted so the engine fills it (Requirement 4.7).
  const keyScale = request.reference?.keyScale ?? request.keyScale;
  if (keyScale !== undefined && !isKeyScale(keyScale)) {
    violations.push(enumViolation('keyScale', keyScale, VALID_KEY_SCALES));
  }
  if (request.timeSignature !== undefined && !isSongTimeSignature(request.timeSignature)) {
    violations.push(enumViolation('timeSignature', request.timeSignature, [2, 3, 4, 6]));
  }

  const bpm = request.reference?.bpm ?? request.bpm;
  if (bpm !== undefined && (!Number.isInteger(bpm) || bpm < 30 || bpm > 300)) {
    violations.push(rangeViolation('bpm', bpm, 30, 300));
  }

  if (request.seed !== undefined && (!Number.isInteger(request.seed) || request.seed < 0)) {
    violations.push(rangeViolation('seed', request.seed, 0, Number.MAX_SAFE_INTEGER));
  }

  return violations;
}

/**
 * The validated form.
 *
 * Requirement 21.12 is applied here and only here: a reference asset's BPM and key
 * *replace* whatever the caller also sent, rather than being merged or preferred at
 * submission time. Doing it in one place is what makes Requirement 21.13's "±1 BPM of
 * the reference, key identical" checkable against a single recorded value.
 */
function resolve(request: BgmGenerationRequest): BgmParameters {
  const reference = request.reference;
  const bpm = reference?.bpm ?? request.bpm;
  const keyScale = reference?.keyScale ?? request.keyScale;

  return {
    sceneDescription: request.sceneDescription,
    caption: bgmCaption(request),
    targetLengthSeconds: request.targetLengthSeconds,
    loop: request.loop ?? false,
    instrumental: true,
    lyricsMetadata: '',
    ...(bpm === undefined ? {} : { bpm }),
    ...(keyScale === undefined ? {} : { keyScale }),
    ...(isSongTimeSignature(request.timeSignature) ? { timeSignature: request.timeSignature } : {}),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(reference === undefined ? {} : { referenceAssetId: reference.assetId }),
  };
}
