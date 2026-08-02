/**
 * The request ranges and output contract of Requirement 30.
 *
 * This module is the **single declaration of those numbers on the TypeScript side**.
 * Nothing else in the product layer writes `-14`, `-24`, `500` or `-1.0` for a mastering
 * parameter: validation (`validation.ts`), the ducking envelope (`ducking.ts`), the
 * service (`services/mastering/`) and every generator in the property suites read from
 * here.
 *
 * ### Why these are `bounds` and not Quality_Threshold_Set members
 *
 * The same split `domain/effects/registry.ts` and `domain/sfx/bounds.ts` document. A
 * ducking depth of −40 dB is not a poor-sounding duck, it is not a duck the product
 * offers; Requirement 30.26 *refuses* an out-of-range value and echoes the permitted
 * range back, which is validation behaviour rather than a quality verdict that could be
 * relaxed per environment. The numbers that *are* perceptual judgements — how close the
 * achieved loudness must land, how far the bed may drift — live in
 * `domain/quality/mastering-thresholds.ts` and are operator-adjustable.
 *
 * `TRUE_PEAK_CEILING_DBTP` is the one entry where the reading needs stating. Requirement
 * 30.7 makes it an **invariant of the output** ("불변식") rather than a bound on an input,
 * and −1.0 dBTP is a delivery convention (EBU R 128 / AES streaming practice), not a
 * calibration of what sounds acceptable. Moving it would change what the product claims
 * to deliver, and would silently reinterpret every asset already stored as compliant. So
 * it is fixed here rather than adjustable, alongside the input ranges it interacts with.
 *
 * ### How the Python side is kept in agreement
 *
 * Every number here is checked in again as `dsp/src/musicstudio_dsp/mastering_registry.json`,
 * which the DSP worker *loads* rather than restating — so Python has no second declaration
 * that could drift. `test/unit/mastering/registry-parity.test.ts` compares this module
 * against that JSON in **both directions**, so a change on either side that is not
 * mirrored fails `npm test`. The JSON also carries the *initial* values of the
 * Quality_Threshold_Set members Requirement 30 quotes, for the same reason and with the
 * same parity check; at runtime the current values travel across the seam with the
 * request, because Requirement 34.4 lets an operator change them between two runs.
 *
 * The JSON lives inside the DSP package so it ships in the wheel; a file under `domain/`
 * would be absent from an installed worker. This is exactly the arrangement task 3.2 used
 * for `effect_registry.json`.
 */

/** An inclusive numeric range, as Requirement 30 states them ("이상 … 이하"). */
export interface MasteringRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Requirement 30.5: the loudness target, in LUFS.
 *
 * `step` is the 0.1 LUFS quantisation the clause requires of the *input*. It is validated
 * rather than rounded into: a request for −14.05 LUFS is refused with the range, because
 * silently snapping it would mean the value the user asked for and the value recorded on
 * the version differ with nothing saying so.
 */
export const LOUDNESS_TARGET_LUFS: MasteringRange = { min: -30.0, max: -6.0 };
export const LOUDNESS_TARGET_STEP_LUFS = 0.1;
export const LOUDNESS_TARGET_DEFAULT_LUFS = -14.0;

/**
 * Requirement 30.7: the true-peak ceiling, in dBTP, and the fact that it wins.
 *
 * `TRUE_PEAK_TAKES_PRIORITY` is not configuration — there is no code path that reads it
 * as `false`. It exists so the precedence Requirement 30.7 states ("트루 피크 상한 준수를
 * 목표 라우드니스 도달보다 우선하여 적용한다") is written down at the same place as the
 * number, and so `registry-parity.test.ts` can assert both sides agree about it. A
 * normaliser that reached the target by exceeding the ceiling would be wrong in the one
 * way the clause names.
 */
export const TRUE_PEAK_CEILING_DBTP = -1.0;
export const TRUE_PEAK_TAKES_PRIORITY = true;

