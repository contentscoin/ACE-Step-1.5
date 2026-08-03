import { describe, expect, it } from 'vitest';

import {
  COMMON_DOWNLOAD_FORMATS,
  downloadFileName,
  downloadFormatsFor,
  isLosslessFormat,
  ruleOnDownload,
  SFX_DOWNLOAD_FORMATS,
  stemArchiveFileName,
} from '../../../domain/library/download';
import { ASSET_TAG_COUNT_MAX, ASSET_TAG_MAX_LENGTH } from '../../../domain/library/bounds';
import { normaliseTags, tagViolations } from '../../../domain/library/tags';
import {
  isPurgeDue,
  markDeleted,
  markRestored,
  retentionRemainingMs,
} from '../../../domain/library/retention';
import { SOFT_DELETE_RETENTION_MS } from '../../../domain/library/bounds';

/** Requirements 11.3, 11.6-11.8, 13.2, 13.4-13.6, 13.9. */

const ENTITLED = { losslessEntitled: true, losslessPlanIds: ['creator', 'studio'] };
const NOT_ENTITLED = { losslessEntitled: false, losslessPlanIds: ['creator', 'studio'] };

describe('download formats (Requirements 13.2, 13.8, 13.9)', () => {
  it('offers mp3, wav and flac for every kind', () => {
    for (const kind of ['song', 'bgm', 'dialogue', 'stem', 'mix'] as const) {
      expect(downloadFormatsFor(kind)).toEqual(COMMON_DOWNLOAD_FORMATS);
    }
  });

  it('offers ogg additionally for sfx (13.9)', () => {
    expect(downloadFormatsFor('sfx')).toEqual(SFX_DOWNLOAD_FORMATS);
    expect(downloadFormatsFor('sfx')).toContain('ogg');
  });

  it('refuses ogg for a kind that does not offer it, naming what is offered', () => {
    const ruling = ruleOnDownload({ assetKind: 'song', format: 'ogg', ...ENTITLED });
    expect(ruling.allowed).toBe(false);
    expect(ruling.refusal).toBe('download_format_unsupported_for_kind');
    expect(ruling.offeredFormats).toEqual(COMMON_DOWNLOAD_FORMATS);
  });

  it('refuses a format that is not a format at all', () => {
    expect(ruleOnDownload({ assetKind: 'song', format: 'aiff', ...ENTITLED }).refusal).toBe(
      'download_format_unknown',
    );
    expect(ruleOnDownload({ assetKind: 'song', format: 42, ...ENTITLED }).refusal).toBe(
      'download_format_unknown',
    );
  });
});

describe('lossless entitlement (Requirement 13.4)', () => {
  it('knows which two formats are gated', () => {
    expect(isLosslessFormat('wav')).toBe(true);
    expect(isLosslessFormat('flac')).toBe(true);
    expect(isLosslessFormat('mp3')).toBe(false);
  });

  it.each(['wav', 'flac'] as const)('refuses %s without the entitlement', (format) => {
    const ruling = ruleOnDownload({ assetKind: 'song', format, ...NOT_ENTITLED });
    expect(ruling.allowed).toBe(false);
    expect(ruling.refusal).toBe('download_lossless_not_entitled');
    // 13.4: "필요한 요금제를 반환한다".
    expect(ruling.requiredPlanIds).toEqual(['creator', 'studio']);
    // And what the caller *can* have instead.
    expect(ruling.offeredFormats).toEqual(['mp3']);
  });

  it('allows mp3 without the entitlement', () => {
    expect(ruleOnDownload({ assetKind: 'song', format: 'mp3', ...NOT_ENTITLED }).allowed).toBe(
      true,
    );
  });

  it('allows lossless with the entitlement', () => {
    expect(ruleOnDownload({ assetKind: 'song', format: 'flac', ...ENTITLED }).allowed).toBe(true);
  });

  it('reports an unsupported format before the plan, so a refusal is about one thing', () => {
    // ogg is not on offer for `song` *and* the caller is unentitled; the format wins,
    // because a plan upgrade would not make ogg appear.
    const ruling = ruleOnDownload({ assetKind: 'song', format: 'ogg', ...NOT_ENTITLED });
    expect(ruling.refusal).toBe('download_format_unsupported_for_kind');
  });
});

