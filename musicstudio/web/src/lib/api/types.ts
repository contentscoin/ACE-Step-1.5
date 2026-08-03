/**
 * The records the screens display.
 *
 * `StudioAsset` widens `LibraryAssetSummary` — the shape `applyLibraryQuery` sorts and filters —
 * with the four fields a *detail* page needs and a listing does not. Extending rather than
 * redeclaring is what lets the library page hand a row straight to the query function; a parallel
 * type would have to be mapped, and a mapping is where a field quietly stops being the same field.
 */

import type { AssetKind } from '@domain/asset-kind';
import type { LibraryAssetSummary } from '@domain/library/query';
import type { TimedLyrics } from '@domain/lyrics/timed-lyrics';

export interface StudioAsset extends LibraryAssetSummary {
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly isLoop: boolean;
  /** Requirement 12.5's timings, when the asset has any. */
  readonly timedLyrics: TimedLyrics | null;
  readonly genres: readonly string[];
  /** Requirements 16.5, 16.13 — what the detail page must disclose. */
  readonly aiGenerated: true;
}

/** Requirement 5's lifecycle, as a screen sees it. */
export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

export interface StudioJob {
  readonly jobId: string;
  readonly state: JobState;
  readonly assetKind: AssetKind;
  /** Requirement 5.1 — 1-based, while queued. */
  readonly queuePosition: number | null;
  /** Requirement 5.4 — 0–100 while running. */
  readonly percent: number | null;
  /** Requirement 5.5 — the estimate, when the engine has one. */
  readonly estimatedCompletionAtMs: number | null;
  /** Requirement 6.1 — why it failed, for the message and the retry decision. */
  readonly failureReason: string | null;
  /** Requirement 6.4 — the job this one retries. */
  readonly retryOfJobId: string | null;
  /** Requirement 5.6 — what it produced. */
  readonly assetIds: readonly string[];
}
