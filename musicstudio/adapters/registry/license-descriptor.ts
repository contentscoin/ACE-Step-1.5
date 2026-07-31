/**
 * License_Descriptor (Requirement 33.1, 33.6; referenced by Requirement 20.1).
 *
 * Five items, all mandatory: code licence identifier, weight licence
 * identifier, commercial-use permission, required attribution text (1–500
 * chars, or the fixed "no attribution" value), and 1–5 licence source links.
 */

import { ATTRIBUTION_TEXT_MAX_LENGTH, NO_ATTRIBUTION_REQUIRED } from '../../domain/provenance';

export const LICENSE_URLS_MIN = 1;
export const LICENSE_URLS_MAX = 5;
/** Requirement 33.4: per-engine third-party component descriptors. */
export const LICENSE_COMPONENTS_MAX = 200;

export interface LicenseDescriptor {
  readonly codeLicenseId: string;
  readonly weightLicenseId: string;
  readonly commercialUseAllowed: boolean;
  /** 1–500 chars, or `NO_ATTRIBUTION_REQUIRED` where none is required. */
  readonly attributionText: string;
  /** 1–5 links to the licence text. */
  readonly licenseUrls: readonly string[];
  /** Requirement 33.5: terms-of-service link for a remote provider's model. */
  readonly termsOfServiceUrl?: string;
}

/** Field names returned to the caller on rejection (Requirement 33.6). */
export const LICENSE_FIELD_NAMES = [
  'license.codeLicenseId',
  'license.weightLicenseId',
  'license.commercialUseAllowed',
  'license.attributionText',
  'license.licenseUrls',
] as const;

/**
 * Requirement 33.6: report every empty or out-of-range item, not just the first.
 * The caller keeps any previously stored descriptor untouched when this returns
 * a non-empty list.
 */
export function validateLicenseDescriptor(
  license: unknown,
  fieldPrefix = 'license',
): string[] {
  if (license === null || typeof license !== 'object') {
    return [fieldPrefix];
  }
  const candidate = license as Partial<LicenseDescriptor>;
  const violations: string[] = [];

  if (!isNonEmptyText(candidate.codeLicenseId)) {
    violations.push(`${fieldPrefix}.codeLicenseId`);
  }
  if (!isNonEmptyText(candidate.weightLicenseId)) {
    violations.push(`${fieldPrefix}.weightLicenseId`);
  }
  if (typeof candidate.commercialUseAllowed !== 'boolean') {
    violations.push(`${fieldPrefix}.commercialUseAllowed`);
  }
  if (!isValidAttributionText(candidate.attributionText)) {
    violations.push(`${fieldPrefix}.attributionText`);
  }
  if (!isValidLicenseUrls(candidate.licenseUrls)) {
    violations.push(`${fieldPrefix}.licenseUrls`);
  }

  return violations;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidAttributionText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === NO_ATTRIBUTION_REQUIRED) return true;
  return value.length >= 1 && value.length <= ATTRIBUTION_TEXT_MAX_LENGTH;
}

function isValidLicenseUrls(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= LICENSE_URLS_MIN &&
    value.length <= LICENSE_URLS_MAX &&
    value.every(isNonEmptyText)
  );
}
