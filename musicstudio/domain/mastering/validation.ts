/**
 * Mastering request validation (Requirements 30.5, 30.13, 30.14, 30.15, 30.26).
 *
 * Pure and total, reporting **every** violated parameter rather than the first. That is
 * not a style choice: Requirement 30.26 names four parameters that can each be out of
 * range in one ducking request and asks for "위반된 파라미터 이름과 해당 허용 범위" —
 * plural. A caller told about one at a time makes four round trips to learn what it could
 * have sent.
 *
 * The violation type is Requirement 3/4's `SongFieldViolation`, reused rather than
 * reinvented, for the reason `domain/sfx/validation.ts` states: 30.26 asks for the
 * parameter name and its permitted range, which is exactly what a `range` allowance
 * carries. There is no mastering-specific payload because 30.26 asks for nothing a range
 * cannot hold.
 *
 * ### The 0.1 LUFS step is a validation rule, not a rounding
 *
 * Requirement 30.5 permits "-30.0LUFS 이상 -6.0LUFS 이하 범위에서 0.1LUFS 단위 값". A
 * request for −14.05 is refused rather than snapped to −14.0 or −14.1, because snapping
 * would make the value the user asked for and the value recorded on the resulting version
 * differ with nothing in the response saying so. The refusal reports the range; the step
 * is part of the same allowance, reported as a non-integer range whose `min`/`max` are the
 * clause's bounds.
 *
 * **Spec note.** 30.26 names 30.5 as a source of refusals and 30.5 states both the range
 * and the step, so an off-step value is a 30.26 refusal. The clause does not say so in as
 * many words — it says "허용 범위를 벗어나면" — and a step violation is arguably not a
 * range violation. The stricter reading is taken because the alternative is to accept a
 * value 30.5 does not permit.
 */

import {
  DUCKING_ATTACK_DEFAULT_MS,
  DUCKING_ATTACK_MS,
  DUCKING_DEPTH_DB,
  DUCKING_DEPTH_DEFAULT_DB,
  DUCKING_RELEASE_DEFAULT_MS,
  DUCKING_RELEASE_MS,
  LOUDNESS_TARGET_DEFAULT_LUFS,
  LOUDNESS_TARGET_LUFS,
  isOnLoudnessTargetStep,
  isWithin,
  type MasteringRange,
} from './bounds';
import type {
  DuckingDefaultableField,
  DuckingParameters,
  DuckingRequest,
  LoudnessDefaultableField,
  LoudnessNormalizationParameters,
  LoudnessNormalizationRequest,
} from './request';

import { rangeViolation, type SongFieldViolation } from '../song/violation';

function rangeOf(
  field: string,
  received: unknown,
  range: MasteringRange,
  integer: boolean,
): SongFieldViolation {
  return rangeViolation(field, received, range.min, range.max, integer);
}

/** Requirements 30.5, 30.26 — the loudness target, and only it. */
export function loudnessRequestViolations(
  request: LoudnessNormalizationRequest,
): readonly SongFieldViolation[] {
  const { targetLufs } = request;
  if (targetLufs === undefined) return [];
  if (!isWithin(LOUDNESS_TARGET_LUFS, targetLufs) || !isOnLoudnessTargetStep(targetLufs)) {
    return [rangeOf('targetLufs', targetLufs, LOUDNESS_TARGET_LUFS, false)];
  }
  return [];
}

/**
 * Requirements 30.13, 30.14, 30.15, 30.26 — all three shaping numbers, independently.
 *
 * Independently on purpose: an out-of-range depth does not suppress the attack check, so
 * a request with three bad values learns about three. The three ranges do not interact —
 * unlike, say, `domain/sfx/validation.ts`'s tier and step count, where the second range
 * is chosen *by* the first and judging it against a guess would be false advice.
 */
export function duckingRequestViolations(
  request: DuckingRequest,
): readonly SongFieldViolation[] {
  const violations: SongFieldViolation[] = [];

  if (request.depthDb !== undefined && !isWithin(DUCKING_DEPTH_DB, request.depthDb)) {
    violations.push(rangeOf('depthDb', request.depthDb, DUCKING_DEPTH_DB, false));
  }
  if (request.attackMs !== undefined && !isWithin(DUCKING_ATTACK_MS, request.attackMs)) {
    violations.push(rangeOf('attackMs', request.attackMs, DUCKING_ATTACK_MS, false));
  }
  if (request.releaseMs !== undefined && !isWithin(DUCKING_RELEASE_MS, request.releaseMs)) {
    violations.push(rangeOf('releaseMs', request.releaseMs, DUCKING_RELEASE_MS, false));
  }

  return violations;
}

/**
 * Requirement 30.5's default, applied only to a request that already validated.
 *
 * Total by precondition rather than by clamping: the caller runs
 * `loudnessRequestViolations` first and refuses on a non-empty list, so this never sees an
 * out-of-range value and never has to decide what to do with one. A resolver that clamped
 * would make Requirement 30.26's refusal unreachable.
 */
export function resolveLoudnessParameters(
  request: LoudnessNormalizationRequest,
): LoudnessNormalizationParameters {
  const appliedDefaults: LoudnessDefaultableField[] = [];
  let targetLufs = request.targetLufs;

  if (targetLufs === undefined) {
    targetLufs = LOUDNESS_TARGET_DEFAULT_LUFS;
    appliedDefaults.push('targetLufs');
  }

  return { targetLufs, appliedDefaults };
}

/** Requirements 30.13, 30.14, 30.15's defaults. Same precondition as above. */
export function resolveDuckingParameters(request: DuckingRequest): DuckingParameters {
  const appliedDefaults: DuckingDefaultableField[] = [];

  let depthDb = request.depthDb;
  if (depthDb === undefined) {
    depthDb = DUCKING_DEPTH_DEFAULT_DB;
    appliedDefaults.push('depthDb');
  }
  let attackMs = request.attackMs;
  if (attackMs === undefined) {
    attackMs = DUCKING_ATTACK_DEFAULT_MS;
    appliedDefaults.push('attackMs');
  }
  let releaseMs = request.releaseMs;
  if (releaseMs === undefined) {
    releaseMs = DUCKING_RELEASE_DEFAULT_MS;
    appliedDefaults.push('releaseMs');
  }

  return { depthDb, attackMs, releaseMs, appliedDefaults };
}
