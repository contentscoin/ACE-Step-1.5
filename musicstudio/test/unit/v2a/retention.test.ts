import { describe, expect, it } from 'vitest';

import {
  V2A_PREVIEW_MIN_RETENTION_HOURS,
  V2A_PREVIEW_MIN_RETENTION_MS,
  assertPreviewRetentionHours,
  isPreviewWithinRetention,
  isSourceVideoDeletionCompliant,
  previewRetainedUntilMs,
  satisfiesPreviewRetention,
  sourceVideoDeletionWindow,
} from '../../../domain/v2a/retention';

/**
 * The 168-hour preview window, as policy rather than as a scheduled job.
 *
 * **Validates: Requirements 23.12, 23.13**
 *
 * The two windows are *different shapes* and that is the substance of these tests: 23.12 is a
 * floor (the preview stays readable for **at least** 168 hours) and 23.13 is a bounded interval
 * (the source video is deleted **after** the preview exists and **before** the 168 hours elapse).
 * A single "retention" number cannot express both, so nothing here treats them as one.
 */

const HOUR_MS = 3_600_000;
const COMPLETED = Date.UTC(2025, 4, 1, 12, 0, 0);

describe('the constant (Requirements 23.12, 23.13)', () => {
  it('is 168 hours, in both units', () => {
    expect(V2A_PREVIEW_MIN_RETENTION_HOURS).toBe(168);
    expect(V2A_PREVIEW_MIN_RETENTION_MS).toBe(168 * HOUR_MS);
  });
});

describe('the preview floor (Requirement 23.12)', () => {
  it('runs 168 hours from the completion instant, not from the mux instant', () => {
    // A mux that finished an hour later must not shorten the promised window.
    expect(previewRetainedUntilMs(COMPLETED)).toBe(COMPLETED + 168 * HOUR_MS);
  });

  it('is readable throughout the window and may be discarded at its end', () => {
    expect(isPreviewWithinRetention(COMPLETED, COMPLETED)).toBe(true);
    expect(isPreviewWithinRetention(COMPLETED, COMPLETED + 167 * HOUR_MS)).toBe(true);
    expect(isPreviewWithinRetention(COMPLETED, COMPLETED + 168 * HOUR_MS - 1)).toBe(true);
    expect(isPreviewWithinRetention(COMPLETED, COMPLETED + 168 * HOUR_MS)).toBe(false);
  });

  it('accepts a declared expiry at or beyond the floor and refuses one short of it', () => {
    expect(satisfiesPreviewRetention(COMPLETED, COMPLETED + 168 * HOUR_MS)).toBe(true);
    // Keeping it longer complies; 23.12 is a floor.
    expect(satisfiesPreviewRetention(COMPLETED, COMPLETED + 720 * HOUR_MS)).toBe(true);
    expect(satisfiesPreviewRetention(COMPLETED, COMPLETED + 167 * HOUR_MS)).toBe(false);
  });
});

describe('the source video interval (Requirement 23.13)', () => {
  it('opens when the preview exists and closes at the 168-hour mark', () => {
    const previewCreatedAt = COMPLETED + 2_000;
    const window = sourceVideoDeletionWindow(COMPLETED, previewCreatedAt);

    expect(window.notBeforeMs).toBe(previewCreatedAt);
    expect(window.notAfterMs).toBe(COMPLETED + 168 * HOUR_MS);
  });

  it('refuses a deletion before the preview exists, which would break the preview', () => {
    const window = sourceVideoDeletionWindow(COMPLETED, COMPLETED + 2_000);

    expect(isSourceVideoDeletionCompliant(window, COMPLETED + 1_999)).toBe(false);
    expect(isSourceVideoDeletionCompliant(window, COMPLETED + 2_000)).toBe(true);
  });

  it('refuses a deletion after the window closes, which would break the promise', () => {
    const window = sourceVideoDeletionWindow(COMPLETED, COMPLETED);

    expect(isSourceVideoDeletionCompliant(window, COMPLETED + 168 * HOUR_MS)).toBe(true);
    expect(isSourceVideoDeletionCompliant(window, COMPLETED + 168 * HOUR_MS + 1)).toBe(false);
  });

  it('leaves a usable interval for any preview inside 23.17s 900-second budget', () => {
    const window = sourceVideoDeletionWindow(COMPLETED, COMPLETED + 900_000);

    expect(window.notAfterMs).toBeGreaterThan(window.notBeforeMs);
  });
});

describe('a misconfigured deployment is an error, not a clamp', () => {
  it('accepts 168 hours and anything longer', () => {
    expect(() => {
      assertPreviewRetentionHours(168);
    }).not.toThrow();
    expect(() => {
      assertPreviewRetentionHours(720);
    }).not.toThrow();
  });

  it('throws for a shorter window rather than silently correcting it', () => {
    expect(() => {
      assertPreviewRetentionHours(24);
    }).toThrow(RangeError);
    expect(() => {
      assertPreviewRetentionHours(Number.NaN);
    }).toThrow(RangeError);
  });
});
