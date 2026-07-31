/**
 * The result of a content policy inspection (design §9.1).
 *
 * §9.1 has exactly two outcomes: **차단** with a classification, or **승인** after
 * which the gateway forwards the request to the engine. This module is that pair,
 * as a discriminated union, so a caller cannot forward an approved-shaped value it
 * never checked.
 *
 * The blocked branch carries no credit information, and neither does the approved
 * branch: Requirements 16.2 and 16.11 keep the balance unchanged, and the way that
 * is guaranteed here is that Moderation_Service has no credit port at all. See
 * `generation-gate.ts` for the ordering that makes the guarantee structural.
 */

import type { ModerationField } from '../../domain/moderation/fields';
import type { ArtistSubstitution } from '../../domain/moderation/artist-substitution';
import type { UploadDeclaration } from '../../domain/moderation/upload-consent';
import type { PolicyViolationClass } from '../../domain/moderation/violation-class';

import type { PolicyViolation } from './policy-classifier';

/** One inspected field, before and after Requirement 16.3 substitution. */
export interface InspectedText {
  readonly field: ModerationField;
  readonly original: string;
  /** What the engine should receive. Equal to `original` when nothing changed. */
  readonly sanitized: string;
}

/** Requirement 16.3 — the substitution the user has to be told about. */
export interface SubstitutionNotice extends ArtistSubstitution {
  readonly field: ModerationField;
}

/** Requirement 16.2 / 16.11. */
export interface PolicyViolationBlock {
  readonly code: 'policy_violation';
  readonly violations: readonly PolicyViolation[];
}

/** Requirements 16.4 / 16.14. */
export interface RightsConsentBlock {
  readonly code: 'rights_consent_required';
  readonly uploads: readonly { readonly uploadId: string; readonly purpose: string }[];
}

/** Requirement 16.12 — the record itself belongs to task 6.2. */
export interface VoiceConsentBlock {
  readonly code: 'voice_consent_missing';
  readonly voiceProfileId: string;
}

export type ModerationBlock = PolicyViolationBlock | RightsConsentBlock | VoiceConsentBlock;

export interface ApprovedModeration {
  readonly outcome: 'approved';
  readonly texts: readonly InspectedText[];
  /** Empty unless Requirement 16.3 rewrote something. */
  readonly notices: readonly SubstitutionNotice[];
}

export interface BlockedModeration {
  readonly outcome: 'blocked';
  /** Every reason found, not just the first, so one round trip fixes them all. */
  readonly blocks: readonly ModerationBlock[];
  /**
   * The classifications, flattened and de-duplicated. Requirements 16.2 and 16.11
   * ask for "the violation classification", and a caller should not have to walk
   * the block union to find it.
   */
  readonly violationClasses: readonly PolicyViolationClass[];
  readonly texts: readonly InspectedText[];
}

export type ModerationDecision = ApprovedModeration | BlockedModeration;

export function isApproved(decision: ModerationDecision): decision is ApprovedModeration {
  return decision.outcome === 'approved';
}

export function violationClassesOf(
  blocks: readonly ModerationBlock[],
): readonly PolicyViolationClass[] {
  const classes = new Set<PolicyViolationClass>();
  for (const block of blocks) {
    if (block.code !== 'policy_violation') continue;
    for (const violation of block.violations) classes.add(violation.violationClass);
  }
  return [...classes].sort((left, right) => left.localeCompare(right, 'en'));
}

export function rightsConsentBlockFor(
  uploads: readonly UploadDeclaration[],
): RightsConsentBlock {
  return {
    code: 'rights_consent_required',
    uploads: uploads.map((upload) => ({ uploadId: upload.uploadId, purpose: upload.purpose })),
  };
}