/**
 * Requirement 30.24: the true peak is measured with at least 4× oversampling.
 *
 * "이상" — four is the floor, not the value. Both implementations use exactly 4, which is
 * what BS.1770-4 Annex 2 specifies and what keeps the two sides comparable; a side that
 * quietly used 8 would report a legitimately different (slightly higher) peak for the
 * same audio and the parity test would have nothing to say about it.
 */
export const TRUE_PEAK_OVERSAMPLING = 4;

/** Requirement 30.24: both measurements are reported rounded to 0.1. */
export const MEASUREMENT_REPORT_STEP = 0.1;

/** Requirement 30.13: ducking depth, in dB. Negative — it is an attenuation. */
export const DUCKING_DEPTH_DB: MasteringRange = { min: -24, max: -3 };
export const DUCKING_DEPTH_DEFAULT_DB = -12;

/** Requirement 30.14: ducking attack, in ms. */
export const DUCKING_ATTACK_MS: MasteringRange = { min: 10, max: 500 };
export const DUCKING_ATTACK_DEFAULT_MS = 50;

/** Requirement 30.15: ducking release, in ms. */
export const DUCKING_RELEASE_MS: MasteringRange = { min: 50, max: 2000 };
export const DUCKING_RELEASE_DEFAULT_MS = 300;

/**
 * Requirement 30.12's analysis window for speech detection, in ms.
 *
 * A constant rather than a Quality_Threshold_Set member, by the rule
 * `domain/quality/threshold-name.ts` note 3 states: moving a *window* changes what the
 * −45 dB threshold means, so every speech verdict already recorded against an earlier
 * threshold-set version would silently describe a different measurement. Moving the
 * threshold changes only which audio counts as speech, which is what calibration is for.
 * So the level and the run length are members and this is not.
 */
export const SPEECH_WINDOW_MS = 100;

/**
 * Requirement 30.20: the parameter-suggestion service's response budget, in ms.
 *
 * Distinct from `REMOTE_CALL_TIMEOUT_MS` (300 s) in `adapters/timeout-runner.ts`, which is
 * Requirement 20.14's budget for a *generation* call. 30.20 names 120 s for this one
 * specifically, and the shorter budget is the operative one: a suggestion is a synchronous
 * step in an interactive flow, and 30.21 requires a usable answer regardless.
 */
export const SUGGESTION_TIMEOUT_MS = 120_000;

/** Requirement 30.21: the built-in fallback must answer within this budget, in ms. */
export const SUGGESTION_FALLBACK_DEADLINE_MS = 5_000;

/**
 * Requirement 30.22: the ten octave-band centre frequencies, in Hz.
 *
 * Transcribed from the clause in the order it lists them. The order is part of the
 * contract — the response carries ten energies and the caller pairs them positionally —
 * so it is asserted rather than sorted at use.
 */
export const OCTAVE_BAND_CENTRES_HZ = [
  31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

export const OCTAVE_BAND_COUNT = OCTAVE_BAND_CENTRES_HZ.length;

/** Inclusive range test that refuses non-finite values before comparing. */
export function isWithin(range: MasteringRange, value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return value >= range.min && value <= range.max;
}

/**
 * Whether `value` is an exact multiple of `LOUDNESS_TARGET_STEP_LUFS`.
 *
 * Compared on the *scaled integer* rather than with a modulo on the float, because
 * `-14.1 % 0.1` is `0.09999999999999964` in IEEE-754 and a modulo test would reject every
 * odd tenth. Multiplying by ten and comparing against the nearest integer within a small
 * epsilon is the only form that accepts exactly the values Requirement 30.5 permits.
 */
export function isOnLoudnessTargetStep(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const scaled = value / LOUDNESS_TARGET_STEP_LUFS;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Requirement 30.26's payload: the permitted range, rendered for the caller. */
export function describeRange(range: MasteringRange): string {
  return `${String(range.min)}..${String(range.max)}`;
}
