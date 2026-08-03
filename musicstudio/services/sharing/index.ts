/**
 * Sharing_Service (Requirement 14, design §4.1).
 *
 * Publication is a row, not a flag; "public" is one predicate (`isDiscoverable`) used by
 * every surface including the three other services' visibility ports; a like is a set
 * member, which is what makes Property 20 true of the data rather than of a check.
 */

export { createSharingService, type PublishResult, type SharingServiceOptions } from './sharing-service';
export { publicAssetPage, type PublicAssetPage, type PublicPageSource } from './public-page';
export { cryptoShareTokenSource } from './share-token';
export {
  moderationPublicAssetPort,
  playbackVisibilityPort,
  voiceAssetVisibilityPort,
  type SharingVisibilitySource,
} from './visibility-adapters';
export type {
  LikeStore,
  ShareStore,
  ShareTokenSource,
  ShareableAsset,
  SharingAuditPort,
  SoundPackShare,
  SoundPackShareStore,
} from './ports';
export {
  sharingAssetForbidden,
  sharingAssetNotFound,
  sharingAssetNotPublic,
  sharingFeedQueryInvalid,
  sharingLinkNotFound,
  sharingRemixNotPermitted,
  sharingSoundPackForbidden,
  sharingSoundPackNotFound,
} from './errors';
