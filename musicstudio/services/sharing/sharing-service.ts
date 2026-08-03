/**
 * Sharing_Service — publication, the public page, discovery, likes and remixing.
 *
 * Requirements 14.1–14.11, design §4.1 and §9.
 *
 * ### The one rule everything else is written against
 *
 * "Public" is `isDiscoverable` in `domain/sharing/feed.ts` — published, not soft-deleted,
 * not excluded by review — and **every** path here goes through it: the feed, the public
 * page, the like gate, the remix gate, and the visibility answer three other services ask
 * for through their own ports. There is deliberately no second spelling. A service that
 * decided "public" separately per surface is one that streams a withheld asset while the
 * feed hides it, and nothing about that failure looks like a bug from inside either surface.
 *
 * ### Requirement 14.1 is not implemented here
 *
 * "새로 생성된 모든 Audio_Asset의 공개 상태를 비공개" is satisfied by the *absence* of an
 * `asset_share` row, which is the state a newly created asset is in without anything doing
 * anything. It is stated as a test rather than as code, because code that set a flag to
 * false on creation would be a thing that could fail to run; nothing can fail to not insert.
 */

import { isDiscoverable, toFeedQuery, feedQueryViolations, type FeedPage, type FeedQueryInput } from '../../domain/sharing/feed';
import { applyLike, type AssetLike, type LikeOutcome } from '../../domain/sharing/like';
import { mayRemix, remixPermission, type RemixPermission } from '../../domain/sharing/remix';
import { shareLinkUrl, type ShareLink } from '../../domain/sharing/share-link';
import { systemClock, type Clock } from '../clock';
import type { DisclosurePort } from '../moderation/disclosure-port';
import {
  sharingAssetForbidden,
  sharingAssetNotFound,
  sharingAssetNotPublic,
  sharingFeedQueryInvalid,
  sharingLinkNotFound,
  sharingRemixNotPermitted,
  sharingSoundPackForbidden,
  sharingSoundPackNotFound,
} from './errors';
import { publicAssetPage, type PublicAssetPage } from './public-page';
import { cryptoShareTokenSource } from './share-token';
import type {
  LikeStore,
  ShareStore,
  ShareTokenSource,
  ShareableAsset,
  SharingAuditPort,
  SoundPackShare,
  SoundPackShareStore,
} from './ports';

export interface SharingServiceOptions {
  readonly assets: ShareStore;
  readonly likes: LikeStore;
  readonly soundPacks?: SoundPackShareStore;
  readonly clock?: Clock;
  readonly tokens?: ShareTokenSource;
  /** Requirement 14.2 requires the change to be recorded. */
  readonly audit?: SharingAuditPort;
  /** Requirements 16.5, 16.13's obligations, rendered by task 8.3. */
  readonly disclosure?: DisclosurePort;
  /** Where public links live, e.g. `https://musicstudio.example`. */
  readonly publicBaseUrl?: string;
}

export interface PublishResult {
  readonly link: ShareLink;
  readonly url: string | null;
  readonly asset: ShareableAsset;
}

