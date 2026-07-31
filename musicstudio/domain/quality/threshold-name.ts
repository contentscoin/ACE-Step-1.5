/**
 * The members of the Quality_Threshold_Set (Requirement 34.1).
 *
 * 34.1 enumerates the perceptual judgements that must be *adjustable* rather than
 * compiled in, and the requirements appendix restates the point: the numbers quoted
 * in Requirements 21, 22, 23, 24 and 30 are this set's **initial values**, not
 * constants. So no service may inline them — each reads its threshold from the set
 * and records the set's version alongside whatever it admitted (34.6).
 *
 * Two modelling decisions are worth stating, because 34.1's prose does not settle
 * them and 34.2 forces the question:
 *
 * 1. **A range is two members.** 34.1 names "사운드 팩 라우드니스 허용 범위" as one
 *    item, but 34.2 gives every threshold exactly one current value and one allowed
 *    adjustment range. A single member cannot hold a low and a high bound and still
 *    answer 34.2, so the pack loudness window is `sound_pack_loudness_min` and
 *    `sound_pack_loudness_max`. The set is still "1개" in 34.1's sense: one set, one
 *    version.
 * 2. **Bar alignment tolerance is a member.** Requirement 21.6 lists 마디 정합 as one
 *    of the four loop-seam criteria and design §5.3 gives it a number (±25 ms), yet
 *    34.1's enumeration omits it while listing the other three. Treating it as a
 *    constant would leave one of four co-equal criteria unadjustable, so it is
 *    included here as `loop_bar_alignment_tolerance_ms`.
 *    **Open question for the spec:** whether 34.1's list is exhaustive or
 *    illustrative. If exhaustive, this member and the requirement disagree.
 */

export const QUALITY_THRESHOLD_NAMES = [
  /** Requirement 21.7 — loop seam RMS difference ceiling, per channel. */
  'loop_seam_rms_difference_max',
  /** Requirement 21.8 — loop seam sample step, as a fraction of channel peak. */
  'loop_seam_sample_step_ratio_max',
  /** Requirement 21.16 — loop edge energy floor, relative to overall RMS. */
  'loop_edge_energy_floor',
  /** Requirement 21.17 — bar-alignment error budget. See note 2 above. */
  'loop_bar_alignment_tolerance_ms',
  /** Requirement 22.15 — one-shot tail amplitude, as a fraction of peak. */
  'one_shot_tail_amplitude_ratio_max',
  /** Requirement 24.7 — sound pack loudness window. See note 1 above. */
  'sound_pack_loudness_min',
  'sound_pack_loudness_max',
  /** Requirement 24.9 — cue-pair timbral similarity ceiling. */
  'cue_pair_similarity_max',
  /** Requirement 23.8 — onset alignment tolerance. */
  'v2a_onset_alignment_tolerance_ms',
  /** Requirement 23.8 — fraction of confident visual events that must align. */
  'v2a_onset_alignment_rate_min',
  /** Requirement 30.x — speech-presence RMS threshold. */
  'speech_detection_rms_threshold_db',
  /** Requirement 30.x — minimum run length before a window counts as speech. */
  'speech_detection_min_duration_ms',
] as const;

export type QualityThresholdName = (typeof QUALITY_THRESHOLD_NAMES)[number];

/**
 * Units, kept as a closed list so a threshold cannot be stored with prose for a
 * unit and so a comparison against the wrong scale is visible in review.
 */
export const QUALITY_THRESHOLD_UNITS = [
  'db',
  'dbfs',
  'lufs',
  'ms',
  /** Dimensionless 0..1 fraction of a peak amplitude. */
  'amplitude_ratio',
  /** Dimensionless 0..1 fraction of a population. */
  'fraction',
  'cosine_similarity',
] as const;

export type QualityThresholdUnit = (typeof QUALITY_THRESHOLD_UNITS)[number];

export function isQualityThresholdName(value: unknown): value is QualityThresholdName {
  return (
    typeof value === 'string' && (QUALITY_THRESHOLD_NAMES as readonly string[]).includes(value)
  );
}
