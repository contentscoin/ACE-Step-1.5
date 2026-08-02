import { describe, expect, it } from 'vitest';

import {
  CONSENT_RECORD_MIN_RETENTION_DAYS,
  CONSENT_RECORD_MIN_RETENTION_MS,
  assertConsentRetentionDays,
  isConsentRecordPrunable,
  retentionFloorMs,
} from '../../../domain/voice/retention';

/**
 * Requirement 26.14 — a Voice_Consent_Record is retained five years past the target
 * Voice_Profile's deletion.
 *
 * The clock origin is the *profile deletion* instant, not the submission instant, so a
 * record for a live profile never becomes prunable. That is both the correct reading of
 * "삭제 시각으로부터 5년간" and the safe one, and it is what the first group asserts.
 *
 * The floor is a floor, not a setting — the same treatment `domain/audit-log/partition.ts`
 * gives the 365-day audit floor.
 */

const DAY = 86_400_000;
const DELETED_AT = 1_700_000_000_000;

describe('the retention floor', () => {
  it('is five years, taking the conservative reading with a leap day', () => {
    expect(CONSENT_RECORD_MIN_RETENTION_DAYS).toBe(1_826);
    expect(CONSENT_RECORD_MIN_RETENTION_MS).toBe(1_826 * DAY);
  });

  it('rejects a shorter retention as a programming error', () => {
    expect(() => assertConsentRetentionDays(1_825)).toThrow(RangeError);
    expect(() => assertConsentRetentionDays(365)).toThrow(/at least 1826 days/);
    expect(() => assertConsentRetentionDays(Number.NaN)).toThrow(RangeError);
  });

  it('accepts the floor and anything longer', () => {
    expect(() => assertConsentRetentionDays(CONSENT_RECORD_MIN_RETENTION_DAYS)).not.toThrow();
    expect(() => assertConsentRetentionDays(3_650)).not.toThrow();
  });
});

describe('Requirement 26.14 — a record for a live profile is never prunable', () => {
  it('has no retention floor while the profile exists', () => {
    expect(retentionFloorMs({ profileDeletedAtMs: null })).toBeNull();
  });

  it('is not prunable however much time passes', () => {
    const subject = { profileDeletedAtMs: null };

    expect(isConsentRecordPrunable(subject, DELETED_AT + 100 * 365 * DAY)).toBe(false);
  });
});

describe('Requirement 26.14 — the five-year window runs from profile deletion', () => {
  const subject = { profileDeletedAtMs: DELETED_AT };

  it('reports the floor as deletion plus five years', () => {
    expect(retentionFloorMs(subject)).toBe(DELETED_AT + CONSENT_RECORD_MIN_RETENTION_MS);
  });

  it('is not prunable one millisecond early', () => {
    expect(isConsentRecordPrunable(subject, DELETED_AT + CONSENT_RECORD_MIN_RETENTION_MS - 1))
      .toBe(false);
  });

  it('becomes prunable exactly at the floor', () => {
    expect(isConsentRecordPrunable(subject, DELETED_AT + CONSENT_RECORD_MIN_RETENTION_MS)).toBe(
      true,
    );
  });

  it('is not prunable at the deletion instant itself', () => {
    expect(isConsentRecordPrunable(subject, DELETED_AT)).toBe(false);
  });

  it('refuses to answer at all for a retention shorter than the floor', () => {
    // There is no path that returns `true` early — which is the reason the rule lives
    // here rather than in a query someone could tighten by hand.
    expect(() => isConsentRecordPrunable(subject, DELETED_AT, 30)).toThrow(RangeError);
  });

  it('honours a longer retention than the floor', () => {
    expect(isConsentRecordPrunable(subject, DELETED_AT + 2_000 * DAY, 3_000)).toBe(false);
    expect(isConsentRecordPrunable(subject, DELETED_AT + 3_000 * DAY, 3_000)).toBe(true);
  });
});
