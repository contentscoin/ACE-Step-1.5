/**
 * Reading song parameters off a normalised request.
 *
 * A request that came through the Simple/Custom song gateway carries a validated
 * `song` block, and that is the case the adapter is built for. A request that came
 * through the generic `/generation-jobs` endpoint carries only the fields every
 * engine has — a prompt, a length, a seed — so this module translates those into
 * the same shape rather than refusing them.
 *
 * The translation is a Simple_Mode request: a free-text prompt with no musical
 * metadata is precisely what Requirement 3.1's `sample_mode` + `sample_query` pair
 * expresses, and it lets the engine derive the caption, lyrics and metadata as
 * Requirement 3.4 describes. Nothing is invented — an absent length stays absent
 * (Requirement 3.3) and an absent seed stays random (Requirement 4.10).
 */

import type { NormalizedGenerationRequest } from '../normalized-generation';
import type { SongParameters } from '../../domain/song/request';

export function songParametersOf(request: NormalizedGenerationRequest): SongParameters {
  return request.song ?? fallbackParameters(request);
}

function fallbackParameters(request: NormalizedGenerationRequest): SongParameters {
  const durationSeconds = request.durationMs > 0 ? request.durationMs / 1000 : undefined;
  const seed = typeof request.seed === 'number' && request.seed >= 0 ? request.seed : undefined;

  return {
    mode: 'simple',
    sampleMode: true,
    thinking: true,
    instrumental: false,
    batchSize: 1,
    ...(request.prompt === undefined || request.prompt === ''
      ? {}
      : { description: request.prompt }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(seed === undefined ? {} : { seed }),
  };
}
