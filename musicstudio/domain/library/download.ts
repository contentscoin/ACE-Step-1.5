/**
 * What a download may be: format, entitlement, file name (Requirements 13.1–13.9).
 *
 * The format sets mirror `dsp/src/musicstudio_dsp/formats.py` exactly, and
 * `test/unit/library/schema-parity.test.ts` fails if they drift. They are restated on this
 * side rather than fetched from the worker because 13.2, 13.4 and 13.9 are all decided
 * *before* a conversion is queued — a refusal that had to wait for a Celery round trip
 * would answer minutes after the user asked.
 */

import type { AssetKind } from '../asset-kind';

export const DOWNLOAD_FORMATS = ['mp3', 'wav', 'flac', 'ogg'] as const;
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];

/** Requirement 13.2 — offered for every Asset_Kind. */
export const COMMON_DOWNLOAD_FORMATS = ['mp3', 'wav', 'flac'] as const;

/** Requirement 13.9 — `sfx` additionally offers ogg. */
export const SFX_DOWNLOAD_FORMATS = ['mp3', 'wav', 'flac', 'ogg'] as const;

/** Requirement 13.4's gate. */
export const LOSSLESS_FORMATS = ['wav', 'flac'] as const;

export function isDownloadFormat(value: unknown): value is DownloadFormat {
  return typeof value === 'string' && (DOWNLOAD_FORMATS as readonly string[]).includes(value);
}

export function isLosslessFormat(format: DownloadFormat): boolean {
  return (LOSSLESS_FORMATS as readonly string[]).includes(format);
}

/**
 * Requirements 13.2, 13.8 and 13.9: what this kind may be downloaded as.
 *
 * 13.8 requires the *same* behaviour for all six kinds and 13.9 then names one extra format
 * for `sfx`. They are not in tension: the behaviour — offer a set, convert into it — is the
 * same, and the set differs by one entry.
 */
export function downloadFormatsFor(assetKind: AssetKind): readonly DownloadFormat[] {
  return assetKind === 'sfx' ? SFX_DOWNLOAD_FORMATS : COMMON_DOWNLOAD_FORMATS;
}

export type DownloadRefusalCode =
  | 'download_format_unknown'
  | 'download_format_unsupported_for_kind'
  | 'download_lossless_not_entitled';

export interface DownloadRuling {
  readonly allowed: boolean;
  readonly refusal?: DownloadRefusalCode;
  /** Requirement 13.4: "필요한 요금제를 반환한다". */
  readonly requiredPlanIds?: readonly string[];
  readonly offeredFormats?: readonly DownloadFormat[];
}

export interface DownloadRequestFacts {
  readonly assetKind: AssetKind;
  readonly format: unknown;
  /** Whether the requester's plan includes lossless download (Requirement 13.4). */
  readonly losslessEntitled: boolean;
  /** The plans that do, named in the refusal so the answer is actionable. */
  readonly losslessPlanIds: readonly string[];
}

export function ruleOnDownload(facts: DownloadRequestFacts): DownloadRuling {
  if (!isDownloadFormat(facts.format)) {
    return {
      allowed: false,
      refusal: 'download_format_unknown',
      offeredFormats: downloadFormatsFor(facts.assetKind),
    };
  }

  const offered = downloadFormatsFor(facts.assetKind);
  if (!offered.includes(facts.format)) {
    return {
      allowed: false,
      refusal: 'download_format_unsupported_for_kind',
      offeredFormats: offered,
    };
  }

  // Requirement 13.4, checked after the format is known to be on offer: a plan is only
  // relevant to a format the kind actually has.
  if (isLosslessFormat(facts.format) && !facts.losslessEntitled) {
    return {
      allowed: false,
      refusal: 'download_lossless_not_entitled',
      requiredPlanIds: facts.losslessPlanIds,
      offeredFormats: offered.filter((format) => !isLosslessFormat(format)),
    };
  }

  return { allowed: true };
}

/**
 * Requirement 13.6: "파일 이름에 자산 제목과 자산 식별자를 포함한다".
 *
 * The title is sanitised rather than trusted. A title is user text and may hold a path
 * separator, a quote, or a control character; a download header built from it verbatim is
 * how a filename becomes a path traversal. Characters outside a conservative set collapse
 * to `-`, and the identifier — which is not user text — follows, so the requirement's two
 * components are both present even when the title sanitises to nothing.
 */
export function downloadFileName(
  title: string,
  assetId: string,
  format: DownloadFormat,
): string {
  const stem = sanitiseTitle(title);
  const label = stem === '' ? assetId : stem + ' (' + assetId + ')';
  return label + '.' + format;
}

function sanitiseTitle(title: string): string {
  return title
    .normalize('NFC')
    // Control characters first: invisible in a header, and able to terminate one.
    .replace(CONTROL_CHARACTERS, '')
    // Then anything outside letters, digits, hyphen, underscore and space. This is what
    // keeps a path separator or a quote out of a Content-Disposition filename.
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '-')
    .replace(/\s+/g, ' ')
    // Collapse the runs the substitution just made, and drop them from the ends. Without
    // this a title of pure punctuation survives as a row of hyphens, which is noise rather
    // than a title — and the identifier fallback below would never be reached.
    .replace(/-{2,}/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 80)
    .replace(/[-\s]+$/, '');
}

// Matching control characters is the point: they are what has to be removed before a title
// reaches a Content-Disposition header, so the rule's usual warning does not apply.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/** Requirement 13.5's stem archive, named by the source asset it was split from. */
export function stemArchiveFileName(sourceTitle: string, sourceAssetId: string): string {
  return downloadFileName(sourceTitle, sourceAssetId, 'mp3').replace(/\.mp3$/, '-stems.zip');
}
