/**
 * Requirement 24.7: every cue in a pack sits between −25 and −21 LUFS.
 *
 * The measurement is `maxShortTermLoudnessLufs` in `domain/audio/loudness.ts` — the
 * *maximum* of the 400 ms window values at 100 ms intervals, ungated, with a cue shorter
 * than one window measured whole. That module states why a maximum rather than the gated
 * integrated value of Requirement 30.24, and why it reuses the one K-weighting pass rather
 * than growing a second. This module is only the *judgement*: given the measured value and
 * the band in force, does the cue satisfy the clause.
 *
 * Split for the reason `domain/bgm/loop-seam.ts` is split from
 * `services/sound/in-process-measurement.ts`: the rule is pure and can be exercised over
 * stated numbers, so a test can pin "−25.0 exactly is inside the band" without synthesising
 * audio that happens to measure −25.0.
 *
 * Both ends are **inclusive** — 24.7 says "−25LUFS 이상 −21LUFS 이하" — and the band comes
 * from the Quality_Threshold_Set (`sound_pack_loudness_min` / `_max`), never from a literal
 * here, because Requirement 34.3 makes 24.7's numbers the set's *initial* values.
 *
 * A silent cue measures `-Infinity` and is therefore **too quiet**, not unmeasurable. That
 * is the right verdict and it is worth being explicit about: `-Infinity < min` is true, so
 * the arithmetic already reaches it, and a pack containing a silent cue fails 24.7 rather
 * than passing it on a technicality.
 */

import { maxShortTermLoudnessLufs } from '../audio/loudness';
import type { PcmAudio } from '../audio/pcm';
import type { PackLoudnessThresholds } from '../quality/sound-pack-thresholds';

import { PACK_LOUDNESS_HOP_MS, PACK_LOUDNESS_WINDOW_MS } from './bounds';

/** Where a cue's loudness sits relative to the band. */
export const PACK_LOUDNESS_VERDICTS = ['within', 'too_quiet', 'too_loud'] as const;

export type PackLoudnessPlacement = (typeof PACK_LOUDNESS_VERDICTS)[number];

export interface CueLoudnessVerdict {
  readonly cueName: string;
  /** Requirement 24.7's quantity. `-Infinity` for silence. */
  readonly maxShortTermLufs: number;
  readonly placement: PackLoudnessPlacement;
  readonly satisfied: boolean;
  readonly minLufs: number;
  readonly maxLufs: number;
  /** Requirement 34.6: the set the verdict was taken against. */
  readonly qualityThresholdSetVersion: number;
}

/** Requirement 24.7 for one cue, from an already-measured value. */
export function judgeCueLoudness(
  cueName: string,
  maxShortTermLufs: number,
  thresholds: PackLoudnessThresholds,
): CueLoudnessVerdict {
  const placement = placementOf(maxShortTermLufs, thresholds);
  return {
    cueName,
    maxShortTermLufs,
    placement,
    satisfied: placement === 'within',
    minLufs: thresholds.loudnessMinLufs,
    maxLufs: thresholds.loudnessMaxLufs,
    qualityThresholdSetVersion: thresholds.version,
  };
}

function placementOf(value: number, thresholds: PackLoudnessThresholds): PackLoudnessPlacement {
  // `Number.isNaN` first: a NaN measurement compares false against both bounds, so without
  // this it would fall through to `within` — a broken measurement reported as compliant.
  if (Number.isNaN(value)) return 'too_quiet';
  if (value < thresholds.loudnessMinLufs) return 'too_quiet';
  if (value > thresholds.loudnessMaxLufs) return 'too_loud';
  return 'within';
}

/**
 * Requirement 24.7 for one cue, measuring the buffer first.
 *
 * The window and interval are `bounds.ts`'s constants rather than arguments, because they
 * define *what is measured* and a caller free to change them could produce a verdict that
 * used the clause's threshold against a different quantity.
 */
export function measureAndJudgeCueLoudness(
  cueName: string,
  audio: PcmAudio,
  thresholds: PackLoudnessThresholds,
): CueLoudnessVerdict {
  return judgeCueLoudness(
    cueName,
    maxShortTermLoudnessLufs(audio, PACK_LOUDNESS_WINDOW_MS, PACK_LOUDNESS_HOP_MS),
    thresholds,
  );
}

export interface PackLoudnessVerdict {
  readonly satisfied: boolean;
  readonly cues: readonly CueLoudnessVerdict[];
  /** The cues outside the band, in cue order. Empty when satisfied. */
  readonly outside: readonly CueLoudnessVerdict[];
}

/**
 * Requirement 24.7 for a whole pack: an invariant, so *every* cue must satisfy it.
 *
 * Every cue is judged even after the first miss, rather than short-circuiting. 24.7 is
 * stated as an invariant over the pack, and a caller fixing an export wants the list of
 * offending cues, not the first one — the same reason `manifest.ts` returns every fault.
 */
export function evaluatePackLoudness(
  cues: readonly CueLoudnessVerdict[],
): PackLoudnessVerdict {
  const outside = cues.filter((cue) => !cue.satisfied);
  return { satisfied: outside.length === 0, cues, outside };
}
