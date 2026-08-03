/**
 * Usage purpose (Requirement 33.19).
 *
 * > THE Library_Service SHALL 모든 Audio_Asset 다운로드 및 내보내기 요청에 대해 사용 목적 값을
 * > `commercial`과 `non_commercial` 중 정확히 하나로 기록하고, 사용 목적 값이 전달되지 않은
 * > 요청에는 `non_commercial`을 적용한다
 *
 * ### The default is the safe side, and the parse is total
 *
 * Two words carry the whole module: **정확히 하나** and **`non_commercial`을 적용**. So this is a
 * total function from `unknown` — the value arrives from a query string, a JSON body or an API
 * client, and none of those has been established to be a string, let alone one of two.
 *
 * Everything unrecognised becomes `non_commercial`, including `'COMMERCIAL'`, `'commercial '` and
 * `1`. That asymmetry is the point: a typo that silently became `commercial` would take a
 * non-commercially-licensed asset through the gate of Requirement 33.11, and the whole of
 * Requirement 33 exists to make that structurally impossible. A typo that becomes
 * `non_commercial` costs a user one clear refusal.
 *
 * Case is *not* normalised for the same reason. Accepting `'Commercial'` would mean accepting
 * whatever else a caller's serialiser did to the value, and the clause names two exact strings.
 */

export const USAGE_PURPOSES = ['commercial', 'non_commercial'] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/** Requirement 33.19's default, applied to an absent *or* unrecognised value. */
export const DEFAULT_USAGE_PURPOSE: UsagePurpose = 'non_commercial';

export function isUsagePurpose(value: unknown): value is UsagePurpose {
  return typeof value === 'string' && (USAGE_PURPOSES as readonly string[]).includes(value);
}

/**
 * The recorded purpose for a request. Never throws: Requirement 33.19 says an absent value is
 * *applied a default*, not rejected, and a refusal here would turn a missing optional field into
 * a failed download.
 */
export function toUsagePurpose(value: unknown): UsagePurpose {
  return isUsagePurpose(value) ? value : DEFAULT_USAGE_PURPOSE;
}

/** Whether a request's purpose engages Requirement 33.11's gate at all. */
export function isCommercialPurpose(purpose: UsagePurpose): boolean {
  return purpose === 'commercial';
}
