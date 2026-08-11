/**
 * `StudioApi` — everything the screens may ask for (task 7.3, design §8).
 *
 * One interface for the whole product surface rather than one per screen, because the screens
 * share state: publishing on the asset page changes the explore feed, and a download refusal on
 * one screen has to read the same plan the other would. A per-screen client would let two of them
 * hold different ideas of what is public.
 *
 * Everything is async even where the demo implementation answers immediately, so swapping in the
 * HTTP gateway (task 9.1) is a change of provider rather than a change of every call site.
 */

import type { AssetKind } from '@domain/asset-kind';
import type { DownloadFormat, DownloadRuling } from '@domain/library/download';
import type { LibraryPage, LibraryQueryInput } from '@domain/library/query';
import type { ActiveLyricLine } from '@domain/playback/lyrics-sync';
import type { LoopPosition } from '@domain/playback/loop';
import type { Waveform } from '@domain/playback/waveform';
import type { FeedPage, FeedQueryInput } from '@domain/sharing/feed';
import type { LikeOutcome } from '@domain/sharing/like';
import type { SongGenerationRequest } from '@domain/song/request';
import type { SongFieldViolation } from '@domain/song/violation';
import type { EditCommand } from '@domain/timeline/commands';
import type { TimelineProject } from '@domain/timeline/project';
import type { EffectChain } from '@domain/effects/chain';
import type { MasteringSuggestion } from '@domain/mastering/suggestion';

import type { StudioAsset, StudioJob } from './types';

export interface SubmitOutcome {
  readonly kind: 'accepted' | 'rejected';
  readonly job?: StudioJob;
  /** Requirements 3.5, 4.6 — every violated field at once, with its allowance. */
  readonly violations?: readonly SongFieldViolation[];
}

export interface DownloadOutcome {
  readonly ruling: DownloadRuling;
  /** Present only when the ruling permitted it. */
  readonly fileName?: string;
  readonly bytes?: number;
}

/** Requirement 29.28's answer: audio to listen to, and nothing that persists. */
export interface PreviewStream {
  readonly streamUrl: string;
  readonly durationMs: number;
}

/** A `GenerationVersion` as a screen needs it — the domain's fields, minus the storage ones. */
export interface StudioVersion {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isOriginal: boolean;
  readonly chain: EffectChain;
  readonly createdAtMs: number;
}

/**
 * Requirement 14.3's four groups: 제목, 캡션, 재생, AI 생성 표기.
 *
 * Nothing here identifies the owner. Publishing one asset should not publish a little of
 * everything else the account holds, and the field that would do that is an account id sitting
 * quietly in a payload nobody reads.
 */
export interface PublicAssetPage {
  readonly title: string;
  readonly caption: string;
  readonly assetId: string;
  readonly assetKind: AssetKind;
  readonly durationMs: number;
  readonly isLoop: boolean;
  readonly likeCount: number;
  readonly remixAllowed: boolean;
}

export interface ShareState {
  readonly published: boolean;
  readonly url: string | null;
  readonly remixAllowed: boolean;
  readonly likeCount: number;
}

export interface StudioApi {
  /* ------------------------------------------------------------- generation */

  /** Requirements 3.1, 3.5-3.8, 4.1, 4.6-4.10, 5.1. */
  submitSong(request: SongGenerationRequest): Promise<SubmitOutcome>;
  /** Requirements 5.4, 5.5, 6.1 — the job as it stands now. */
  jobStatus(jobId: string): Promise<StudioJob | null>;
  /** Requirement 6.4 — a retry is a new job that remembers the old one. */
  retryJob(jobId: string): Promise<SubmitOutcome>;
  cancelJob(jobId: string): Promise<StudioJob | null>;

  /* ---------------------------------------------------------------- library */

  /** Requirements 11.1-11.5, 11.12. */
  listAssets(query: LibraryQueryInput): Promise<LibraryPage>;
  findAsset(assetId: string): Promise<StudioAsset | null>;
  renameAsset(assetId: string, name: string): Promise<StudioAsset>;
  /** Requirements 13.1-13.2, 13.4, 13.9. */
  planDownload(assetId: string, format: DownloadFormat, lossless: boolean): Promise<DownloadOutcome>;
  downloadFormatsFor(assetKind: AssetKind): readonly DownloadFormat[];

  /* --------------------------------------------------------------- playback */

  /** Requirement 12.7 — the drawing, at a resolution the caller asks for. */
  waveform(assetId: string, buckets: number): Promise<Waveform>;
  /** Requirement 12.5. */
  lyricLineAt(assetId: string, positionMs: number): Promise<ActiveLyricLine | null>;
  /** Requirement 12.9. */
  positionAfter(assetId: string, elapsedMs: number): Promise<LoopPosition>;
  /** Requirements 12.1, 12.3 — a URL the `<audio>` element can seek within. */
  streamUrl(assetId: string): string;

  /* ---------------------------------------------------------------- sharing */

  /** Requirements 14.2, 14.4. */
  setPublished(assetId: string, published: boolean, remixAllowed: boolean): Promise<ShareState>;
  shareState(assetId: string): Promise<ShareState>;
  /**
   * Requirement 14.3 — what an *unauthenticated* visitor holding a link is shown, and 14.4's
   * `null` for a link that has been revoked.
   *
   * Keyed by token rather than by asset id, because that is the only thing the visitor has;
   * a signature taking an asset id would be a screen that could be reached without a link.
   */
  publicPage(token: string): Promise<PublicAssetPage | null>;
  /** Requirements 14.5, 14.6. */
  feed(query: FeedQueryInput): Promise<FeedPage>;
  /** Requirements 14.7, 14.8. */
  like(assetId: string): Promise<LikeOutcome>;

  /* --------------------------------------------------------------- timeline */

  project(): Promise<TimelineProject>;
  /** Requirements 28.14-28.23 — one edit, planned and applied, or refused with a reason. */
  applyEdit(command: EditCommand): Promise<{ project: TimelineProject; canUndo: boolean; canRedo: boolean }>;
  /** Requirements 28.35, 28.36. */
  undo(): Promise<{ project: TimelineProject; canUndo: boolean; canRedo: boolean }>;
  redo(): Promise<{ project: TimelineProject; canUndo: boolean; canRedo: boolean }>;

  /* ----------------------------------------------------- effects, mastering */

  /** Requirements 29.1, 29.13 — the chain on a version. */
  effectChain(assetId: string): Promise<EffectChain>;
  setEffectChain(assetId: string, chain: EffectChain): Promise<EffectChain>;
  /**
   * Requirement 29.28 — a preview is a *stream*, and saves no version.
   *
   * Typed to return only a stream so a caller cannot mistake it for a save: the clause's whole
   * content is that listening to a chain does not add to the version list, and an API that
   * returned a version here would make that a convention rather than a fact.
   */
  previewChain(assetId: string, chain: EffectChain): Promise<PreviewStream>;
  /** Requirement 29.34 — the versions of an asset, exactly one of them the default. */
  versions(assetId: string): Promise<readonly StudioVersion[]>;
  /** Saving *is* what mints a version, as against previewing. */
  saveVersion(assetId: string, name: string, chain: EffectChain): Promise<readonly StudioVersion[]>;
  /** Requirement 29.34 — promoting one demotes every other. */
  setDefaultVersion(assetId: string, versionId: string): Promise<readonly StudioVersion[]>;
  /** Requirements 30.1, 30.3, 30.4, 30.22 — the suggestion and the measurement behind it. */
  masteringSuggestion(assetId: string): Promise<MasteringSuggestion>;
}
