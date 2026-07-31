/**
 * The 168-hour preview window (Requirements 23.12, 23.13), as data.
 *
 * Modelled on `domain/voice/retention.ts` and, through it, on
 * `domain/audit-log/partition.ts` — deliberately, because that pair already settled how this
 * product layer expresses a retention floor: a constant, functions that compute the instants
 * from an origin, and an `assert…` that treats a shorter window as a programming error rather
 * than a setting someone may tune down.
 *
 * **Retention is expressed here as policy, not as a scheduled job.** Nothing in this module
 * deletes anything or asks anything to. That is not an omission: 23.12 and 23.13 are
 * statements about *when* a file must still be readable and *by when* another must be gone,
 * and the useful form of such a statement is a pair of instants recorded on the asset — which
 * a sweep, an object-store lifecycle rule or a manual audit can all be checked against.
 * Scheduling the deletion is not this task's.
 *
 * ### The two windows are different shapes, and it matters
 *
 * - **23.12, the preview:** a *floor*. Readable for **at least** 168 hours after completion.
 *   Keeping it longer complies; deleting it at 167 hours does not.
 * - **23.13, the source video:** a *ceiling with a precondition*. Deleted **after** the
 *   preview exists and **before** 168 hours have passed. Deleting it early — before the
 *   preview is muxed — breaks the preview; deleting it late breaks the retention promise.
 *
 * So 23.13 is a bounded interval and 23.12 is a half-line, and a single "retention" number
 * cannot express both. They share the 168-hour figure and nothing else.
 */

/** Requirements 23.12, 23.13. */
export const V2A_PREVIEW_MIN_RETENTION_HOURS = 168;

export const V2A_PREVIEW_MIN_RETENTION_MS = V2A_PREVIEW_MIN_RETENTION_HOURS * 3_600_000;

/**
 * Requirement 23.12: the instant the preview may first be discarded.
 *
 * The origin is "생성 완료 시각" — the foley completion instant — not the instant the preview
 * file happened to finish muxing. Using the mux instant would let a slow mux shorten the
 * window the user was promised.
 */
export function previewRetainedUntilMs(completedAtMs: number): number {
  return completedAtMs + V2A_PREVIEW_MIN_RETENTION_MS;
}

/** Requirement 23.12: whether the preview must still be readable at `nowMs`. */
export function isPreviewWithinRetention(completedAtMs: number, nowMs: number): boolean {
  return nowMs < previewRetainedUntilMs(completedAtMs);
}

/**
 * Requirement 23.12: whether a *declared* expiry honours the floor.
 *
 * This is the check that matters in practice. The service records an expiry on the asset; the
 * question is whether the recorded value is far enough out, and that is answerable the moment
 * the asset is written rather than 168 hours later.
 */
export function satisfiesPreviewRetention(completedAtMs: number, expiresAtMs: number): boolean {
  return expiresAtMs >= previewRetainedUntilMs(completedAtMs);
}

/**
 * Requirement 23.13's interval for deleting the uploaded source video.
 *
 * `notBeforeMs` is the preview creation instant, because 23.13 says "미리보기 영상 파일 생성이
 * 완료된 이후". `notAfterMs` is 168 hours after completion. The interval is empty — and the
 * requirement unsatisfiable — only if the preview took more than a week to create, which is
 * far outside Requirement 23.17's 900-second job budget.
 */
export interface SourceVideoDeletionWindow {
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

export function sourceVideoDeletionWindow(
  completedAtMs: number,
  previewCreatedAtMs: number,
): SourceVideoDeletionWindow {
  return {
    notBeforeMs: previewCreatedAtMs,
    notAfterMs: previewRetainedUntilMs(completedAtMs),
  };
}

/** Requirement 23.13: whether a deletion at `deletedAtMs` sits inside the window. */
export function isSourceVideoDeletionCompliant(
  window: SourceVideoDeletionWindow,
  deletedAtMs: number,
): boolean {
  return deletedAtMs >= window.notBeforeMs && deletedAtMs <= window.notAfterMs;
}

/**
 * Guards a configured retention window against being set below the requirement.
 *
 * Throws rather than clamping, exactly as `assertConsentRetentionDays` does: a deployment
 * configured to keep previews for 24 hours is misconfigured, and silently correcting it to
 * 168 would hide that from whoever set it.
 */
export function assertPreviewRetentionHours(retainHours: number): void {
  if (!Number.isFinite(retainHours) || retainHours < V2A_PREVIEW_MIN_RETENTION_HOURS) {
    throw new RangeError(
      `foley preview retention must be at least ${String(V2A_PREVIEW_MIN_RETENTION_HOURS)} ` +
        `hours from completion (Requirement 23.12), received ${String(retainHours)}`,
    );
  }
}
