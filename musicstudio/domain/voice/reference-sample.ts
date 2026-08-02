/**
 * Reference audio sample validation (Requirements 26.2, 26.3, 26.4, 26.5).
 *
 * Four criteria, three of them a bound on a probed measurement and one — 26.5 — a *ratio* of
 * two measurements. All four report the same way: the violated constraint name plus what would
 * have been accepted (26.4), or for 26.5 the measured ratio and the minimum (26.5's own words).
 *
 * ### Why the speech ratio reads Requirement 30's thresholds
 *
 * 26.5 bounds "발화 구간 길이 비율", and the glossary defines 발화 구간 as
 * "Requirement 30에 정의된 RMS 임계 기준으로 판정된 대사 오디오의 구간". So the speech-region
 * rule is Requirement 30.12's — a 100 ms window at or above -45.0 dB, sustained for at least
 * 200 ms — and it arrives through `domain/quality/speech-thresholds.ts` as two
 * Quality_Threshold_Set members that already existed. **A second definition of what speech is
 * would mean an operator recalibrating 발화 판정 changed 30.12 and not 26.5**, which is exactly
 * the drift Requirement 34 exists to prevent.
 *
 * The *detection* itself is not here: measuring which windows hold speech is
 * `services/voice/profile-ports.ts`'s probe, because a reference sample is an uploaded file the
 * product layer has not decoded. What is here is the ratio and the judgement.
 *
 * ### The 60 % floor is a constant, not a threshold
 *
 * The RMS level and the minimum run length are perceptual and adjustable; the 60 % floor is a
 * policy about how much of an upload has to be usable before it is worth cloning from. It is a
 * bound on the *input the system accepts*, in the sense `domain/v2a/bounds.ts` draws, so it
 * stays here. **Open question for the spec**, stated because the appendix lists "발화 구간 비율
 * 60% 이상" beside the two adjustable numbers without saying which side it falls on.
 */

import { rangeViolation, enumViolation, type SongFieldViolation } from '../song/violation';

/** Requirement 26.2 — 참조 음성 샘플 길이, milliseconds. */
export const REFERENCE_SAMPLE_DURATION_MS_MIN = 6_000;
export const REFERENCE_SAMPLE_DURATION_MS_MAX = 120_000;

/** Requirement 26.3 — accepted container formats, matched on a normalised short name. */
export const REFERENCE_SAMPLE_FORMATS = ['wav', 'mp3', 'flac'] as const;

export type ReferenceSampleFormat = (typeof REFERENCE_SAMPLE_FORMATS)[number];

/** Requirement 26.3 — 샘플레이트 하한, hertz. No upper bound is stated and none is invented. */
export const REFERENCE_SAMPLE_SAMPLE_RATE_MIN = 16_000;

/** Requirement 26.5 — 발화 구간 길이 비율 하한, as a fraction of the whole. */
export const REFERENCE_SAMPLE_SPEECH_RATIO_MIN = 0.6;

export function isReferenceSampleFormat(value: unknown): value is ReferenceSampleFormat {
  return (
    typeof value === 'string' && (REFERENCE_SAMPLE_FORMATS as readonly string[]).includes(value)
  );
}

/**
 * What a probe reports about one uploaded sample.
 *
 * `speechDurationMs` is the *total* length of the detected speech regions, not the span from
 * the first to the last — 26.5 says "발화 구간 길이 비율", and a sample with two sentences and a
 * long pause between them has less speech than that span suggests.
 */
export interface ProbedReferenceSample {
  readonly uploadId: string;
  readonly format: string;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly speechDurationMs: number;
}

export const REFERENCE_SAMPLE_CONSTRAINTS = [
  'duration',
  'format',
  'sampleRate',
  'speechRatio',
] as const;

export type ReferenceSampleConstraint = (typeof REFERENCE_SAMPLE_CONSTRAINTS)[number];

export const REFERENCE_SAMPLE_CONSTRAINT_REQUIREMENT: Readonly<
  Record<ReferenceSampleConstraint, string>
> = {
  duration: '26.2',
  format: '26.3',
  sampleRate: '26.3',
  speechRatio: '26.5',
};

/** Requirement 26.5 — measured speech as a fraction of the sample's length, clamped to `[0, 1]`. */
export function speechRatioOf(probed: ProbedReferenceSample): number {
  if (!(probed.durationMs > 0)) return 0;
  return Math.min(1, Math.max(0, probed.speechDurationMs / probed.durationMs));
}

export type ReferenceSampleValidation =
  | { readonly kind: 'valid'; readonly probed: ProbedReferenceSample; readonly speechRatio: number }
  | {
      readonly kind: 'invalid';
      readonly violations: readonly SongFieldViolation[];
      readonly constraints: readonly ReferenceSampleConstraint[];
      /** Requirement 26.5 asks for the measured ratio by name; `null` when unmeasurable. */
      readonly speechRatio: number | null;
    };

/**
 * Requirements 26.2–26.5, every violation at once.
 *
 * The order the checks run in does not matter — none of them depends on another's outcome —
 * which is worth stating because it is *not* the case for `domain/sfx/validation.ts`, where the
 * step count depends on the tier. Here the ratio is measured even when the duration is out of
 * range, so 26.4's and 26.5's payloads are both complete on the first round trip.
 */
export function validateReferenceSample(
  probed: ProbedReferenceSample,
): ReferenceSampleValidation {
  const violations: SongFieldViolation[] = [];
  const constraints: ReferenceSampleConstraint[] = [];
  const ratio = speechRatioOf(probed);

  // Requirement 26.2.
  if (
    !Number.isFinite(probed.durationMs) ||
    probed.durationMs < REFERENCE_SAMPLE_DURATION_MS_MIN ||
    probed.durationMs > REFERENCE_SAMPLE_DURATION_MS_MAX
  ) {
    violations.push(
      rangeViolation(
        'duration',
        probed.durationMs,
        REFERENCE_SAMPLE_DURATION_MS_MIN,
        REFERENCE_SAMPLE_DURATION_MS_MAX,
        false,
      ),
    );
    constraints.push('duration');
  }

  // Requirement 26.3's format list.
  if (!isReferenceSampleFormat(probed.format.toLowerCase())) {
    violations.push(enumViolation('format', probed.format, REFERENCE_SAMPLE_FORMATS));
    constraints.push('format');
  }

  // Requirement 26.3's rate floor. The upper bound reported to the caller is the design §5.1
  // canonical rate, which is the highest rate anything in this system stores.
  if (
    !Number.isFinite(probed.sampleRate) ||
    probed.sampleRate < REFERENCE_SAMPLE_SAMPLE_RATE_MIN
  ) {
    violations.push(
      rangeViolation(
        'sampleRate',
        probed.sampleRate,
        REFERENCE_SAMPLE_SAMPLE_RATE_MIN,
        Number.POSITIVE_INFINITY,
      ),
    );
    constraints.push('sampleRate');
  }

  // Requirement 26.5.
  if (ratio < REFERENCE_SAMPLE_SPEECH_RATIO_MIN) {
    violations.push(
      rangeViolation('speechRatio', ratio, REFERENCE_SAMPLE_SPEECH_RATIO_MIN, 1, false),
    );
    constraints.push('speechRatio');
  }

  if (violations.length > 0) {
    return { kind: 'invalid', violations, constraints, speechRatio: ratio };
  }
  return { kind: 'valid', probed, speechRatio: ratio };
}
