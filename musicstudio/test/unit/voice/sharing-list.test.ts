import { describe, expect, it } from 'vitest';

import {
  MAX_SHARED_USERS,
  MIN_SHARED_USERS,
  isUsePermitted,
  ownerOnlyAccess,
  validateShareList,
} from '../../../domain/voice/sharing-list';

/**
 * Voice_Profile use permission and the share list (Requirements 26.18, 26.19, 26.20).
 *
 * The bound counts the users the owner shared *with*, which is why the owner is not a
 * member: if they were, an owner could be removed from their own profile by a list edit
 * and "1명 이상 50명 이하" would be measuring something else.
 */

const OWNER = 'owner-1';

function users(count: number, prefix = 'user'): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}-${String(index)}`);
}

describe('Requirement 26.18 — the owner holds the permission unconditionally', () => {
  it('permits the owner with an empty share list', () => {
    const access = ownerOnlyAccess(OWNER);

    expect(access.sharedUserIds).toEqual([]);
    expect(isUsePermitted(access, OWNER)).toBe(true);
  });

  it('refuses everyone else when the profile is not shared', () => {
    expect(isUsePermitted(ownerOnlyAccess(OWNER), 'stranger')).toBe(false);
  });
});

describe('Requirement 26.19 — 1 to 50 users', () => {
  it('accepts a single user', () => {
    expect(validateShareList(OWNER, ['user-1'])).toEqual({
      outcome: 'valid',
      sharedUserIds: ['user-1'],
    });
  });

  it('accepts exactly 50', () => {
    const proposed = users(MAX_SHARED_USERS);

    expect(validateShareList(OWNER, proposed)).toEqual({
      outcome: 'valid',
      sharedUserIds: proposed,
    });
  });

  it('refuses 51', () => {
    expect(validateShareList(OWNER, users(MAX_SHARED_USERS + 1))).toEqual({
      outcome: 'invalid',
      violation: 'too_many_users',
      min: MIN_SHARED_USERS,
      max: MAX_SHARED_USERS,
      received: 51,
    });
  });

  it('refuses an empty list', () => {
    expect(validateShareList(OWNER, [])).toMatchObject({
      outcome: 'invalid',
      violation: 'too_few_users',
      received: 0,
    });
  });

  it('refuses a list of only blanks, which is an empty list once trimmed', () => {
    expect(validateShareList(OWNER, ['', '   '])).toMatchObject({
      outcome: 'invalid',
      violation: 'too_few_users',
      received: 0,
    });
  });

  it('collapses duplicates before counting, so 50 cannot be smuggled past the bound', () => {
    const repeated = Array.from({ length: 60 }, () => 'user-1');

    expect(validateShareList(OWNER, repeated)).toEqual({
      outcome: 'valid',
      sharedUserIds: ['user-1'],
    });
  });

  it('counts 51 distinct users even when the body also repeats them', () => {
    const proposed = [...users(51), ...users(51)];

    expect(validateShareList(OWNER, proposed)).toMatchObject({
      outcome: 'invalid',
      violation: 'too_many_users',
      received: 51,
    });
  });

  it('trims surrounding whitespace rather than treating it as a distinct user', () => {
    expect(validateShareList(OWNER, [' user-1 ', 'user-1'])).toEqual({
      outcome: 'valid',
      sharedUserIds: ['user-1'],
    });
  });

  it('refuses the owner in the list rather than silently dropping them', () => {
    // Silently dropping would make the stored count disagree with what the caller sent.
    expect(validateShareList(OWNER, [OWNER, 'user-1'])).toMatchObject({
      outcome: 'invalid',
      violation: 'owner_listed',
      received: 2,
    });
  });
});

describe('Requirement 26.20 — a non-listed user is not permitted', () => {
  const access = { ownerId: OWNER, sharedUserIds: ['user-1', 'user-2'] };

  it('permits a listed user', () => {
    expect(isUsePermitted(access, 'user-2')).toBe(true);
  });

  it('permits the owner even though they are not listed', () => {
    expect(isUsePermitted(access, OWNER)).toBe(true);
  });

  it('refuses a user who is not listed', () => {
    expect(isUsePermitted(access, 'user-3')).toBe(false);
  });

  it('is a permission question only, and says nothing about consent state', () => {
    // The withdrawal rule lives in consent-state.ts; a listed user still cannot generate
    // from a withdrawn profile (26.29). Keeping them apart stops this from becoming a
    // second, weaker copy of that rule.
    expect(isUsePermitted(access, 'user-1')).toBe(true);
  });
});