describe('download file name (Requirement 13.6)', () => {
  it('carries the title and the identifier', () => {
    expect(downloadFileName('Night Drive', 'asset-1', 'mp3')).toBe('Night Drive (asset-1).mp3');
  });

  it('falls back to the identifier when the title sanitises to nothing', () => {
    expect(downloadFileName('///', 'asset-1', 'mp3')).toBe('asset-1.mp3');
  });

  it('keeps a path separator out of the name', () => {
    const name = downloadFileName('../../etc/passwd', 'asset-1', 'wav');
    expect(name).not.toContain('/');
    expect(name).toContain('asset-1');
  });

  it('strips control characters', () => {
    // Written by code point rather than as a literal, so the source file stays printable
    // and the assertion does not need a control-character regex of its own.
    const title = ['a', String.fromCharCode(9), 'b', String.fromCharCode(0), 'c'].join('');
    const name = downloadFileName(title, 'asset-1', 'mp3');

    const codes = [...name].map((character) => character.charCodeAt(0));
    expect(codes.some((code) => code < 0x20 || code === 0x7f)).toBe(false);
    expect(name).toContain('asset-1');
  });

  it('keeps non-Latin titles rather than erasing them', () => {
    expect(downloadFileName('밤의 드라이브', 'asset-1', 'mp3')).toBe('밤의 드라이브 (asset-1).mp3');
  });

  it('names a stem archive after its source (13.5)', () => {
    expect(stemArchiveFileName('Night Drive', 'asset-1')).toBe('Night Drive (asset-1)-stems.zip');
  });
});

describe('tags (Requirement 11.3)', () => {
  it('normalises and de-duplicates, keeping first-seen order', () => {
    expect(normaliseTags([' Lo-Fi ', 'CHILL', 'lo-fi'])).toEqual(['lo-fi', 'chill']);
  });

  it('accepts a set at the ceiling', () => {
    const tags = Array.from({ length: ASSET_TAG_COUNT_MAX }, (_, index) => `tag-${String(index)}`);
    expect(tagViolations(tags)).toEqual([]);
  });

  it('rejects one tag too many, counted after de-duplication', () => {
    const tags = Array.from(
      { length: ASSET_TAG_COUNT_MAX + 1 },
      (_, index) => `tag-${String(index)}`,
    );
    expect(tagViolations(tags).map((v) => v.violation)).toContain('tag_count_exceeded');

    // The same list with a duplicate instead of a distinct tag is inside the ceiling.
    const withDuplicate = [...tags.slice(0, ASSET_TAG_COUNT_MAX), 'tag-0'];
    expect(tagViolations(withDuplicate)).toEqual([]);
  });

  it('rejects an empty tag and one past the length ceiling', () => {
    const violations = tagViolations(['  ', 'x'.repeat(ASSET_TAG_MAX_LENGTH + 1)]);
    expect(violations.map((v) => v.violation)).toEqual(['tag_empty', 'tag_too_long']);
  });

  it('rejects a value that is not a string', () => {
    expect(tagViolations([7]).map((v) => v.violation)).toEqual(['tag_not_a_string']);
  });
});

describe('soft deletion (Requirements 11.6, 11.8)', () => {
  const DELETED_AT = 1_700_000_000_000;

  it('records the mark time', () => {
    expect(markDeleted(DELETED_AT)).toEqual({ isDeleted: true, deletedAtMs: DELETED_AT });
  });

  it('clears the mark on restore', () => {
    expect(markRestored()).toEqual({ isDeleted: false, deletedAtMs: null });
  });

  it('is not due one millisecond early, and is due at the boundary', () => {
    const state = markDeleted(DELETED_AT);
    expect(isPurgeDue(state, DELETED_AT + SOFT_DELETE_RETENTION_MS - 1)).toBe(false);
    expect(isPurgeDue(state, DELETED_AT + SOFT_DELETE_RETENTION_MS)).toBe(true);
  });

  it('is never due for an asset that is not marked', () => {
    expect(isPurgeDue({ isDeleted: false, deletedAtMs: null }, Number.MAX_SAFE_INTEGER)).toBe(
      false,
    );
    expect(retentionRemainingMs({ isDeleted: false, deletedAtMs: null }, 0)).toBeNull();
  });

  it('reports the remaining window, floored at zero', () => {
    const state = markDeleted(DELETED_AT);
    expect(retentionRemainingMs(state, DELETED_AT)).toBe(SOFT_DELETE_RETENTION_MS);
    expect(retentionRemainingMs(state, DELETED_AT + SOFT_DELETE_RETENTION_MS * 2)).toBe(0);
  });
});