export function createSharingService(options: SharingServiceOptions) {
  const { assets, likes } = options;
  const clock = options.clock ?? systemClock;
  const tokens = options.tokens ?? cryptoShareTokenSource;
  const audit = options.audit;
  const disclosure = options.disclosure;
  const publicBaseUrl = options.publicBaseUrl ?? null;

  function nowMs(): number {
    return clock.now().getTime();
  }

  /** Requirement 11.9's ownership gate, reused verbatim for a publication. */
  async function loadOwned(ownerId: string, assetId: string): Promise<ShareableAsset> {
    const asset = await assets.find(assetId);
    if (asset === null || asset.isDeleted) throw sharingAssetNotFound(assetId);
    if (asset.ownerId !== ownerId) throw sharingAssetForbidden(assetId);
    return asset;
  }

  /**
   * A published asset a stranger may see, or a 404 that says nothing about which state it
   * is in. The single lookup behind the public page, the like gate and the remix gate.
   */
  async function loadPublic(assetId: string): Promise<ShareableAsset> {
    const asset = await assets.find(assetId);
    if (asset === null || !isDiscoverable(asset)) throw sharingAssetNotPublic(assetId);
    return asset;
  }

  async function pageFor(asset: ShareableAsset): Promise<PublicAssetPage> {
    const obligations =
      disclosure?.obligationsFor({ assetId: asset.id, assetKind: asset.assetKind }) ?? [];
    return publicAssetPage(
      {
        assetId: asset.id,
        name: asset.name,
        caption: asset.caption,
        assetKind: asset.assetKind,
        durationMs: asset.durationMs,
        isLoop: asset.isLoop,
        likeCount: asset.likeCount,
        playCount: asset.playCount,
        remixAllowed: asset.remixAllowed,
        publishedAtMs: asset.publishedAtMs ?? 0,
      },
      obligations,
    );
  }

  return {
    /**
     * Requirement 14.2 — publish, mint a link, record the change.
     *
     * Republishing an already-public asset mints a **new** token and revokes the old one, as
     * `share-link.ts` explains. It is not an error: the owner may be changing `remixAllowed`,
     * and refusing would make that a revoke-then-publish dance with a window of being live
     * under a token they meant to retire.
     */
    async publish(input: {
      readonly ownerId: string;
      readonly assetId: string;
      readonly remixAllowed?: boolean;
    }): Promise<PublishResult> {
      const before = await loadOwned(input.ownerId, input.assetId);
      const link: ShareLink = {
        assetId: input.assetId,
        token: tokens.next(),
        publishedAtMs: nowMs(),
        remixAllowed: input.remixAllowed ?? false,
      };
      const asset = await assets.publish(link);

      await audit?.record({
        eventType: 'visibility_changed',
        actorId: input.ownerId,
        targetId: input.assetId,
        beforeValue: { public: before.publishedAtMs !== null, remixAllowed: before.remixAllowed },
        afterValue: { public: true, remixAllowed: link.remixAllowed },
        atMs: link.publishedAtMs,
      });

      return {
        link,
        url: publicBaseUrl === null ? null : shareLinkUrl(publicBaseUrl, link.token),
        asset,
      };
    },

    /** Requirement 14.4 — the publication is destroyed and the link answers 404. */
    async revoke(input: { readonly ownerId: string; readonly assetId: string }): Promise<ShareableAsset> {
      const before = await loadOwned(input.ownerId, input.assetId);
      const asset = await assets.revoke(input.assetId);

      await audit?.record({
        eventType: 'visibility_changed',
        actorId: input.ownerId,
        targetId: input.assetId,
        beforeValue: { public: before.publishedAtMs !== null, remixAllowed: before.remixAllowed },
        afterValue: { public: false, remixAllowed: false },
        atMs: nowMs(),
      });

      return asset;
    },

    /**
     * Requirement 14.3 — the page an unauthenticated visitor gets, or 14.4's 404.
     *
     * The token is the only credential, so the lookup is by token and the result is checked
     * against `isDiscoverable` again: a token can outlive the state that made it valid — the
     * owner soft-deletes, a report arrives — and a store that only deleted rows on revocation
     * would still hand out a page for both.
     */
    async publicPage(token: string): Promise<PublicAssetPage> {
      const asset = await assets.findByToken(token);
      if (asset === null || !isDiscoverable(asset)) throw sharingLinkNotFound();
      return pageFor(asset);
    },

    /** Requirements 14.5, 14.6 — the feed, for anyone, authenticated or not. */
    async feed(input: FeedQueryInput = {}): Promise<FeedPage> {
      const violations = feedQueryViolations(input);
      if (violations.length > 0) throw sharingFeedQueryInvalid(violations);
      return assets.page(toFeedQuery(input));
    },

    /**
     * Requirements 14.7, 14.8 — **Property 20**.
     *
     * The store's `add` is the idempotence (`PRIMARY KEY (asset_id, account_id)`); this
     * method's job is the gate in front of it — 14.7 says 공개 Audio_Asset, so a like on
     * something private is refused rather than stored against an asset nobody can see.
     */
    async like(assetId: string, accountId: string): Promise<LikeOutcome> {
      await loadPublic(assetId);
      const inserted = await likes.add({ assetId, accountId, likedAtMs: nowMs() });
      return { likeCount: await likes.countFor(assetId), liked: true, changed: inserted };
    },

    /** The inverse. A product addition — see `domain/sharing/like.ts`. */
    async unlike(assetId: string, accountId: string): Promise<LikeOutcome> {
      await loadPublic(assetId);
      const removed = await likes.remove(assetId, accountId);
      return { likeCount: await likes.countFor(assetId), liked: false, changed: removed };
    },

    async hasLiked(assetId: string, accountId: string): Promise<boolean> {
      return likes.hasLiked(assetId, accountId);
    },

    /** Requirement 14.9 — may this requester derive from this asset? */
    async remixPermissionFor(assetId: string, requesterId: string | null): Promise<RemixPermission> {
      const asset = await assets.find(assetId);
      if (asset === null) return 'not_public';
      return remixPermission(asset, requesterId);
    },

    /**
     * The same question, as a gate an Edit_Task submission can call.
     *
     * Throws rather than returning false, because the caller is about to charge credits and
     * enqueue work: a boolean the caller might forget to check is the wrong shape for the
     * last thing standing between a stranger and someone else's audio.
     */
    async assertMayRemix(assetId: string, requesterId: string | null): Promise<ShareableAsset> {
      const asset = await assets.find(assetId);
      if (asset === null) throw sharingAssetNotPublic(assetId);
      if (!mayRemix(asset, requesterId)) {
        throw remixPermission(asset, requesterId) === 'not_public'
          ? sharingAssetNotPublic(assetId)
          : sharingRemixNotPermitted(assetId);
      }
      return asset;
    },

    /** Requirement 14.11 — the pack is one item; its 78 cues stay private assets. */
    async publishSoundPack(input: {
      readonly ownerId: string;
      readonly soundPackId: string;
      readonly remixAllowed?: boolean;
    }): Promise<SoundPackShare> {
      const packs = requirePacks();
      const pack = await packs.find(input.soundPackId);
      if (pack === null) throw sharingSoundPackNotFound(input.soundPackId);
      if (pack.ownerId !== input.ownerId) throw sharingSoundPackForbidden(input.soundPackId);

      const at = nowMs();
      const published = await packs.publish(
        input.soundPackId,
        tokens.next(),
        at,
        input.remixAllowed ?? false,
      );

      await audit?.record({
        eventType: 'visibility_changed',
        actorId: input.ownerId,
        targetId: input.soundPackId,
        beforeValue: { public: pack.publishedAtMs !== null },
        afterValue: { public: true, remixAllowed: published.remixAllowed },
        atMs: at,
      });

      return published;
    },

    async revokeSoundPack(input: {
      readonly ownerId: string;
      readonly soundPackId: string;
    }): Promise<SoundPackShare> {
      const packs = requirePacks();
      const pack = await packs.find(input.soundPackId);
      if (pack === null) throw sharingSoundPackNotFound(input.soundPackId);
      if (pack.ownerId !== input.ownerId) throw sharingSoundPackForbidden(input.soundPackId);

      const revoked = await packs.revoke(input.soundPackId);
      await audit?.record({
        eventType: 'visibility_changed',
        actorId: input.ownerId,
        targetId: input.soundPackId,
        beforeValue: { public: pack.publishedAtMs !== null },
        afterValue: { public: false },
        atMs: nowMs(),
      });
      return revoked;
    },

    /** Requirement 14.11's public item, by its own token. */
    async publicSoundPack(token: string): Promise<SoundPackShare> {
      const packs = requirePacks();
      const pack = await packs.findByToken(token);
      if (pack === null || pack.publishedAtMs === null) throw sharingLinkNotFound();
      return pack;
    },

    /**
     * The answer `services/playback`, `services/moderation` and `services/voice` each ask
     * for through a port of their own. One implementation, one rule — see the header.
     */
    async isPubliclyVisible(assetId: string): Promise<boolean> {
      const asset = await assets.find(assetId);
      return asset !== null && isDiscoverable(asset);
    },

    /** Requirement 26.30 (task 6.2's port): public assets made with a Voice_Profile. */
    async publicAssetIdsForVoiceProfile(voiceProfileId: string): Promise<readonly string[]> {
      return assets.publicAssetIdsForVoiceProfile(voiceProfileId);
    },

    /**
     * Requirement 26.33 — turn a list private, without an owner check.
     *
     * The one path that publishes state changes on someone's assets without their consent,
     * and deliberately so: a speaker has withdrawn consent and 26.33 gives a deadline. The
     * actor recorded in the audit entry is the withdrawal, not the owner.
     */
    async makePrivateForConsentWithdrawal(
      assetIds: readonly string[],
      actorId: string,
    ): Promise<void> {
      for (const assetId of assetIds) {
        const before = await assets.find(assetId);
        if (before === null || before.publishedAtMs === null) continue;
        await assets.revoke(assetId);
        await audit?.record({
          eventType: 'visibility_changed',
          actorId,
          targetId: assetId,
          beforeValue: { public: true },
          afterValue: { public: false, reason: 'consent_withdrawal' },
          atMs: nowMs(),
        });
      }
    },
  };

  function requirePacks(): SoundPackShareStore {
    if (options.soundPacks === undefined) {
      throw new Error('Sharing_Service was composed without a SoundPackShareStore');
    }
    return options.soundPacks;
  }
}

/** Kept for callers that want the domain outcome shape without the store round trip. */
export { applyLike };
export type { AssetLike };
