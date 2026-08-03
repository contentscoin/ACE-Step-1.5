/**
 * The Sharing_Service, seen through three other services' ports.
 *
 * Three tasks each declared the *narrowest* question they needed about publication and left
 * the answer to task 5.3:
 *
 * | port | declared by | criteria |
 * |---|---|---|
 * | `AssetVisibilityPort` | `services/playback/ports.ts` (5.2) | 12.6 |
 * | `PublicAssetLookupPort` | `services/moderation/report-service.ts` (6.1) | 16.8 |
 * | `GeneratedAssetVisibilityPort` | `services/voice/ports.ts` (6.2) | 26.30, 26.33 |
 *
 * This module is where they are answered, and the point is that they are answered by the
 * *same* service — `isPubliclyVisible` in `sharing-service.ts` — rather than by three
 * lookups that could disagree. The adapters below only reshape: sync vs async, one id vs a
 * list. None of them decides anything.
 *
 * The two synchronous ports are the awkward ones. `PublicAssetLookupPort` and
 * `GeneratedAssetVisibilityPort` were declared sync, and the Sharing_Service is async
 * because its store is. Rather than change either side, these adapters take a snapshot the
 * composition root refreshes — a `Set` of public asset ids — which is honest about what a
 * synchronous answer can be: a fact from a moment ago, not a live read.
 */

import type { AssetVisibilityPort } from '../playback/ports';
import type { PublicAssetLookupPort } from '../moderation/report-service';
import type { GeneratedAssetVisibilityPort } from '../voice/ports';

export interface SharingVisibilitySource {
  isPubliclyVisible(assetId: string): Promise<boolean>;
  publicAssetIdsForVoiceProfile(voiceProfileId: string): Promise<readonly string[]>;
  makePrivateForConsentWithdrawal(assetIds: readonly string[], actorId: string): Promise<void>;
}

/** Requirement 12.6 — `services/playback` asks this of every stream. */
export function playbackVisibilityPort(sharing: SharingVisibilitySource): AssetVisibilityPort {
  return { isPubliclyVisible: (assetId) => sharing.isPubliclyVisible(assetId) };
}

/**
 * Requirement 16.8 — a report targets a *public* asset.
 *
 * Synchronous, so it reads a snapshot. See the header: the composition root owns refreshing
 * it, and the failure mode is bounded — a report accepted against an asset unpublished
 * moments ago, which the review queue then finds already invisible.
 */
export function moderationPublicAssetPort(publicAssetIds: ReadonlySet<string>): PublicAssetLookupPort {
  return { isPubliclyVisible: (assetId) => publicAssetIds.has(assetId) };
}

/**
 * Requirements 26.30, 26.33 — consent withdrawal unpublishes what the voice made.
 *
 * `makePrivate` is fire-and-forget against an async service, which is the shape 6.2 declared
 * (`void`, not `Promise<void>`). The rejection is routed to `onError` rather than becoming
 * an unhandled rejection, because 26.33 has a deadline and a silent failure to unpublish is
 * the one outcome nobody would notice.
 */
export function voiceAssetVisibilityPort(
  sharing: SharingVisibilitySource,
  snapshot: {
    publicAssetIdsFor(voiceProfileId: string): readonly string[];
  },
  options: { readonly actorId?: string; readonly onError?: (error: unknown) => void } = {},
): GeneratedAssetVisibilityPort {
  const actorId = options.actorId ?? 'consent_withdrawal';
  return {
    publicAssetIdsFor: (voiceProfileId) => snapshot.publicAssetIdsFor(voiceProfileId),
    makePrivate: (assetIds) => {
      void sharing.makePrivateForConsentWithdrawal(assetIds, actorId).catch((error: unknown) => {
        options.onError?.(error);
      });
    },
  };
}
