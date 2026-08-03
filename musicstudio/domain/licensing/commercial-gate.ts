/**
 * The commercial-use gate (Requirements 33.11, 33.17, 33.22, 33.23).
 *
 * > THE MusicStudio SHALL 사용 목적 `commercial` 요청에 대한 상업적 사용 허용 여부 검사를 계정
 * > 요금제, 계정 등급, 운영자 설정, API 키 권한 중 어느 것으로도 우회할 수 없는 고정 정책으로
 * > 적용한다(불변식)
 *
 * ### The invariant is enforced by the signature, not by a comment
 *
 * Requirement 33.22 names four things that must not be able to bypass the check: the plan, the
 * account tier, an operator setting, and an API key's permissions. The way to make that true is
 * not to check for them and refuse — it is for the function to have **no parameter that could
 * carry one**. `CommercialGateFacts` holds the asset's recorded permission, the requested
 * purpose, and the evidence needed to explain a refusal. There is nowhere to put a plan.
 *
 * `test/unit/licensing/no-bypass.test.ts` pins this structurally: it enumerates the fact type's
 * keys and asserts none of them names an account attribute. A test that instead tried a
 * privileged caller and checked the refusal would only prove that one caller was refused.
 *
 * ### The ruling is made against the *recorded* permission
 *
 * Requirement 33.17: when an engine's flag flips true → false, existing assets keep the
 * provenance written at creation and are judged **by that**. So the fact this gate reads is
 * `assetCommercialUseAllowed` — the asset's stored, folded flag from `domain/commercial-use.ts` —
 * and never a fresh lookup of the engine. Re-reading the engine would silently apply a licence
 * change retroactively to work a user already paid for and shipped.
 *
 * The *current* engine state does appear in a refusal, as `alternativeEngineIds`. That is
 * Requirement 33.11's "이런 엔진으로는 됩니다", which is a question about now.
 */

import type { UsagePurpose } from './usage-purpose';

/** Requirement 33.11: at most ten alternatives, so the answer stays a suggestion. */
export const MAX_ALTERNATIVE_ENGINES = 10;

export interface CommercialGateFacts {
  readonly usagePurpose: UsagePurpose;
  /**
   * The asset's stored, lineage-folded flag — Requirement 33.21's invariant already applied.
   * Not the engine's current flag; see the module header on Requirement 33.17.
   */
  readonly assetCommercialUseAllowed: boolean;
  /** Requirement 33.23's 판정 근거: the licences that made it false. Empty when it is true. */
  readonly decidingLicenseIds: readonly string[];
  /** Requirement 33.11's list, already filtered to the asset's kind and truncated by the caller. */
  readonly alternativeEngineIds: readonly string[];
}

export type CommercialGateRuling =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly refusal: 'commercial_use_not_permitted';
      readonly decidingLicenseIds: readonly string[];
      readonly alternativeEngineIds: readonly string[];
    };

/**
 * Requirement 33.11.
 *
 * A `non_commercial` request is always allowed *by this gate* — it is the only thing this
 * function decides. Ownership, format and plan are other clauses with their own checks, and
 * folding them in here would give the fixed policy of 33.22 a parameter to bypass it through.
 */
export function ruleOnCommercialUse(facts: CommercialGateFacts): CommercialGateRuling {
  if (facts.usagePurpose !== 'commercial') return { allowed: true };
  if (facts.assetCommercialUseAllowed) return { allowed: true };

  return {
    allowed: false,
    refusal: 'commercial_use_not_permitted',
    decidingLicenseIds: [...facts.decidingLicenseIds],
    alternativeEngineIds: facts.alternativeEngineIds.slice(0, MAX_ALTERNATIVE_ENGINES),
  };
}

/** Requirement 33.23's audit payload, assembled where the refusal happens. */
export interface CommercialRefusalRecord {
  readonly accountId: string;
  readonly assetId: string;
  readonly decidingLicenseIds: readonly string[];
  readonly refusedAtMs: number;
}

export function commercialRefusalRecord(
  accountId: string,
  assetId: string,
  ruling: Extract<CommercialGateRuling, { allowed: false }>,
  refusedAtMs: number,
): CommercialRefusalRecord {
  return {
    accountId,
    assetId,
    decidingLicenseIds: ruling.decidingLicenseIds,
    refusedAtMs,
  };
}

/**
 * Requirement 33.10's notice: selecting a non-commercial engine needs an explicit confirmation
 * before the request is accepted.
 *
 * Modelled as a predicate over the request rather than as a UI concern, because the clause says
 * the *request is not accepted* without the confirmation — which is a gateway rule, and a screen
 * that forgot the checkbox would otherwise submit successfully.
 */
export interface NonCommercialNoticeFacts {
  readonly engineCommercialUseAllowed: boolean;
  readonly userConfirmedNonCommercialNotice: boolean;
}

export function requiresNonCommercialConfirmation(facts: NonCommercialNoticeFacts): boolean {
  return !facts.engineCommercialUseAllowed && !facts.userConfirmedNonCommercialNotice;
}
