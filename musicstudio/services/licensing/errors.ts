/**
 * The Licensing_Service's rejections.
 *
 * `GenerationError` like every other service, so `api/gateway/error-handler.ts` renders them
 * without a new branch.
 *
 * The status code for a commercial refusal is **403, not 402**. 402 would read as "pay and this
 * works", and Requirement 33.22 makes it exactly the case that paying does not: the check cannot
 * be bypassed by plan, tier, operator setting or API key. The alternatives in the payload are
 * the actionable part, and they are engines rather than plans for the same reason.
 */

import { GenerationError } from '../generation/errors';

export function commercialUseNotPermitted(details: {
  readonly assetId: string;
  readonly decidingLicenseIds: readonly string[];
  readonly alternativeEngineIds: readonly string[];
}): GenerationError {
  return new GenerationError(
    403,
    'commercial_use_not_permitted',
    'This asset was produced under a licence that does not permit commercial use.',
    details,
  );
}

export function licensingAssetNotFound(assetId: string): GenerationError {
  return new GenerationError(404, 'licensing_asset_not_found', 'No such Audio_Asset.', {
    assetId,
  });
}

/** Requirement 33.10: the engine is non-commercial and the notice was not confirmed. */
export function nonCommercialNoticeNotConfirmed(engineId: string): GenerationError {
  return new GenerationError(
    409,
    'non_commercial_notice_not_confirmed',
    'This engine does not permit commercial use; the notice must be confirmed first.',
    { engineId },
  );
}

/** Requirement 33.24: nothing to regenerate with. */
export function noCommercialEngineAvailable(assetKind: string): GenerationError {
  return new GenerationError(
    409,
    'no_commercial_engine_available',
    'No registered engine for this asset kind permits commercial use.',
    { assetKind },
  );
}
