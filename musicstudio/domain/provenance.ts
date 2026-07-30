/**
 * Asset provenance (Requirements 33.7, 33.14, 19.5, 34.6).
 *
 * Written once when the asset is stored and never modified afterwards
 * (Req 33.7), which is why the type is deeply readonly and the SQL side blocks
 * updates to the column.
 */

/** Recorded where a source requires no attribution (Req 33.1). */
export const NO_ATTRIBUTION_REQUIRED = 'none';

export const ATTRIBUTION_TEXT_MAX_LENGTH = 500;
export const CANONICAL_SAMPLE_RATE = 48_000;

export interface AssetProvenance {
  /** Engine that produced the asset, or the upload source marker (Req 19.12). */
  readonly engineId: string;
  readonly weightLicenseId: string;
  /** 1–500 chars, or `NO_ATTRIBUTION_REQUIRED`. */
  readonly attributionText: string;
  /** Engine/self permission at creation time — folded, not overridden, later. */
  readonly commercialUseAllowed: boolean;
  /** Version of the non-commercial licence list used for the ruling (Req 33.7). */
  readonly nonCommercialLicenseListVersion: number;
  /** Provenance write time, millisecond precision (Req 33.7). */
  readonly recordedAtMs: number;
  /** AI generation marker, always present (Req 33.14). */
  readonly aiGenerated: true;
  /** Engine sample rate before normalisation to 48 kHz (Req 19.5). */
  readonly originalSampleRate?: number;
  /** Quality_Threshold_Set version used to admit the asset (Req 34.6). */
  readonly qualityThresholdSetVersion?: number;
  /** Inaudible watermark descriptor (Req 16.5, 33.14). */
  readonly watermarkId?: string;
}

export type ProvenanceViolation =
  | 'engine_id_required'
  | 'weight_license_id_required'
  | 'attribution_text_length'
  | 'non_commercial_license_list_version_range'
  | 'recorded_at_ms_range'
  | 'original_sample_rate_range'
  | 'quality_threshold_set_version_range';

export function validateProvenance(provenance: AssetProvenance): ProvenanceViolation[] {
  const violations: ProvenanceViolation[] = [];

  if (provenance.engineId.trim().length === 0) violations.push('engine_id_required');
  if (provenance.weightLicenseId.trim().length === 0) {
    violations.push('weight_license_id_required');
  }

  const attribution = provenance.attributionText;
  if (attribution.length < 1 || attribution.length > ATTRIBUTION_TEXT_MAX_LENGTH) {
    violations.push('attribution_text_length');
  }

  if (!isPositiveInteger(provenance.nonCommercialLicenseListVersion)) {
    violations.push('non_commercial_license_list_version_range');
  }
  if (!isPositiveInteger(provenance.recordedAtMs)) violations.push('recorded_at_ms_range');

  const { originalSampleRate, qualityThresholdSetVersion } = provenance;
  if (originalSampleRate !== undefined && !isPositiveInteger(originalSampleRate)) {
    violations.push('original_sample_rate_range');
  }
  if (qualityThresholdSetVersion !== undefined && !isPositiveInteger(qualityThresholdSetVersion)) {
    violations.push('quality_threshold_set_version_range');
  }

  return violations;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
