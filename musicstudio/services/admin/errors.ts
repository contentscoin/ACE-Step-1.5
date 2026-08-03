/**
 * The Admin_Console's rejections.
 *
 * The operator gate is **403, not 404**. Hiding the console's existence from a non-operator
 * would be the usual argument for 404, and it does not apply: an authenticated user knows the
 * product has an admin console, so a 404 buys nothing and costs the caller a clear answer.
 */

import { GenerationError } from '../generation/errors';
import type { QualityThresholdName } from '../../domain/quality/threshold-name';

/** Requirement 34.9 — reading *and* changing are operator-only. */
export function operatorRoleRequired(action: string): GenerationError {
  return new GenerationError(
    403,
    'operator_role_required',
    'This action is available to operators only.',
    { action },
  );
}

/** Requirement 34.5 — the refusal carries the permitted range, and the value is unchanged. */
export function thresholdOutOfRange(details: {
  readonly name: QualityThresholdName;
  readonly requested: number;
  readonly adjustableFrom: number;
  readonly adjustableTo: number;
}): GenerationError {
  return new GenerationError(
    422,
    'quality_threshold_out_of_range',
    'The requested value is outside this threshold’s adjustable range.',
    details,
  );
}

export function adminJobNotFound(jobId: string): GenerationError {
  return new GenerationError(404, 'admin_job_not_found', 'No such Generation_Job.', { jobId });
}
