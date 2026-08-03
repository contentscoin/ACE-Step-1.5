/**
 * What a public link shows (Requirement 14.3).
 *
 * > 자산 제목, 캡션, 오디오 재생, AI 생성 표기
 *
 * Four things, and the type has exactly four groups, so a page cannot be assembled with one
 * of them missing. The visitor is **unauthenticated**, which is the constraint that shapes
 * the rest: nothing here identifies the owner, and nothing carries a field the owner's own
 * library shows. A public page that leaked the owner's account id would make publishing one
 * asset publish a little of everything else they own.
 *
 * ### Why the AI notice is a list of obligations rather than a string
 *
 * Requirement 16.5 owns the AI-generation label and 16.13 the additional "합성 음성" notice
 * on a `dialogue` asset, and **task 8.3 owns both** — including the wording and the mapping
 * from Asset_Kind to obligation (`services/moderation/disclosure-port.ts` says so in as many
 * words). Writing a label here would be a second mapping to keep in step. The page therefore
 * carries the *obligations* the `DisclosurePort` reports, and 8.3's presenter renders them.
 */

import type { AssetKind } from '../../domain/asset-kind';
import type { DisclosureObligation } from '../moderation/disclosure-port';

export interface PublicAssetPage {
  /** 제목. */
  readonly title: string;
  /** 캡션. Empty string when the asset has none; never omitted. */
  readonly caption: string;
  /** 오디오 재생 — what a player needs, and nothing that identifies the owner. */
  readonly playback: {
    readonly assetId: string;
    readonly durationMs: number;
    readonly assetKind: AssetKind;
    readonly isLoop: boolean;
  };
  /** AI 생성 표기 — Requirements 16.5, 16.13, rendered by task 8.3. */
  readonly disclosures: readonly DisclosureObligation[];
  readonly likeCount: number;
  readonly playCount: number;
  /** Requirement 14.9: whether a visitor may derive from this asset. */
  readonly remixAllowed: boolean;
  readonly publishedAtMs: number;
}

export interface PublicPageSource {
  readonly assetId: string;
  readonly name: string;
  readonly caption: string;
  readonly assetKind: AssetKind;
  readonly durationMs: number;
  readonly isLoop: boolean;
  readonly likeCount: number;
  readonly playCount: number;
  readonly remixAllowed: boolean;
  readonly publishedAtMs: number;
}

/**
 * Build the page.
 *
 * A function rather than an object literal at the call site, so the four groups Requirement
 * 14.3 names are assembled in one place and a caller cannot quietly add a fifth field from
 * the owner's record.
 */
export function publicAssetPage(
  source: PublicPageSource,
  disclosures: readonly DisclosureObligation[],
): PublicAssetPage {
  return {
    title: source.name,
    caption: source.caption,
    playback: {
      assetId: source.assetId,
      durationMs: source.durationMs,
      assetKind: source.assetKind,
      isLoop: source.isLoop,
    },
    disclosures: [...disclosures],
    likeCount: source.likeCount,
    playCount: source.playCount,
    remixAllowed: source.remixAllowed,
    publishedAtMs: source.publishedAtMs,
  };
}
