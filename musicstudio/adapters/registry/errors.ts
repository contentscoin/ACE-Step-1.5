/**
 * Provider_Registry and routing failure vocabulary.
 *
 * Structurally identical to `services/account/errors.ts` (status code, machine
 * readable `code`, detail bag) so the one gateway error contract in
 * `api/gateway/error-handler.ts` renders both without a second code path.
 *
 * Each rejection carries exactly the payload its acceptance criterion demands:
 *
 * - 20.5  unsupported Asset_Kind  -> the engines that do support it
 * - 20.6  output too long         -> that engine's maximum output length
 * - 20.11 nothing available       -> every candidate's last check time/result
 * - 20.13 quota exhausted        -> next reset instant + usable alternatives
 * - 20.22 explicit engine down    -> usable alternatives, never a substitution
 * - 20.23 bad descriptor          -> the offending field names
 *
 * Requirement 20.17 has no entry here on purpose: a missing pricing entry is not
 * a rejection. The engine is registered `inactive` and the missing keys come back
 * on the success body (`RegistrationResult.missingPricingKeys`).
 */

export type RegistryErrorCode =
  | 'engine_descriptor_invalid'
  | 'engine_already_registered'
  | 'engine_not_found'
  | 'asset_kind_unsupported'
  | 'output_duration_exceeded'
  | 'engine_unavailable'
  | 'engine_quota_exhausted'
  | 'no_available_engine'
  | 'default_engine_invariant_violated';

export type RegistryErrorDetails = Readonly<Record<string, unknown>>;

export class RegistryError extends Error {
  readonly statusCode: number;
  readonly code: RegistryErrorCode;
  readonly details: RegistryErrorDetails;

  constructor(
    statusCode: number,
    code: RegistryErrorCode,
    message: string,
    details: RegistryErrorDetails = {},
  ) {
    super(message);
    this.name = 'RegistryError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function isRegistryError(value: unknown): value is RegistryError {
  return value instanceof RegistryError;
}

/** Requirements 20.23 and 33.6. */
export function engineDescriptorInvalid(invalidFields: readonly string[]): RegistryError {
  return new RegistryError(
    400,
    'engine_descriptor_invalid',
    'The Engine_Descriptor has missing or out-of-range fields.',
    { invalidFields },
  );
}

export function engineAlreadyRegistered(engineId: string): RegistryError {
  return new RegistryError(409, 'engine_already_registered', 'The engine is already registered.', {
    engineId,
  });
}

export function engineNotFound(engineId: string): RegistryError {
  return new RegistryError(404, 'engine_not_found', 'The engine is not registered.', { engineId });
}

/** Requirement 20.5. */
export function assetKindUnsupported(
  engineId: string,
  assetKind: string,
  supportingEngineIds: readonly string[],
): RegistryError {
  return new RegistryError(
    400,
    'asset_kind_unsupported',
    `Engine "${engineId}" does not support Asset_Kind "${assetKind}".`,
    { engineId, assetKind, supportingEngineIds },
  );
}

/** Requirement 20.6. */
export function outputDurationExceeded(
  engineId: string,
  requestedDurationMs: number,
  maxOutputDurationMs: number,
): RegistryError {
  return new RegistryError(
    400,
    'output_duration_exceeded',
    'The requested output length exceeds the engine maximum.',
    { engineId, requestedDurationMs, maxOutputDurationMs },
  );
}

/** Requirement 20.22 — an explicit choice is never silently substituted. */
export function engineUnavailable(
  engineId: string,
  reason: 'unavailable' | 'inactive',
  availableEngineIds: readonly string[],
): RegistryError {
  return new RegistryError(
    409,
    'engine_unavailable',
    `Engine "${engineId}" is ${reason} and was explicitly requested.`,
    { engineId, reason, availableEngineIds },
  );
}

/** Requirement 20.13. */
export function engineQuotaExhausted(
  engineId: string,
  detail: {
    readonly exhausted: readonly string[];
    readonly nextResetAtMs: number;
    readonly availableEngineIds: readonly string[];
  },
): RegistryError {
  return new RegistryError(
    429,
    'engine_quota_exhausted',
    `Engine "${engineId}" has insufficient daily quota remaining.`,
    { engineId, ...detail },
  );
}

/** Requirement 20.11. */
export interface EngineHealthSummary {
  readonly engineId: string;
  readonly lastCheckedAtMs: number | null;
  readonly lastCheckOutcome: 'success' | 'failure' | null;
}

export function noAvailableEngine(
  assetKind: string,
  candidates: readonly EngineHealthSummary[],
): RegistryError {
  return new RegistryError(
    503,
    'no_available_engine',
    `No available engine supports Asset_Kind "${assetKind}".`,
    { assetKind, candidates },
  );
}

/**
 * Requirement 20.2 — the default-engine invariant refuses the change.
 *
 * `engine_is_default` covers the mirror-image case: the change would leave a
 * default engine inactive or unregistered, which the invariant forbids just as
 * much as appointing an unsuitable default does.
 */
export function defaultEngineInvariantViolated(
  assetKind: string,
  engineId: string,
  reason: 'unsupported_asset_kind' | 'engine_inactive' | 'engine_not_found' | 'engine_is_default',
): RegistryError {
  return new RegistryError(
    409,
    'default_engine_invariant_violated',
    `Engine "${engineId}" cannot be the default for Asset_Kind "${assetKind}".`,
    { assetKind, engineId, reason },
  );
}
