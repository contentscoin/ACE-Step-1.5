/**
 * Credit_Service failure vocabulary.
 *
 * Structurally identical to `services/account/errors.ts` and
 * `adapters/registry/errors.ts` (status code, machine-readable `code`, detail
 * bag), so the single gateway error contract in `api/gateway/error-handler.ts`
 * renders all three without a second code path.
 *
 * Each rejection carries exactly the payload its acceptance criterion demands:
 *
 * - 2.3  insufficient balance      -> 402 with the shortfall amount
 * - 2.6  concurrency cap reached   -> 429 with the current in-flight count
 * - 2.11 unpriced kind × engine    -> 400 with the missing combination id
 * - 2.5  monthly job cap reached   -> 429 with limit and usage
 * - 2.14 per-kind monthly cap      -> 429 with the kind, limit and usage
 */

export type CreditErrorCode =
  | 'credit_balance_insufficient'
  | 'concurrent_job_limit_reached'
  | 'monthly_job_limit_reached'
  | 'monthly_asset_limit_reached'
  | 'pricing_entry_not_found'
  | 'plan_not_found'
  | 'charge_amount_invalid';

export type CreditErrorDetails = Readonly<Record<string, unknown>>;

export class CreditError extends Error {
  readonly statusCode: number;
  readonly code: CreditErrorCode;
  readonly details: CreditErrorDetails;

  constructor(
    statusCode: number,
    code: CreditErrorCode,
    message: string,
    details: CreditErrorDetails = {},
  ) {
    super(message);
    this.name = 'CreditError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isCreditError(value: unknown): value is CreditError {
  return value instanceof CreditError;
}

/** Requirement 2.3 — the caller is told how many credits are missing. */
export function creditBalanceInsufficient(detail: {
  readonly requiredCredits: number;
  readonly balance: number;
}): CreditError {
  return new CreditError(
    402,
    'credit_balance_insufficient',
    'The credit balance is lower than the credits this request requires.',
    { ...detail, shortfallCredits: detail.requiredCredits - detail.balance },
  );
}

/** Requirement 2.6 — the caller is told how many of its jobs are in flight. */
export function concurrentJobLimitReached(detail: {
  readonly jobsInFlight: number;
  readonly concurrentJobLimit: number;
  readonly planId: string;
}): CreditError {
  return new CreditError(
    429,
    'concurrent_job_limit_reached',
    'The plan concurrent Generation_Job limit is already reached.',
    detail,
  );
}

/** Requirement 2.5. */
export function monthlyJobLimitReached(detail: {
  readonly planId: string;
  readonly monthlyJobLimit: number;
  readonly jobsChargedThisMonth: number;
}): CreditError {
  return new CreditError(
    429,
    'monthly_job_limit_reached',
    'The plan monthly Generation_Job limit is already reached.',
    detail,
  );
}

/** Requirement 2.14. */
export function monthlyAssetLimitReached(detail: {
  readonly planId: string;
  readonly assetKind: string;
  readonly monthlyAssetLimit: number;
  readonly outputsThisMonth: number;
  readonly requestedOutputs: number;
}): CreditError {
  return new CreditError(
    429,
    'monthly_asset_limit_reached',
    `The plan monthly limit for Asset_Kind "${detail.assetKind}" is already reached.`,
    detail,
  );
}

/**
 * Requirement 2.11 — `pricingKey` is the "unregistered combination identifier",
 * so the caller can name the gap without guessing its spelling.
 */
export function pricingEntryNotFound(detail: {
  readonly assetKind: string;
  readonly engineId: string;
  readonly pricingKey: string;
}): CreditError {
  return new CreditError(
    400,
    'pricing_entry_not_found',
    `No credit price is registered for the combination "${detail.pricingKey}".`,
    detail,
  );
}

export function planNotFound(planId: string, knownPlanIds: readonly string[]): CreditError {
  return new CreditError(400, 'plan_not_found', `Plan "${planId}" is not defined.`, {
    planId,
    knownPlanIds,
  });
}

/** A non-positive or non-integer amount is a programming error, not a rejection. */
export function chargeAmountInvalid(amount: number): CreditError {
  return new CreditError(
    400,
    'charge_amount_invalid',
    'A credit amount must be a positive integer.',
    { amount },
  );
}
