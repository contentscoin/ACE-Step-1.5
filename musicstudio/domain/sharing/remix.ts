/**
 * Remote remix (Requirement 14.9).
 *
 * > WHERE 원격 리믹스가 허용된 공개 Audio_Asset인 경우, THE Sharing_Service SHALL 다른
 * > 사용자가 해당 자산을 원본으로 하는 Edit_Task를 생성하도록 허용한다
 *
 * A WHERE clause, so the permission is a *state* of the asset and not an act of the caller:
 * three conditions must hold at once, and the reason each is here is worth stating because
 * dropping any one of them is a plausible-looking simplification that quietly gives away
 * someone's audio.
 *
 * - **Published.** A private asset is not remixable no matter what its flag says; the flag
 *   is a property of the publication, and 14.9 says 공개 Audio_Asset.
 * - **Flagged.** Default off. Requirement 14.1 makes an asset private by default and
 *   nothing in 14 makes remix the default for a published one, so publishing alone never
 *   grants derivation rights.
 * - **Discoverable.** A withheld or under-review asset (16.9) is out of the feed, and
 *   letting it be remixed would launder it back in as someone else's derivative.
 *
 * The owner always may — `remixPermission` answers `owner` for them — because Requirement 7
 * already gives an owner Edit_Tasks over their own assets and 14.9 is about *other* users.
 */

import { isDiscoverable, type FeedAssetSummary } from './feed';

export type RemixPermission =
  /** The requester owns it; Requirement 7 governs, not 14.9. */
  | 'owner'
  /** 14.9's three conditions all hold. */
  | 'allowed'
  /** Public, but the owner did not permit remixing. */
  | 'remix_not_permitted'
  /** Not published, deleted, or excluded by review — indistinguishable to a stranger. */
  | 'not_public';

export interface RemixSubject extends FeedAssetSummary {
  /** Requirement 14.9's flag, set when the owner publishes. */
  readonly remixAllowed: boolean;
}

export function remixPermission(
  asset: RemixSubject,
  requesterId: string | null,
): RemixPermission {
  if (requesterId !== null && asset.ownerId === requesterId) return 'owner';
  if (!isDiscoverable(asset)) return 'not_public';
  return asset.remixAllowed ? 'allowed' : 'remix_not_permitted';
}

/** Whether an Edit_Task naming this asset as its source may be created by the requester. */
export function mayRemix(asset: RemixSubject, requesterId: string | null): boolean {
  const permission = remixPermission(asset, requesterId);
  return permission === 'owner' || permission === 'allowed';
}
