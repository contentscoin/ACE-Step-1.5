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
 * 3. **A measured quantity's threshold is a member; the window it is measured
 *    over is not.** Requirement 23.8 quotes four numbers — a 5 ms frame, a 50 ms
 *    lookback, a 6.0 dB rise and a 0.50 confidence floor — and only the last two
 *    are here. The same split `domain/sfx/bounds.ts` documents applies: moving a
 *    window changes *what the number means*, so every verdict already recorded
 *    against an earlier version would silently describe a different measurement,
 *    which Requirement 34.10 forbids. Moving a ceiling changes only which audio is
 *    admissible, which is exactly what 34.4 is for.
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
  /**
   * Requirement 23.8 — the short-term RMS rise that *defines* an onset.
   *
   * A member rather than a constant for the same reason the other three V2A numbers
   * are: 6.0 dB is a perceptual judgement about when a sound has "started", and
   * Requirement 34's whole point is that such judgements are calibrated (34.7) rather
   * than compiled in. See note 3 below on why the two *window lengths* it is measured
   * over (5 ms and 50 ms) stay constants.
   */
  'v2a_onset_rise_db',
  /**
   * Requirements 23.8, 23.15, 23.16 — the confidence at or above which a visual
   * event must be aligned, and below which it is ignored.
   */
  'v2a_visual_event_confidence_min',
  /** Requirement 23.12 — preview audio/video start offset ceiling. */
  'v2a_preview_sync_tolerance_ms',
  /** Requirement 23.9 — output-vs-input duration error ceiling. */
  'v2a_output_duration_tolerance_ms',
  /** Requirement 30.x — speech-presence RMS threshold. */
  'speech_detection_rms_threshold_db',
  /** Requirement 30.x — minimum run length before a window counts as speech. */
  'speech_detection_min_duration_ms',
  /**
   * Requirement 25.19 — the level at or below which the tail of a dialogue asset
   * counts as silence, and the window the resulting run must land in.
   *
   * Three members for one criterion, by the same two rules the notes above apply.
   * 25.19 states a *level* (-60 dBFS) and a *range* (50–200 ms): the level is the
   * judgement about when speech has stopped, which is the same kind of judgement
   * `speech_detection_rms_threshold_db` already is, and the range is the window the
   * measured run is adjusted into, which needs two members for the reason note 1
   * gives about the pack loudness window.
   *
   * **Open question for the spec**, the same one note 2 raises: Requirement 34.1's
   * enumeration names 발화 판정 RMS 임계값 but not the dialogue tail, and the
   * appendix's list of perceptual thresholds omits it too. Treating 25.19's numbers
   * as constants would leave a plainly perceptual judgement — how much silence
   * belongs at the end of a line of speech — unadjustable, so they are members here.
   */
  'dialogue_tail_silence_floor_dbfs',
  'dialogue_tail_silence_min_ms',
  'dialogue_tail_silence_max_ms',
  /**
   * Requirement 26.25 — how far a voice conversion's length may sit from its source.
   *
   * A member for the same reason `v2a_output_duration_tolerance_ms` is (Requirement
   * 23.9's ±40 ms, added by task 2.6): it is a ceiling on a measured error, so moving
   * it changes only which conversions are admissible, never what an already-recorded
   * measurement meant. Requirement 34.1 does not name it either; see the note above.
   */
  'voice_conversion_length_tolerance_ms',
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
