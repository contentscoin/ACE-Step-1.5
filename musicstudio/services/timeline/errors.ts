/**
 * The Timeline_Service's rejections.
 *
 * All are `GenerationError`s, so `api/gateway/error-handler.ts` renders them with no new branch
 * and `details` reaches the client inside the `error` object — the contract Requirements 3.5,
 * 22.3 and 24.20 already use. The codes are declared in `services/generation/errors.ts`
 * alongside the rest of the vocabulary.
 *
 * Three of Requirement 28's clauses specify the *contents* of a rejection, and each gets a
 * function whose signature makes those contents impossible to omit:
 *
 * - **28.5** — "현재 클립 개수와 상한 500을 포함한 오류": both numbers, as data.
 * - **28.8** — "충돌한 클립 식별자와 겹침 길이": the conflicting clip and the overlap, per
 *   collision, because a move can collide with more than one clip and reporting one at a time
 *   would hide the rest.
 * - **28.11** — "허용 최대 트림 값": carried through from `planTrimClip`, which computed it.
 * - **28.38** — "이력 부재 사유 코드": the reason code is the `code`, so a client branches on it
 *   without parsing a message.
 * - **28.29** — "렌더링 대상 부재 사유 코드": the reason distinguishes an empty project from one
 *   whose clips are all excluded, and the exclusions travel with it.
 *
 * Status codes follow the distinction `sound-pack-errors.ts` draws. A malformed request is 400.
 * A well-formed request that the project's *current state* refuses — the 501st clip, a collision,
 * an empty history — is 409: nothing about the request is wrong, and the same request would
 * succeed against a different state. That matters to a client, which should retry a 409 after
 * changing the project and must not retry a 400 at all.
 */

import {
  ASSET_DURATION_MAX_MS,
  describeAudioAssetRejection,
  type AudioAssetViolation,
} from '../../domain/audio-asset';
import { MAX_PARENTS_PER_ASSET } from '../../domain/lineage/limits';
import type { ParseError } from '../../domain/parse-error';
import { PROJECT_CLIP_COUNT_MAX } from '../../domain/timeline/bounds';
import type { EditRejection } from '../../domain/timeline/commands';
import type { HistoryRejectionCode } from '../../domain/timeline/history';
import type { MixdownRefusal } from '../../domain/timeline/mixdown';
import type { ClipOverlap, TimelineViolation } from '../../domain/timeline/project';
import { GenerationError } from '../generation/errors';

