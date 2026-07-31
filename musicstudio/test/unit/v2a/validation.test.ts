import { describe, expect, it } from 'vitest';

import {
  V2A_DURATION_MS_MAX,
  V2A_DURATION_MS_MIN,
  V2A_FILE_SIZE_BYTES_MAX,
  V2A_FRAME_RATE_MAX,
  V2A_FRAME_RATE_MIN,
  V2A_SHORT_SIDE_MIN_PX,
  V2A_VARIANT_COUNT_MAX,
  V2A_VARIANT_COUNT_MIN,
} from '../../../domain/v2a/bounds';
import {
  V2A_UPLOAD_CONSTRAINTS,
  V2A_UPLOAD_CONSTRAINT_REQUIREMENT,
  validateV2aUpload,
  validateV2aVariantCount,
} from '../../../domain/v2a/validation';
import { shortSidePx, sourceFrameCount } from '../../../domain/v2a/video-metadata';
import { validVideoMetadata } from '../../support/v2a-synthesis';

/**
 * Foley upload validation — Requirement 23's gate on what can be processed at all.
 *
 * **Validates: Requirements 23.1, 23.2, 23.3, 23.4**
 *
 * Every case is stated over a probed metadata record rather than a file, which is the design
 * decision `domain/v2a/video-metadata.ts` documents: there is no decoder in this environment (task
 * 3.1's DSP worker owns real probing), and 23.2/23.3 are seven numeric and enumerated constraints
 * that need none.
 *
 * The "해당 업로드 파일을 저장하지 않는다" half of 23.4 is an effect and is asserted in
 * `v2a-service.test.ts`, where the discard is observable.
 */

function constraintsOf(overrides: Parameters<typeof validVideoMetadata>[0]): readonly string[] {
  const result = validateV2aUpload(validVideoMetadata(overrides));
  return result.kind === 'invalid' ? result.constraints : [];
}

describe('a compliant upload (Requirements 23.2, 23.3)', () => {
  it('accepts a record inside every bound and hands the metadata back', () => {
    const metadata = validVideoMetadata();
    const result = validateV2aUpload(metadata);

    expect(result.kind).toBe('valid');
    if (result.kind !== 'valid') return;
    expect(result.metadata).toBe(metadata);
  });

  it('accepts every boundary value, since 23.2 and 23.3 are inclusive ranges', () => {
    for (const overrides of [
      { frameRate: V2A_FRAME_RATE_MIN },
      { frameRate: V2A_FRAME_RATE_MAX },
      { widthPx: V2A_SHORT_SIDE_MIN_PX, heightPx: V2A_SHORT_SIDE_MIN_PX },
      { durationMs: V2A_DURATION_MS_MIN },
      { durationMs: V2A_DURATION_MS_MAX },
      { fileSizeBytes: V2A_FILE_SIZE_BYTES_MAX },
    ]) {
      expect(validateV2aUpload(validVideoMetadata(overrides)).kind).toBe('valid');
    }
  });

  it('accepts each accepted container and refuses one that merely looks like one', () => {
    for (const container of ['mp4', 'mov', 'webm']) {
      expect(validateV2aUpload(validVideoMetadata({ container })).kind).toBe('valid');
    }
    // The case 23.4 exists for: a probe reporting the container it actually found.
    expect(constraintsOf({ container: 'mkv' })).toEqual(['container']);
    expect(constraintsOf({ container: 'MP4' })).toEqual(['container']);
  });

  it('accepts a fractional broadcast frame rate', () => {
    for (const frameRate of [23.976, 29.97, 59.94]) {
      expect(validateV2aUpload(validVideoMetadata({ frameRate })).kind).toBe('valid');
    }
  });
});

describe('each constraint refuses on its own (Requirements 23.2, 23.3, 23.4)', () => {
  it('names the container', () => {
    expect(constraintsOf({ container: 'avi' })).toEqual(['container']);
  });

  it('names the video stream count — an audio-only mp4 is a legal mp4', () => {
    expect(constraintsOf({ videoStreamCount: 0 })).toEqual(['videoStreamCount']);
  });

  it('names the frame rate below and above its window', () => {
    expect(constraintsOf({ frameRate: V2A_FRAME_RATE_MIN - 1 })).toEqual(['frameRate']);
    expect(constraintsOf({ frameRate: V2A_FRAME_RATE_MAX + 1 })).toEqual(['frameRate']);
  });

  it('judges the short side, so a portrait clip is not judged by its height', () => {
    // 1080×120: the long side is far over the floor and the short side is under it.
    expect(constraintsOf({ widthPx: 1080, heightPx: 120 })).toEqual(['shortSidePx']);
    expect(constraintsOf({ widthPx: 120, heightPx: 1080 })).toEqual(['shortSidePx']);
    expect(shortSidePx(validVideoMetadata({ widthPx: 1080, heightPx: 120 }))).toBe(120);
  });

  it('names the duration below and above its window', () => {
    expect(constraintsOf({ durationMs: V2A_DURATION_MS_MIN - 1 })).toEqual(['durationMs']);
    expect(constraintsOf({ durationMs: V2A_DURATION_MS_MAX + 1 })).toEqual(['durationMs']);
  });

  it('names the file size', () => {
    expect(constraintsOf({ fileSizeBytes: V2A_FILE_SIZE_BYTES_MAX + 1 })).toEqual([
      'fileSizeBytes',
    ]);
  });
});

