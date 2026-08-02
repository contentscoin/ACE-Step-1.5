/**
 * Transcription model tiers and the response-time budget (Requirements 27.1, 27.2, 27.16).
 *
 * 27.2 asks for 2–5 tiers, each presenting a model identifier and a maximum processing time per
 * second of audio between 0.01 s and 5.00 s. 27.1 turns that number into a deadline:
 *
 * ```
 *   deadline = 오디오 길이(초) × 등급별 1초당 최대 처리 시간(초) + 60초
 * ```
 *
 * and 27.16 fails the transcription when the deadline passes. So the per-tier number is not
 * decoration — it *is* the contract, and expressing the budget as one function is what keeps the
 * deadline the service enforces identical to the one it advertised.
 *
 * ### The tiers are data, and the bounds are checked
 *
 * A deployment declares its own tiers. The seeded set below is a **product decision**: no
 * requirement names any particular model, and 27.2 constrains only the count and the range. Two
 * tiers rather than five, spanning most of the permitted range, because the point of the tier
 * list is that a caller can trade latency for accuracy and two tiers already make that trade
 * observable. `isWellFormedTierSet` is what makes the 2–5 bound and the 0.01–5.00 bound
 * enforceable against whatever a deployment supplies.
 */

import {
  TIER_SECONDS_PER_AUDIO_SECOND_MAX,
  TIER_SECONDS_PER_AUDIO_SECOND_MIN,
  TRANSCRIPTION_RESPONSE_OVERHEAD_MS,
  TRANSCRIPTION_TIER_COUNT_MAX,
  TRANSCRIPTION_TIER_COUNT_MIN,
} from './bounds';

export interface TranscriptionTier {
  /** The tier name a caller selects by. */
  readonly tierId: string;
  /** Requirement 27.2 — 모델 식별자, presented to the caller. */
  readonly modelId: string;
  /** Requirement 27.2 — 오디오 길이 1초당 최대 처리 시간, seconds. */
  readonly secondsPerAudioSecond: number;
}

/**
 * Requirement 27.2's seeded tiers.
 *
 * `fast` at 0.05 s/s and `accurate` at 1.20 s/s: both inside 27.2's range, an order of magnitude
 * apart so the deadline of 27.1 differs visibly between them, and neither at a boundary — a tier
 * sitting exactly on 0.01 or 5.00 would make the bound check pass for the wrong reason.
 */
export const DEFAULT_TRANSCRIPTION_TIERS: readonly TranscriptionTier[] = [
  { tierId: 'fast', modelId: 'asr-fast-v1', secondsPerAudioSecond: 0.05 },
  { tierId: 'accurate', modelId: 'asr-accurate-v1', secondsPerAudioSecond: 1.2 },
];

export const DEFAULT_TRANSCRIPTION_TIER_ID = 'fast';

export function findTier(
  tiers: readonly TranscriptionTier[],
  tierId: string,
): TranscriptionTier | undefined {
  return tiers.find((tier) => tier.tierId === tierId);
}

/** Requirement 27.2's two bounds, over a whole declared tier set. */
export function isWellFormedTierSet(tiers: readonly TranscriptionTier[]): boolean {
  if (tiers.length < TRANSCRIPTION_TIER_COUNT_MIN || tiers.length > TRANSCRIPTION_TIER_COUNT_MAX) {
    return false;
  }
  if (new Set(tiers.map((tier) => tier.tierId)).size !== tiers.length) return false;

  return tiers.every(
    (tier) =>
      tier.modelId.length > 0 &&
      Number.isFinite(tier.secondsPerAudioSecond) &&
      tier.secondsPerAudioSecond >= TIER_SECONDS_PER_AUDIO_SECOND_MIN &&
      tier.secondsPerAudioSecond <= TIER_SECONDS_PER_AUDIO_SECOND_MAX,
  );
}

/**
 * Requirement 27.1's deadline, in milliseconds from the moment the request was accepted.
 *
 * Stated as elapsed budget rather than as an absolute instant so nothing here reads a clock; the
 * service adds it to its own accepted-at time, which is the same instant 27.1 measures from
 * ("요청 접수 시점부터").
 */
export function responseBudgetMs(tier: TranscriptionTier, audioDurationMs: number): number {
  const audioSeconds = Math.max(0, audioDurationMs) / 1000;
  return Math.round(
    audioSeconds * tier.secondsPerAudioSecond * 1000 + TRANSCRIPTION_RESPONSE_OVERHEAD_MS,
  );
}

/** Requirement 27.16: has the budget passed? */
export function hasExceededBudget(input: {
  readonly tier: TranscriptionTier;
  readonly audioDurationMs: number;
  readonly acceptedAtMs: number;
  readonly nowMs: number;
}): boolean {
  return input.nowMs - input.acceptedAtMs > responseBudgetMs(input.tier, input.audioDurationMs);
}