function describe(violation: TimelineViolation): string {
  const where = [
    violation.index === undefined ? null : `index ${String(violation.index)}`,
    violation.field === undefined ? null : `field ${violation.field}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  const detail = violation.expected === undefined ? '' : ` (expected ${violation.expected})`;
  return where === '' ? `${violation.violation}${detail}` : `${where}: ${violation.violation}${detail}`;
}

export function timelineProjectNotFound(projectId: string): GenerationError {
  return new GenerationError(404, 'timeline_project_not_found', 'No such Timeline_Project.', {
    projectId,
  });
}

/**
 * A project owned by someone else is reported as forbidden rather than missing.
 *
 * Same reasoning as `jobForbidden`: the identifier is only obtainable from the owner's own
 * response, so revealing existence to a caller that already holds it discloses nothing, and 403
 * is the honest answer.
 */
export function timelineProjectForbidden(projectId: string): GenerationError {
  return new GenerationError(
    403,
    'timeline_project_forbidden',
    'The Timeline_Project belongs to another account.',
    { projectId },
  );
}

/** Requirements 28.1, 28.39. */
export function timelineProjectInvalid(
  violations: readonly TimelineViolation[],
): GenerationError {
  return new GenerationError(
    400,
    'timeline_project_invalid',
    violations.map(describe).join('; '),
    { violations },
  );
}

/** Requirement 28.5: the current count and the ceiling, both as data. */
export function timelineClipLimitReached(clipCount: number): GenerationError {
  return new GenerationError(
    409,
    'timeline_clip_limit_reached',
    `The project already holds ${String(clipCount)} of ${String(PROJECT_CLIP_COUNT_MAX)} clips.`,
    { clipCount, limit: PROJECT_CLIP_COUNT_MAX },
  );
}

/** Requirement 28.8: every collision, each with its clip identifiers and overlap length. */
export function timelineClipOverlap(overlaps: readonly ClipOverlap[]): GenerationError {
  const first = overlaps[0];
  return new GenerationError(
    409,
    'timeline_clip_overlap',
    first === undefined
      ? 'The clip would overlap another clip on the same track.'
      : `Clip ${first.clipId} would overlap clip ${first.otherClipId} on track ` +
        `${String(first.track)} by ${String(first.overlapMs)} ms.`,
    { overlaps },
  );
}

/** Requirements 28.2, 28.4, 28.10, 28.11, 28.14, 28.16, 28.17, 28.18. */
export function timelineEditRejected(
  violations: readonly TimelineViolation[],
): GenerationError {
  return new GenerationError(
    400,
    'timeline_edit_rejected',
    violations.map(describe).join('; '),
    { violations },
  );
}

/**
 * The single entry point from a `planX` rejection to an HTTP error.
 *
 * Routing every rejection through one function is what keeps 28.5, 28.8 and the rest from
 * being classified differently at twelve call sites — the twelve operations of 28.23 all end up
 * here, and the mapping is stated once.
 */
export function fromEditRejection(rejection: EditRejection): GenerationError {
  if (rejection.overlaps.length > 0) return timelineClipOverlap(rejection.overlaps);

  const limit = rejection.violations.find(
    (violation) => violation.violation === 'clip_count_exceeded',
  );
  if (limit !== undefined) return timelineClipLimitReached(Number(limit.actual ?? 0));

  return timelineEditRejected(rejection.violations);
}

/** Requirement 28.38: the reason code travels as the error code. */
export function timelineHistoryEmpty(reason: HistoryRejectionCode): GenerationError {
  return new GenerationError(
    409,
    'timeline_history_empty',
    reason === 'undo_history_empty'
      ? 'There is nothing to undo.'
      : 'There is nothing to redo.',
    { reason },
  );
}

/* ------------------------------------------------- Mixdown_Renderer (28.24–28.29) */

/**
 * Requirement 28.29: 렌더링 대상 부재 사유 코드.
 *
 * 409, like the other rejections that are about the project's *current state*: nothing
 * about the request is wrong, and the same request succeeds once a mute is cleared or a clip
 * is added. The reason distinguishes "the project has no clips" from "solo and mute excluded
 * all of them", and the exclusions travel too, so a client can say which track to unmute
 * rather than only that there was nothing to render.
 *
 * Requirement 28.29 also requires the project to be left unchanged. That is structural here:
 * `renderProject` throws this before it writes anything at all.
 */
export function mixdownNoRenderTarget(refusal: MixdownRefusal): GenerationError {
  return new GenerationError(
    409,
    'mixdown_no_render_target',
    refusal.reason === 'project_has_no_clips'
      ? 'The project has no clips to render.'
      : 'Every clip is excluded by a mute or by another track being soloed.',
    { reason: refusal.reason, excluded: refusal.excluded },
  );
}

/** Requirement 19.11 against Requirement 28.25's length. See the code's declaration. */
export function mixdownLengthUnsupported(lengthMs: number): GenerationError {
  return new GenerationError(
    409,
    'mixdown_length_unsupported',
    `The mixdown would be ${String(lengthMs)} ms long; an Audio_Asset may be at most ` +
      `${String(ASSET_DURATION_MAX_MS)} ms.`,
    { lengthMs, limitMs: ASSET_DURATION_MAX_MS },
  );
}

/** Requirement 19.6 against Requirement 28.5's clip ceiling. */
export function mixdownInputLimitExceeded(sourceAssetIds: readonly string[]): GenerationError {
  return new GenerationError(
    409,
    'mixdown_input_limit_exceeded',
    `The mixdown draws on ${String(sourceAssetIds.length)} distinct assets; an Audio_Asset ` +
      `may record at most ${String(MAX_PARENTS_PER_ASSET)} direct inputs.`,
    { inputCount: sourceAssetIds.length, limit: MAX_PARENTS_PER_ASSET },
  );
}

/** Which of the renderer's own invariants the render broke (Requirements 28.24–28.27, 29.31). */
export type MixdownBreach =
  /** Requirement 28.25's ±10 ms. */
  | 'length_out_of_tolerance'
  /** Requirement 28.28: the peak was not brought into [0.99, 1.0]. */
  | 'peak_not_normalised'
  /** Requirement 28.24: a mix inside the ceiling was attenuated anyway. */
  | 'attenuation_reported_without_overshoot'
  /** Requirement 28.26: the worker summed in an order other than the planned one. */
  | 'summation_order_changed'
  /** Requirement 28.27's parameter list: the produced shape is not the requested one. */
  | 'shape_changed'
  /** Requirement 29.31: a clip carrying an `Effect_Chain` was rendered without it. */
  | 'clip_effects_not_applied'
  /** Requirement 29.31: a chain was applied to a clip that does not carry one. */
  | 'clip_effects_applied_unexpectedly';

export function mixdownInvariantBreached(
  breach: MixdownBreach,
  detail: Readonly<Record<string, unknown>>,
): GenerationError {
  return new GenerationError(
    500,
    'mixdown_render_invariant_breached',
    `The mixdown renderer breached ${breach}.`,
    { breach, ...detail },
  );
}

/** The constructed `mix` asset failed Requirement 19's stored-state rules. */
export function mixdownAssetInvalid(
  violations: readonly AudioAssetViolation[],
): GenerationError {
  return new GenerationError(
    500,
    'mixdown_asset_invalid',
    `The mix Audio_Asset would violate: ${violations.join(', ')}.`,
    { ...describeAudioAssetRejection(violations) },
  );
}

/** Requirement 28.34, for a clip added against an asset that does not exist. */
export function timelineAssetNotFound(assetId: string): GenerationError {
  return new GenerationError(
    404,
    'timeline_asset_not_found',
    'No such Audio_Asset.',
    { assetId },
  );
}

/** Requirement 28.31: a document the `Project_Parser` refused, with §7.2's faults. */
export function timelineProjectDocumentInvalid(
  errors: readonly ParseError[],
): GenerationError {
  return new GenerationError(
    400,
    'timeline_project_document_invalid',
    'The JSON project document could not be parsed.',
    { errors },
  );
}
