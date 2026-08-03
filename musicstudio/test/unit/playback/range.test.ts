import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  contentRangeHeader,
  planRangeResponse,
  rangeLength,
  resolveRange,
  unsatisfiableContentRangeHeader,
} from '../../../domain/playback/range';

/**
 * HTTP Range resolution.
 *
 * **Validates: Requirements 12.1, 12.2**
 *
 * The tests worth having here are the boundary ones, because every off-by-one in a range
 * implementation produces audio that plays — just with a missing or duplicated frame at the
 * seam. `end` is inclusive throughout, on the wire and in this module, and the cases below
 * pin each place that could quietly become exclusive.
 */

const LENGTH = 1_000;
const TYPE = 'audio/flac';

describe('resolveRange (Requirement 12.2)', () => {
  it('treats an absent or empty header as the whole object', () => {
    for (const header of [null, undefined, '', '   ']) {
      expect(resolveRange(header, LENGTH)).toEqual({ kind: 'whole' });
    }
  });

  it('resolves a closed range with an inclusive end', () => {
    expect(resolveRange('bytes=0-499', LENGTH)).toEqual({ kind: 'partial', start: 0, end: 499 });
    expect(rangeLength(resolveRange('bytes=0-499', LENGTH), LENGTH)).toBe(500);
  });

  it('resolves an open-ended range to the last byte', () => {
    expect(resolveRange('bytes=500-', LENGTH)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  it('resolves a suffix range as the last N bytes, not as a range ending at N', () => {
    expect(resolveRange('bytes=-500', LENGTH)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  it('clamps a suffix longer than the object rather than starting before zero', () => {
    expect(resolveRange('bytes=-5000', LENGTH)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('clamps a last byte past the end (RFC 7233: satisfiable if the first byte is)', () => {
    expect(resolveRange('bytes=900-9999', LENGTH)).toEqual({
      kind: 'partial',
      start: 900,
      end: 999,
    });
  });

  it('serves the single last byte', () => {
    expect(resolveRange('bytes=999-', LENGTH)).toEqual({ kind: 'partial', start: 999, end: 999 });
    expect(rangeLength(resolveRange('bytes=999-', LENGTH), LENGTH)).toBe(1);
  });

  it('refuses a first byte at or past the end', () => {
    expect(resolveRange('bytes=1000-', LENGTH)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange('bytes=1500-1600', LENGTH)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuses a zero-length suffix and any range against an empty object', () => {
    expect(resolveRange('bytes=-0', LENGTH)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuses an inverted range', () => {
    expect(resolveRange('bytes=500-100', LENGTH)).toEqual({ kind: 'unsatisfiable' });
  });

  it('reports a multi-range request as malformed rather than answering the first', () => {
    // See the module header: a multipart response is a different body shape, and answering
    // one of the ranges would be a quiet lie about what was served.
    expect(resolveRange('bytes=0-99,200-299', LENGTH)).toEqual({ kind: 'malformed' });
  });

  it('reports a unit it does not speak as malformed', () => {
    expect(resolveRange('items=0-99', LENGTH)).toEqual({ kind: 'malformed' });
    expect(resolveRange('bytes=', LENGTH)).toEqual({ kind: 'malformed' });
    expect(resolveRange('bytes=abc-def', LENGTH)).toEqual({ kind: 'malformed' });
  });
});

describe('planRangeResponse (Requirements 12.1, 12.2)', () => {
  it('answers a whole request with 200 and advertises range support', () => {
    const plan = planRangeResponse(null, LENGTH, TYPE);

    expect(plan.status).toBe(200);
    expect(plan.contentLength).toBe(LENGTH);
    expect(plan.headers['accept-ranges']).toBe('bytes');
    expect(plan.headers['content-range']).toBeUndefined();
  });

  it('advertises range support on the 200 too, which is how a client learns it may ask', () => {
    expect(planRangeResponse(null, LENGTH, TYPE).headers['accept-ranges']).toBe('bytes');
  });

  it('answers a partial request with 206 and a matching Content-Range', () => {
    const plan = planRangeResponse('bytes=200-399', LENGTH, TYPE);

    expect(plan.status).toBe(206);
    expect(plan.start).toBe(200);
    expect(plan.end).toBe(399);
    expect(plan.contentLength).toBe(200);
    expect(plan.headers['content-range']).toBe('bytes 200-399/1000');
    expect(plan.headers['content-length']).toBe('200');
  });

  it('answers an unsatisfiable request with 416 carrying the size', () => {
    const plan = planRangeResponse('bytes=5000-', LENGTH, TYPE);

    expect(plan.status).toBe(416);
    expect(plan.headers['content-range']).toBe('bytes */1000');
  });

  it('serves a malformed header whole, as RFC 7233 requires', () => {
    const plan = planRangeResponse('bytes=0-99,200-299', LENGTH, TYPE);

    expect(plan.status).toBe(200);
    expect(plan.contentLength).toBe(LENGTH);
  });

  it('formats the two Content-Range shapes', () => {
    expect(contentRangeHeader(0, 99, 1_000)).toBe('bytes 0-99/1000');
    expect(unsatisfiableContentRangeHeader(1_000)).toBe('bytes */1000');
  });
});

describe('range invariants', () => {
  it('never plans a window outside the object', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 120_000 }),
        fc.integer({ min: 0, max: 120_000 }),
        (length, first, last) => {
          const plan = planRangeResponse(
            `bytes=${String(first)}-${String(last)}`,
            length,
            TYPE,
          );
          if (plan.status === 416) return true;

          expect(plan.start).toBeGreaterThanOrEqual(0);
          expect(plan.end).toBeLessThanOrEqual(length - 1);
          expect(plan.contentLength).toBe(plan.end - plan.start + 1);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reports a content length that matches the Content-Range it sends', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        (length, first) => {
          const plan = planRangeResponse(`bytes=${String(first)}-`, length, TYPE);
          if (plan.status !== 206) return true;

          expect(plan.headers['content-range']).toBe(
            `bytes ${String(plan.start)}-${String(plan.end)}/${String(length)}`,
          );
          expect(plan.headers['content-length']).toBe(String(plan.contentLength));
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('serves the whole object across consecutive ranges, with nothing lost or repeated', () => {
    // The seam property a player depends on: chunk N ends exactly where chunk N+1 begins.
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 10_000 }),
        fc.integer({ min: 1, max: 512 }),
        (length, chunk) => {
          let cursor = 0;
          let served = 0;
          while (cursor < length) {
            const plan = planRangeResponse(
              `bytes=${String(cursor)}-${String(cursor + chunk - 1)}`,
              length,
              TYPE,
            );
            expect(plan.status).toBe(206);
            expect(plan.start).toBe(cursor);
            served += plan.contentLength;
            cursor = plan.end + 1;
          }
          expect(served).toBe(length);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
