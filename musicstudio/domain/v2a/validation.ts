/**
 * Upload validation for foley generation (Requirements 23.2, 23.3, 23.4).
 *
 * Pure, total, and a function of a *probed metadata record* rather than of a file — see
 * `video-metadata.ts` for why. Nothing here opens anything.
 *
 * Every violated constraint is reported, not the first, for the reason
 * `domain/sfx/validation.ts` gives: Requirement 23.4 says "23.2 또는 23.3의 검증 항목 중
 * **하나 이상**" and then asks for "위반된 제약 이름, 측정값, 허용 범위" — plural
 * constraints in one answer. A user whose phone recorded a 90-second 4K clip has broken
 * two limits and deserves to learn both before re-encoding.
 *
 * The violation type is Requirement 3/4's `SongFieldViolation`, not a new one, because
 * what 23.4 asks for — constraint name, measured value, permitted range — is exactly what
 * a `range` or `enum` allowance already carries. A parallel vocabulary would give the API
 * two spellings of the same rejection.
 *
 * **The "해당 업로드 파일을 저장하지 않는다" half of 23.4 is not here**, and cannot be: it
 * is an effect, and this is a predicate. `services/sound/v2a-service.ts` discards the
 * staged upload through `V2aUploadPort.discard` on every rejection path, which is where
 * an effect belongs and where a test can observe it.
 */

import { enumViolation, rangeViolation, type SongFieldViolation } from '../song/violation';

import {
  V2A_CONTAINERS,
  V2A_DURATION_MS_MAX,
  V2A_DURATION_MS_MIN,
  V2A_FILE_SIZE_BYTES_MAX,
  V2A_FRAME_RATE_MAX,
  V2A_FRAME_RATE_MIN,
  V2A_SHORT_SIDE_MIN_PX,
  V2A_VARIANT_COUNT_MAX,
  V2A_VARIANT_COUNT_MIN,
  V2A_VIDEO_STREAM_COUNT_MIN,
  isV2aContainer,
  isV2aVariantCount,
} from './bounds';
import { shortSidePx, type ProbedVideoMetadata } from './video-metadata';

/**
 * The constraint names Requirement 23.4 reports, as a closed list.
 *
 * Machine-readable identifiers because they cross the API boundary as 23.4's "위반된 제약
 * 이름", and a closed list because a client that branches on them cannot do so safely
 * against prose. They double as the `field` of each violation, so the name a caller sees
 * in the violation list and the name they see in the summary are the same string.
 */
export const V2A_UPLOAD_CONSTRAINTS = [
  'container',
  'videoStreamCount',
  'frameRate',
  'shortSidePx',
  'durationMs',
  'fileSizeBytes',
] as const;

export type V2aUploadConstraint = (typeof V2A_UPLOAD_CONSTRAINTS)[number];

/** Which requirement clause each constraint comes from, for the rejection payload. */
export const V2A_UPLOAD_CONSTRAINT_REQUIREMENT: Readonly<Record<V2aUploadConstraint, string>> = {
  container: '23.2',
  videoStreamCount: '23.2',
  frameRate: '23.2',
  shortSidePx: '23.2',
  durationMs: '23.3',
  fileSizeBytes: '23.3',
};

export type V2aUploadValidation =
  | { readonly kind: 'valid'; readonly metadata: ProbedVideoMetadata }
  | {
      readonly kind: 'invalid';
      readonly violations: readonly SongFieldViolation[];
      /** The same failures as constraint names, in the order 23.2 then 23.3 lists them. */
      readonly constraints: readonly V2aUploadConstraint[];
    };

/**
 * Requirements 23.2 and 23.3 over one probed record.
 *
 * Checks are ordered as the requirements list them — container, stream count, frame rate,
 * resolution (23.2), then duration and size (23.3) — so the reported order is stable and a
 * client can render it without sorting.
 *
 * Non-finite measurements are violations rather than exceptions. A probe that reports
 * `NaN` for a frame rate has told us the file is unusable, which is the same conclusion as
 * a rate of 4, and throwing would turn a bad upload into a server error.
 */
