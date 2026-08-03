/**
 * HTTP Range, parsed and resolved (Requirement 12.2, design §2.3).
 *
 * Requirement 12.2 asks for "임의 위치부터의 재생", and 12.3 gives it a one-second budget.
 * Both are properties of *not reading the whole object*: a service that answered a range by
 * fetching everything and slicing would satisfy neither on a five-minute file. So a range is
 * resolved to a byte window here, before any storage call, and the port receives the window
 * rather than the header.
 *
 * Only `bytes` ranges, and only a single one. RFC 7233 permits several, and a multipart
 * response is a different content type with a different body shape; nothing in Requirement
 * 12 asks for it, and answering the first range instead would be a quiet lie about what was
 * served. A multi-range request is therefore refused rather than partially honoured.
 */

export type RangeResolution =
  | { readonly kind: 'whole' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' }
  | { readonly kind: 'malformed' };

/** `bytes=` followed by one `first-last`, `first-`, or `-suffix`. */
const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolve a `Range` header against a known content length.
 *
 * `end` is **inclusive**, as it is on the wire and in `Content-Range`. Converting to an
 * exclusive bound here would mean every caller converted back, and the off-by-one would
 * live in whichever one forgot.
 */
export function resolveRange(header: string | null | undefined, length: number): RangeResolution {
  if (header == null || header.trim() === '') return { kind: 'whole' };
  if (!Number.isInteger(length) || length < 0) return { kind: 'malformed' };

  const match = SINGLE_BYTE_RANGE.exec(header.trim());
  if (match === null) {
    // Either a unit this service does not speak, or several ranges. See the header.
    return { kind: 'malformed' };
  }

  const [, rawFirst = '', rawLast = ''] = match;
  if (rawFirst === '' && rawLast === '') return { kind: 'malformed' };

  // A suffix range — `bytes=-500` — is the last N bytes, not a range ending at N.
  if (rawFirst === '') {
    const suffix = Number(rawLast);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    if (length === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, length - suffix);
    return { kind: 'partial', start, end: length - 1 };
  }

  const start = Number(rawFirst);
  if (length === 0 || start >= length) return { kind: 'unsatisfiable' };

  // An open-ended range runs to the end of the object, and a `last` past the end is
  // clamped rather than refused: RFC 7233 says a range is satisfiable if its first byte is.
  const end = rawLast === '' ? length - 1 : Math.min(Number(rawLast), length - 1);
  if (end < start) return { kind: 'unsatisfiable' };

  return { kind: 'partial', start, end };
}

/** Bytes a resolved window covers. */
export function rangeLength(resolution: RangeResolution, contentLength: number): number {
  switch (resolution.kind) {
    case 'whole':
      return contentLength;
    case 'partial':
      return resolution.end - resolution.start + 1;
    default:
      return 0;
  }
}

/** The `Content-Range` a 206 carries. */
export function contentRangeHeader(start: number, end: number, length: number): string {
  return `bytes ${String(start)}-${String(end)}/${String(length)}`;
}

/** The `Content-Range` a 416 carries — the size, and nothing satisfied. */
export function unsatisfiableContentRangeHeader(length: number): string {
  return `bytes */${String(length)}`;
}

export interface RangeResponsePlan {
  readonly status: 200 | 206 | 416;
  readonly start: number;
  readonly end: number;
  readonly contentLength: number;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * What to answer, as a whole: status, window and headers.
 *
 * One function so that a route cannot pair a 206 with a missing `Content-Range`, or answer
 * 200 while having read only part of the object. `Accept-Ranges` is on every response,
 * including the 200 — that is how a client learns it may ask for a range at all, and
 * Requirement 12.2 is only reachable by a client that knows.
 */
export function planRangeResponse(
  header: string | null | undefined,
  contentLength: number,
  contentType: string,
): RangeResponsePlan {
  const resolution = resolveRange(header, contentLength);

  if (resolution.kind === 'partial') {
    const length = rangeLength(resolution, contentLength);
    return {
      status: 206,
      start: resolution.start,
      end: resolution.end,
      contentLength: length,
      headers: {
        'accept-ranges': 'bytes',
        'content-type': contentType,
        'content-length': String(length),
        'content-range': contentRangeHeader(resolution.start, resolution.end, contentLength),
      },
    };
  }

  if (resolution.kind === 'unsatisfiable') {
    return {
      status: 416,
      start: 0,
      end: -1,
      contentLength: 0,
      headers: {
        'accept-ranges': 'bytes',
        'content-range': unsatisfiableContentRangeHeader(contentLength),
      },
    };
  }

  // `malformed` is served whole. RFC 7233: a recipient that cannot understand a Range
  // header ignores it. Refusing would break a client over a header it may not have meant.
  return {
    status: 200,
    start: 0,
    end: Math.max(0, contentLength - 1),
    contentLength,
    headers: {
      'accept-ranges': 'bytes',
      'content-type': contentType,
      'content-length': String(contentLength),
    },
  };
}
