/**
 * The seams around `Sharing_Service` (design §4.1, §9).
 *
 * Interfaces rather than clients, for the reason `services/library/ports.ts` gives. Two
 * shapes here are worth the paragraph they get:
 *
 * ### The feed store takes a whole query
 *
 * `applyFeedQuery` is the specification of the feed — publication, deletion, review state,
 * three filters, an order and a cursor. A store receiving loose filters would re-derive that
 * conjunction, and the first store to forget Requirement 16.9 would serve a withheld asset.
 * Same arrangement as the library's, same reason.
 *
 * ### The token source is a port
 *
 * Requirement 14.2's "추측이 어려운" is a claim about randomness, and randomness is exactly
 * what a test cannot assert against. The default implementation is 32 bytes from
 * `node:crypto`; a test injects a counter and asserts on the *shape* and on the fact that
 * two publications of one asset never reuse a token. What must not happen is a service that
 * generates tokens inline — then nothing can check either property.
 */

import type { AssetLike } from '../../domain/sharing/like';
import type { FeedAssetSummary, FeedPage, FeedQuery } from '../../domain/sharing/feed';
import type { ShareLink } from '../../domain/sharing/share-link';

/** What sharing needs to know about an asset. Wider than the feed summary by four fields. */
export interface ShareableAsset extends FeedAssetSummary {
  readonly durationMs: number;
  readonly isLoop: boolean;
  readonly remixAllowed: boolean;
  /** `null` while private — the token of the current publication. */
  readonly shareToken: string | null;
}

export interface ShareStore {
  find(assetId: string): Promise<ShareableAsset | null>;
  /** Requirement 14.3: the only lookup an unauthenticated visitor can perform. */
  findByToken(token: string): Promise<ShareableAsset | null>;
  /** Requirement 14.2. Replaces any existing publication, which mints a new token. */
  publish(link: ShareLink): Promise<ShareableAsset>;
  /** Requirement 14.4. The publication is destroyed, not parked. */
  revoke(assetId: string): Promise<ShareableAsset>;
  /** Requirements 14.5, 14.6 — see the header on why this takes the query. */
  page(query: FeedQuery): Promise<FeedPage>;
  /** Requirement 26.30 (task 6.2's `GeneratedAssetVisibilityPort`). */
  publicAssetIdsForVoiceProfile(voiceProfileId: string): Promise<readonly string[]>;
}

export interface LikeStore {
  /** Insert if absent. Returns whether this call was the one that inserted. */
  add(like: AssetLike): Promise<boolean>;
  remove(assetId: string, accountId: string): Promise<boolean>;
  countFor(assetId: string): Promise<number>;
  hasLiked(assetId: string, accountId: string): Promise<boolean>;
}

/** Requirement 14.11: a Sound_Pack is one public item, not 78. */
export interface SoundPackShare {
  readonly soundPackId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly cueCount: number;
  readonly token: string | null;
  readonly publishedAtMs: number | null;
  readonly remixAllowed: boolean;
}

export interface SoundPackShareStore {
  find(soundPackId: string): Promise<SoundPackShare | null>;
  findByToken(token: string): Promise<SoundPackShare | null>;
  publish(soundPackId: string, token: string, atMs: number, remixAllowed: boolean): Promise<SoundPackShare>;
  revoke(soundPackId: string): Promise<SoundPackShare>;
}

/** See the header. Returns a base64url token of `SHARE_TOKEN_ENTROPY_BYTES` bytes. */
export interface ShareTokenSource {
  next(): string;
}

export interface SharingAuditPort {
  /** Requirement 14.2: "공개 상태 변경을 Audit_Log에 기록한다". */
  record(event: {
    readonly eventType: 'visibility_changed';
    readonly actorId: string;
    readonly targetId: string;
    readonly beforeValue: unknown;
    readonly afterValue: unknown;
    readonly atMs: number;
  }): Promise<void>;
}