export function validateV2aUpload(metadata: ProbedVideoMetadata): V2aUploadValidation {
  const violations: SongFieldViolation[] = [];
  const constraints: V2aUploadConstraint[] = [];

  const fail = (constraint: V2aUploadConstraint, violation: SongFieldViolation): void => {
    constraints.push(constraint);
    violations.push(violation);
  };

  // Requirement 23.2 — container.
  if (!isV2aContainer(metadata.container)) {
    fail('container', enumViolation('container', metadata.container, V2A_CONTAINERS));
  }

  // Requirement 23.2 — at least one video stream. An audio-only file in an mp4 container
  // is a legal mp4 and an illegal foley input, which is why this is checked separately
  // from the container.
  if (
    !Number.isInteger(metadata.videoStreamCount) ||
    metadata.videoStreamCount < V2A_VIDEO_STREAM_COUNT_MIN
  ) {
    fail(
      'videoStreamCount',
      rangeViolation(
        'videoStreamCount',
        metadata.videoStreamCount,
        V2A_VIDEO_STREAM_COUNT_MIN,
        Number.MAX_SAFE_INTEGER,
      ),
    );
  }

  // Requirement 23.2 — frame rate. Fractional rates are legal (23.976, 29.97), so this is
  // a real-valued range rather than an integer one.
  if (!isInClosedRange(metadata.frameRate, V2A_FRAME_RATE_MIN, V2A_FRAME_RATE_MAX)) {
    fail(
      'frameRate',
      rangeViolation('frameRate', metadata.frameRate, V2A_FRAME_RATE_MIN, V2A_FRAME_RATE_MAX, false),
    );
  }

  // Requirement 23.2 — the short side. Reported against the measured short side rather
  // than against width or height, because that is the quantity the requirement bounds and
  // a portrait clip must not be judged by its height.
  const shortSide = shortSidePx(metadata);
  if (!isInClosedRange(shortSide, V2A_SHORT_SIDE_MIN_PX, Number.MAX_SAFE_INTEGER)) {
    fail(
      'shortSidePx',
      rangeViolation('shortSidePx', shortSide, V2A_SHORT_SIDE_MIN_PX, Number.MAX_SAFE_INTEGER),
    );
  }

  // Requirement 23.3 — duration.
  if (!isInClosedRange(metadata.durationMs, V2A_DURATION_MS_MIN, V2A_DURATION_MS_MAX)) {
    fail(
      'durationMs',
      rangeViolation(
        'durationMs',
        metadata.durationMs,
        V2A_DURATION_MS_MIN,
        V2A_DURATION_MS_MAX,
        false,
      ),
    );
  }

  // Requirement 23.3 — file size.
  if (!isInClosedRange(metadata.fileSizeBytes, 0, V2A_FILE_SIZE_BYTES_MAX)) {
    fail(
      'fileSizeBytes',
      rangeViolation('fileSizeBytes', metadata.fileSizeBytes, 0, V2A_FILE_SIZE_BYTES_MAX),
    );
  }

  if (violations.length > 0) return { kind: 'invalid', violations, constraints };
  return { kind: 'valid', metadata };
}

function isInClosedRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Requirement 23.1's variant count, validated before anything is probed or charged.
 *
 * 23.1 says a foley Generation_Job produces "1개 이상 4개 이하" assets, and a request naming
 * nine is a request the service cannot satisfy. Requirement 23 has no clause of its own for
 * this rejection — unlike Requirement 22.18, which spells out the corresponding SFX refusal —
 * so the shape is borrowed from 22.18: the violated constraint, the input value and the
 * permitted range, with nothing charged.
 *
 * **Reported as a spec gap**, not invented behaviour: the cap is 23.1's and only the *form* of
 * the refusal is chosen here. Accepting a count of nine and silently producing four would
 * break 23.1 as surely as producing nine would, and doing it silently is worse.
 *
 * Separate from `validateV2aUpload` because it is a property of the *request*, not of the file:
 * a request with a bad count must be refused without probing anything, which is the ordering
 * `V2aService.generate` relies on.
 */
export type V2aRequestValidation =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid'; readonly violations: readonly SongFieldViolation[] };

export function validateV2aVariantCount(variantCount: number | undefined): V2aRequestValidation {
  if (variantCount === undefined || isV2aVariantCount(variantCount)) return { kind: 'valid' };
  return {
    kind: 'invalid',
    violations: [
      rangeViolation(
        'variantCount',
        variantCount,
        V2A_VARIANT_COUNT_MIN,
        V2A_VARIANT_COUNT_MAX,
      ),
    ],
  };
}
