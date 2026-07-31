/**
 * Cover strength (Requirement 7.2).
 *
 * 0.0 to 1.0 inclusive, which is also the engine's own domain for
 * `audio_cover_strength` — it is a blend weight, where the engine's
 * `GenerateMusicRequest` default of 1.0 means "follow the source audio closest".
 * The bound is restated here rather than imported because the engine is reached only
 * over HTTP (design §1.4.4).
 *
 * Both endpoints are accepted. 0.0 is a meaningful request (ignore the source
 * entirely) rather than a degenerate one, so an exclusive bound would refuse a legal
 * value.
 */

import { editRangeViolation, type EditFieldViolation } from './violation';

export const COVER_STRENGTH_MIN = 0;
export const COVER_STRENGTH_MAX = 1;

export function isCoverStrength(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= COVER_STRENGTH_MIN &&
    value <= COVER_STRENGTH_MAX
  );
}

/** Returns the violation Requirement 7.2 needs, or `undefined` when accepted. */
export function coverStrengthViolation(value: number): EditFieldViolation | undefined {
  if (isCoverStrength(value)) return undefined;
  return editRangeViolation('coverStrength', value, COVER_STRENGTH_MIN, COVER_STRENGTH_MAX);
}