describe('23.4 reports every violation, not the first', () => {
  it('reports both limits a 90-second 4K phone clip breaks', () => {
    const result = validateV2aUpload(
      validVideoMetadata({ durationMs: 90_000, fileSizeBytes: 400_000_000 }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toEqual(['durationMs', 'fileSizeBytes']);
    expect(result.violations.map((violation) => violation.field)).toEqual([
      'durationMs',
      'fileSizeBytes',
    ]);
  });

  it('reports them in the order 23.2 then 23.3 lists them, whatever the record says', () => {
    const result = validateV2aUpload(
      validVideoMetadata({
        container: 'mkv',
        videoStreamCount: 0,
        frameRate: 4,
        widthPx: 64,
        heightPx: 64,
        durationMs: 100,
        fileSizeBytes: V2A_FILE_SIZE_BYTES_MAX * 2,
      }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.constraints).toEqual([...V2A_UPLOAD_CONSTRAINTS]);
  });

  it('carries the measured value and the permitted range 23.4 asks for', () => {
    const result = validateV2aUpload(validVideoMetadata({ durationMs: 90_000 }));

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    const violation = result.violations[0];
    expect(violation?.received).toBe(90_000);
    expect(violation?.allowed).toEqual({
      kind: 'range',
      min: V2A_DURATION_MS_MIN,
      max: V2A_DURATION_MS_MAX,
      integer: false,
    });
  });

  it('maps every constraint to the clause it comes from', () => {
    expect(V2A_UPLOAD_CONSTRAINT_REQUIREMENT).toEqual({
      container: '23.2',
      videoStreamCount: '23.2',
      frameRate: '23.2',
      shortSidePx: '23.2',
      durationMs: '23.3',
      fileSizeBytes: '23.3',
    });
  });
});

describe('an unusable measurement is a violation, not an exception', () => {
  it('treats a non-finite frame rate as a frame-rate violation', () => {
    expect(constraintsOf({ frameRate: Number.NaN })).toEqual(['frameRate']);
    expect(constraintsOf({ frameRate: Number.POSITIVE_INFINITY })).toEqual(['frameRate']);
  });

  it('treats a non-finite duration as a duration violation', () => {
    expect(constraintsOf({ durationMs: Number.NaN })).toEqual(['durationMs']);
  });

  it('refuses a negative size rather than reading it as small', () => {
    expect(constraintsOf({ fileSizeBytes: -1 })).toEqual(['fileSizeBytes']);
  });
});

describe('derived frame count (Requirement 23.6s input)', () => {
  it('is the duration times the rate, rounded', () => {
    expect(sourceFrameCount(validVideoMetadata({ durationMs: 4_000, frameRate: 30 }))).toBe(120);
    expect(sourceFrameCount(validVideoMetadata({ durationMs: 500, frameRate: 23.976 }))).toBe(12);
  });

  it('never reports an empty source, since every sampled index would then be out of range', () => {
    expect(sourceFrameCount(validVideoMetadata({ durationMs: 0, frameRate: 30 }))).toBe(1);
  });
});

describe('the variant cap (Requirement 23.1)', () => {
  it('accepts every count 23.1 permits, and an omitted one', () => {
    expect(validateV2aVariantCount(undefined).kind).toBe('valid');
    for (let count = V2A_VARIANT_COUNT_MIN; count <= V2A_VARIANT_COUNT_MAX; count += 1) {
      expect(validateV2aVariantCount(count).kind).toBe('valid');
    }
  });

  it('refuses a count outside 1–4 with the input and the range', () => {
    const result = validateV2aVariantCount(V2A_VARIANT_COUNT_MAX + 1);

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.violations[0]).toEqual({
      field: 'variantCount',
      received: V2A_VARIANT_COUNT_MAX + 1,
      allowed: {
        kind: 'range',
        min: V2A_VARIANT_COUNT_MIN,
        max: V2A_VARIANT_COUNT_MAX,
        integer: true,
      },
    });
  });

  it('refuses zero and a fractional count', () => {
    expect(validateV2aVariantCount(0).kind).toBe('invalid');
    expect(validateV2aVariantCount(2.5).kind).toBe('invalid');
  });
});
