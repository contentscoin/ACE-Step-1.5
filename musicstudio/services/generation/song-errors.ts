/**
 * The rejection Requirements 3.5, 3.8 and 4.6 describe.
 *
 * All three say the same thing in different words: refuse the request and tell the
 * caller what would have been accepted. So there is one error, carrying the list of
 * violations, each naming its field and its allowance as data. Requirement 3.8's
 * "return the supported language list" is satisfied by the `enum` allowance on the
 * `vocalLanguage` violation, which carries every accepted code.
 *
 * It is a `GenerationError`, so the gateway's existing error contract renders it
 * without a new branch, and `details` reaches the client inside the `error` object.
 */

import type { SongFieldViolation } from '../../domain/song/violation';
import { describeViolation } from '../../domain/song/violation';

import { GenerationError } from './errors';

export function songRequestInvalid(
  violations: readonly SongFieldViolation[],
): GenerationError {
  return new GenerationError(
    400,
    'song_request_invalid',
    violations.map(describeViolation).join('; '),
    { violations },
  );
}
