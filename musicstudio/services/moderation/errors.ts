/**
 * Moderation_Service failure vocabulary.
 *
 * Structurally identical to `services/account/errors.ts` and
 * `adapters/registry/errors.ts` (status code, machine-readable `code`, detail bag),
 * so the single gateway error contract in `api/gateway/error-handler.ts` renders it
 * without a second code path.
 *
 * Every refusal is 403: the request was understood and is being refused on policy
 * grounds. The status alone is not the message — clients branch on `code`, which is
 * what the error contract already asks of them.
 *
 * - 16.2 / 16.11 policy violation  -> 403 `content_policy_violation` + classifications
 * - 16.4 / 16.14 missing consent   -> 403 `rights_consent_required` + the uploads
 * - 16.12 no Voice_Consent_Record  -> 403 `voice_consent_missing`
 * - 16.8 report on a non-public asset -> 404 `asset_not_found` (existence is not leaked)
 */

import type { BlockedModeration, ModerationBlock } from './decision';

export type ModerationErrorCode =
  | 'content_policy_violation'
  | 'rights_consent_required'
  | 'voice_consent_missing'
  | 'asset_not_found'
  | 'review_not_open';

export type ModerationErrorDetails = Readonly<Record<string, unknown>>;

export class ModerationError extends Error {
  readonly statusCode: number;
  readonly code: ModerationErrorCode;
  readonly details: ModerationErrorDetails;

  constructor(
    statusCode: number,
    code: ModerationErrorCode,
    message: string,
    details: ModerationErrorDetails = {},
  ) {
    super(message);
    this.name = 'ModerationError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isModerationError(value: unknown): value is ModerationError {
  return value instanceof ModerationError;
}

/**
 * Render a blocked decision as the transport error.
 *
 * The `code` comes from the first block, but every block travels in `details.blocks`
 * so a caller fixing a request sees all of them at once. `violationClasses` is
 * hoisted to the top level because that is the field Requirements 16.2 and 16.11
 * name.
 */
export function blockedByModeration(decision: BlockedModeration): ModerationError {
  const primary = decision.blocks[0];
  return new ModerationError(403, codeOf(primary), messageOf(primary), {
    blocks: decision.blocks,
    violationClasses: decision.violationClasses,
    // Requirements 16.2 and 16.11: stated in the payload, not merely implied by
    // the absence of a charge, so a client can show it without guessing.
    creditsCharged: 0,
  });
}

function codeOf(block: ModerationBlock | undefined): ModerationErrorCode {
  switch (block?.code) {
    case 'rights_consent_required':
      return 'rights_consent_required';
    case 'voice_consent_missing':
      return 'voice_consent_missing';
    default:
      return 'content_policy_violation';
  }
}

function messageOf(block: ModerationBlock | undefined): string {
  switch (block?.code) {
    case 'rights_consent_required':
      return 'The uploader must confirm they hold the rights to every uploaded file.';
    case 'voice_consent_missing':
      return 'No Voice_Consent_Record exists for the requested voice profile.';
    default:
      return 'The submitted text violates the content policy.';
  }
}

/** Requirement 16.8 — a report only applies to a publicly visible asset. */
export function reportTargetNotFound(assetId: string): ModerationError {
  return new ModerationError(404, 'asset_not_found', 'No public asset with that id exists.', {
    assetId,
  });
}

export function reviewNotOpen(assetId: string, reviewState: string): ModerationError {
  return new ModerationError(409, 'review_not_open', 'The asset has no open review to resolve.', {
    assetId,
    reviewState,
  });
}
