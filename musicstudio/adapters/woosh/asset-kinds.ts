/**
 * What a Woosh engine produces (design §3.6).
 *
 * `sfx` only. Design §3.6 lists Woosh under that one Asset_Kind, and Requirement 20.6 routes
 * by the declared list — so declaring more would make Woosh a candidate for work it cannot
 * do, and declaring it here rather than inline keeps the descriptor and any test that builds
 * one reading the same list.
 */

import type { AssetKind } from '../../domain/asset-kind';

export const ASSET_KINDS_FOR_WOOSH: readonly AssetKind[] = ['sfx'];
