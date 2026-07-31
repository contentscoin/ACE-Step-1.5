/**
 * Voice_Profile use permission and the share list (Requirements 26.18, 26.19, 26.20).
 *
 * 26.18 gives the owner the permission unconditionally. 26.19 lets the owner name
 * between 1 and 50 additional users. 26.20 answers 403 to anyone else.
 *
 * The owner is *not* stored in the list. Keeping them out means an owner cannot be
 * removed from their own profile by a list edit, and the 1–50 bound then measures what
 * the criterion says it measures — the users the owner shared *with*.
 *
 * Consent state is a separate question, answered by `consent-state.ts`. A user on the
 * share list still cannot generate from a withdrawn profile (26.29). Keeping the two
 * apart is what stops the share check from becoming a second, weaker copy of the
 * withdrawal rule.
 */

/** Requirement 26.19 — 1명 이상. */
export const MIN_SHARED_USERS = 1;

/** Requirement 26.19 — 50명 이하. */
export const MAX_SHARED_USERS = 50;

export interface ProfileAccess {
  readonly ownerId: string;
  /** Empty when the profile is not shared. */
  readonly sharedUserIds: readonly string[];
}

export const SHARE_LIST_VIOLATIONS = ['too_few_users', 'too_many_users', 'owner_listed'] as const;

export type ShareListViolation = (typeof SHARE_LIST_VIOLATIONS)[number];

export type ShareListValidation =
  | { readonly outcome: 'valid'; readonly sharedUserIds: readonly string[] }
  | {
      readonly outcome: 'invalid';
      readonly violation: ShareListViolation;
      readonly min: number;
      readonly max: number;
      readonly received: number;
    };

/**
 * Requirement 26.19 — validate a proposed share list.
 *
 * Duplicates are collapsed before counting, so "50 users" cannot be smuggled past the
 * bound as the same id repeated. The owner appearing in the list is rejected rather
 * than silently dropped: it almost always means the caller misunderstood 26.18, and
 * accepting it would make the stored count disagree with the count the caller sent.
 */
export function validateShareList(
  ownerId: string,
  proposed: readonly string[],
): ShareListValidation {
  const unique = [...new Set(proposed.map((id) => id.trim()).filter((id) => id.length > 0))];

  if (unique.includes(ownerId)) {
    return invalid('owner_listed', unique.length);
  }
  if (unique.length < MIN_SHARED_USERS) {
    return invalid('too_few_users', unique.length);
  }
  if (unique.length > MAX_SHARED_USERS) {
    return invalid('too_many_users', unique.length);
  }

  return { outcome: 'valid', sharedUserIds: unique };
}

/**
 * Requirements 26.18, 26.20 — may `userId` use this profile at all?
 *
 * Permission only. The caller still has to check consent state; see
 * `services/voice/profile-access-service.ts` for the order the two are applied in.
 */
export function isUsePermitted(access: ProfileAccess, userId: string): boolean {
  return userId === access.ownerId || access.sharedUserIds.includes(userId);
}

/** An unshared profile: Requirement 26.18's default. */
export function ownerOnlyAccess(ownerId: string): ProfileAccess {
  return { ownerId, sharedUserIds: [] };
}

function invalid(violation: ShareListViolation, received: number): ShareListValidation {
  return {
    outcome: 'invalid',
    violation,
    min: MIN_SHARED_USERS,
    max: MAX_SHARED_USERS,
    received,
  };
}
