/**
 * The Sharing_Service's rejections.
 *
 * Two decisions, both about *what a stranger learns*:
 *
 * - **A bad share link is 404 and says nothing else.** Requirement 14.4 fixes 404 for a
 *   revoked link, and never-published, soft-deleted and withheld are answered identically.
 *   A distinct code per state would let anyone holding a stale link watch an asset move
 *   through moderation.
 * - **Publishing someone else's asset is 403**, following Requirement 11.9. The requester is
 *   authenticated and acting on their own library's surface, where 11.9 has already settled
 *   that a foreign asset is 403 rather than 404. The stranger-facing paths above are the
 *   ones where that trade-off comes out the other way.
 */

import type { FeedQueryViolation } from '../../domain/sharing/feed';
import { GenerationError } from '../generation/errors';

/** Requirement 14.4, and every other reason a link resolves to nothing. */
export function sharingLinkNotFound(): GenerationError {
  return new GenerationError(404, 'sharing_link_not_found', 'No such public page.');
}

export function sharingAssetNotFound(assetId: string): GenerationError {
  return new GenerationError(404, 'sharing_asset_not_found', 'No such Audio_Asset.', { assetId });
}

/** Requirements 14.2, 14.4 with Requirement 11.9's status code. */
export function sharingAssetForbidden(assetId: string): GenerationError {
  return new GenerationError(
    403,
    'sharing_asset_forbidden',
    'This Audio_Asset belongs to another account.',
    { assetId },
  );
}

/** Requirement 14.7 — 좋아요 is defined over a 공개 Audio_Asset. */
export function sharingAssetNotPublic(assetId: string): GenerationError {
  return new GenerationError(404, 'sharing_asset_not_public', 'No such public Audio_Asset.', {
    assetId,
  });
}

/** Requirement 14.9. Carries nothing about the asset beyond the refusal. */
export function sharingRemixNotPermitted(assetId: string): GenerationError {
  return new GenerationError(
    403,
    'sharing_remix_not_permitted',
    'This Audio_Asset does not permit remote remixing.',
    { assetId },
  );
}

export function sharingFeedQueryInvalid(
  violations: readonly FeedQueryViolation[],
): GenerationError {
  return new GenerationError(400, 'sharing_feed_query_invalid', 'The feed query is not valid.', {
    violations,
  });
}

export function sharingSoundPackNotFound(soundPackId: string): GenerationError {
  return new GenerationError(404, 'sharing_sound_pack_not_found', 'No such Sound_Pack.', {
    soundPackId,
  });
}

export function sharingSoundPackForbidden(soundPackId: string): GenerationError {
  return new GenerationError(
    403,
    'sharing_sound_pack_forbidden',
    'This Sound_Pack belongs to another account.',
    { soundPackId },
  );
}
