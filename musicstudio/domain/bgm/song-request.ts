/**
 * Background music, expressed as the Custom_Mode song request the engine understands.
 *
 * This is the whole of the "reuse rather than duplicate" decision, in one function.
 * A `bgm` generation is a Custom_Mode song generation with the vocal side pinned shut:
 * the caption carries mood, scene and instrumentation, `instrumental` is true, and the
 * lyrics field therefore becomes Requirement 4.9's indicator (`INSTRUMENTAL_LYRICS`).
 * So Requirement 21 needs no second gateway, no second validator and no second wire
 * mapping — `SongGateway` with `assetKind: 'bgm'` and `adapters/ace/` do all of it.
 *
 * Requirement 21.4 is satisfied structurally rather than by assertion: `instrumental`
 * is a literal `true` here and `BgmParameters` has no lyrics field to leak one, so no
 * caller can construct a `bgm` request with vocals.
 *
 * `batchSize` is fixed at 1. Requirement 21.9's several variants are several requests
 * with different intensity targets, not one batch — a batch would share a single set of
 * parameters and could not carry a per-variant loudness target or intensity step.
 */

import { INSTRUMENTAL_LYRICS, type CustomModeSongRequest } from '../song/request';

import type { BgmParameters } from './request';

export interface BgmSongRequestOptions {
  /**
   * Seed for this attempt.
   *
   * Requirement 21.18 requires *different* seeds across the three loop attempts, so
   * the seed is an argument of the attempt rather than a property of the request.
   */
  readonly seed?: number;
}

export function bgmSongRequest(
  parameters: BgmParameters,
  options: BgmSongRequestOptions = {},
): CustomModeSongRequest {
  const seed = options.seed ?? parameters.seed;

  return {
    mode: 'custom',
    caption: parameters.caption,
    // Requirement 21.4. Both halves: the flag, and the indicator it puts in the
    // lyrics field, stated explicitly so the wire form is visible at this seam.
    instrumental: true,
    lyrics: INSTRUMENTAL_LYRICS,
    durationSeconds: parameters.targetLengthSeconds,
    batchSize: 1,
    ...(parameters.bpm === undefined ? {} : { bpm: parameters.bpm }),
    ...(parameters.keyScale === undefined ? {} : { keyScale: parameters.keyScale }),
    ...(parameters.timeSignature === undefined
      ? {}
      : { timeSignature: parameters.timeSignature }),
    ...(seed === undefined ? {} : { seed }),
  };
}
