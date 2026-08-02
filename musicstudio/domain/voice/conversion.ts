/**
 * Voice conversion: what is checkable, and what is a port contract (Requirements 26.24, 26.25).
 *
 * 26.24: "원본 발화 내용을 유지하고 음색을 대상 프로필로 변환한 Asset_Kind가 `dialogue`인
 * Audio_Asset을 산출한다". Two claims, and they are **not** of the same kind, which is the
 * substantive statement this module makes:
 *
 * ### 26.25's length invariant is verified
 *
 * `|output length − source length| ≤ tolerance`, measured on both files, judged against the
 * Quality_Threshold_Set member `voice_conversion_length_tolerance_ms` (initially ±100 ms). This
 * is arithmetic over two measurements and is asserted directly, both in the unit tests and as a
 * property over generated lengths.
 *
 * ### 26.24's content preservation is *asserted by the port, not verified here*
 *
 * "원본 발화 내용을 유지" is a claim about what words are being said. Checking it needs a
 * transcriber good enough that a disagreement means the conversion changed the words rather than
 * that the transcriber misheard — and even then it would only compare two transcripts, not two
 * utterances. **No such model is reachable from this environment**, so pretending to verify it
 * would produce a test that passes for the wrong reason and a service that reports a guarantee
 * it does not have.
 *
 * What is done instead:
 *
 * 1. The obligation is stated as an explicit contract on `VoiceConversionPort`
 *    (`services/voice/profile-ports.ts`), so the requirement lands on the implementation that
 *    can honour it rather than evaporating.
 * 2. `contentPreservationClaim` records *how* the claim was established for this asset, as
 *    provenance. Today every conversion records `port_contract`, meaning "no verification was
 *    performed; the adapter asserts it". A deployment with a transcriber records
 *    `transcript_match` and the similarity it measured.
 * 3. The length invariant of 26.25 is the one checkable consequence, and it is enforced.
 *
 * This split is reported with the task. It is the honest position: 26.25 is verified, 26.24 is
 * assumed, and the asset says which.
 */

import type { VoiceConversionThresholds } from '../quality/speech-thresholds';

/** How 26.24's content-preservation claim was established for one conversion. */
export const CONTENT_PRESERVATION_BASES = [
  /** The adapter asserts it; nothing measured it. The only basis available in-repo. */
  'port_contract',
  /** A transcriber compared source and output text. Requires a model this repo has none of. */
  'transcript_match',
] as const;

export type ContentPreservationBasis = (typeof CONTENT_PRESERVATION_BASES)[number];

export interface ContentPreservationClaim {
  readonly basis: ContentPreservationBasis;
  /** `null` for `port_contract` — there is no number, and inventing one would be a lie. */
  readonly similarity: number | null;
  /** The requirement the claim discharges, so provenance names it. */
  readonly requirement: '26.24';
}

export function contentPreservationClaim(
  basis: ContentPreservationBasis = 'port_contract',
  similarity: number | null = null,
): ContentPreservationClaim {
  return { basis, similarity: basis === 'port_contract' ? null : similarity, requirement: '26.24' };
}

export interface ConversionLengthMeasurement {
  readonly sourceDurationMs: number;
  readonly outputDurationMs: number;
}

export interface ConversionLengthVerdict {
  readonly satisfied: boolean;
  /** 출력 길이 − 원본 길이, signed, so a caller can see which way it drifted. */
  readonly errorMs: number;
  readonly toleranceMs: number;
  readonly sourceDurationMs: number;
  readonly outputDurationMs: number;
  /** Requirement 34.6: the set version this verdict was taken against. */
  readonly qualityThresholdSetVersion: number;
}

/**
 * Requirement 26.25 — the length invariant.
 *
 * Inclusive at the boundary: 26.25 says "±100밀리초 이내", and a conversion exactly 100 ms
 * longer is within 100 ms. The comparison is on the signed error's magnitude rather than on a
 * ratio, because the criterion is stated in milliseconds and a ratio would let a long line drift
 * further than a short one.
 */
export function evaluateConversionLength(
  measurement: ConversionLengthMeasurement,
  thresholds: VoiceConversionThresholds,
): ConversionLengthVerdict {
  const errorMs = measurement.outputDurationMs - measurement.sourceDurationMs;
  return {
    satisfied: Math.abs(errorMs) <= thresholds.lengthToleranceMs,
    errorMs,
    toleranceMs: thresholds.lengthToleranceMs,
    sourceDurationMs: measurement.sourceDurationMs,
    outputDurationMs: measurement.outputDurationMs,
    qualityThresholdSetVersion: thresholds.version,
  };
}

/** Requirement 26.24: what a conversion records on the produced `dialogue` asset. */
export interface VoiceConversionMetadata {
  readonly sourceAssetId: string;
  readonly voiceProfileId: string;
  readonly engineId: string;
  readonly sourceDurationMs: number;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Requirement 26.25's verdict, stored so it can be audited rather than re-measured. */
  readonly lengthVerdict: ConversionLengthVerdict;
  /** Requirement 26.24's claim and its basis. See the module comment. */
  readonly contentPreservation: ContentPreservationClaim;
  /** Requirements 26.26, 26.14: the consent record that permitted the conversion. */
  readonly consentRecordId: string;
  /** Requirement 34.6. */
  readonly qualityThresholdSetVersion: number;
}
