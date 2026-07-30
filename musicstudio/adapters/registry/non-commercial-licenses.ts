/**
 * Non-commercial licence list and the commercial-use ruling it drives
 * (Requirements 33.2, 33.3, 33.4).
 *
 * The list is versioned: every add or remove bumps the version by exactly 1
 * (33.3), and the version in force at ruling time is what an asset's provenance
 * records (33.7), so a later list change can never retroactively rewrite a past
 * decision.
 */

import type { LicenseDescriptor } from './license-descriptor';

export const NON_COMMERCIAL_LIST_MIN_ENTRIES = 1;
export const NON_COMMERCIAL_LIST_MAX_ENTRIES = 200;

/** Seed list: the identifiers that actually appear on models in scope. */
export const DEFAULT_NON_COMMERCIAL_LICENSE_IDS: readonly string[] = [
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-ND-4.0',
  'RAIL-NC',
  'OpenRAIL-NC',
  'research-only',
  'non-commercial',
];

export interface NonCommercialLicenseList {
  readonly version: number;
  readonly ids: readonly string[];
  /** True when `licenseId` matches an entry, case-insensitively. */
  includes(licenseId: string): boolean;
  /** Adds an entry and returns the list at version + 1. No-op returns `this`. */
  add(licenseId: string): NonCommercialLicenseList;
  /** Removes an entry and returns the list at version + 1. No-op returns `this`. */
  remove(licenseId: string): NonCommercialLicenseList;
}

export function createNonCommercialLicenseList(
  ids: readonly string[] = DEFAULT_NON_COMMERCIAL_LICENSE_IDS,
  version = 1,
): NonCommercialLicenseList {
  const normalized = [...new Set(ids.map(normalize))].slice(0, NON_COMMERCIAL_LIST_MAX_ENTRIES);

  return {
    version,
    ids: normalized,
    includes: (licenseId) => normalized.includes(normalize(licenseId)),
    add(licenseId) {
      const key = normalize(licenseId);
      if (key.length === 0 || normalized.includes(key)) return this;
      if (normalized.length >= NON_COMMERCIAL_LIST_MAX_ENTRIES) return this;
      return createNonCommercialLicenseList([...normalized, key], version + 1);
    },
    remove(licenseId) {
      const key = normalize(licenseId);
      if (!normalized.includes(key)) return this;
      if (normalized.length <= NON_COMMERCIAL_LIST_MIN_ENTRIES) return this;
      return createNonCommercialLicenseList(
        normalized.filter((id) => id !== key),
        version + 1,
      );
    },
  };
}

function normalize(licenseId: string): string {
  return licenseId.trim().toLowerCase();
}

export interface CommercialUseRuling {
  /** Value actually recorded; may differ from the requested value (33.2). */
  readonly commercialUseAllowed: boolean;
  /** True when the request asked for `true` and the list forced `false`. */
  readonly overridden: boolean;
  /** Licence identifiers that grounded a `false` ruling (33.2). */
  readonly groundingLicenseIds: readonly string[];
  /** List version used, recorded on the asset later (33.7). */
  readonly listVersion: number;
}

/**
 * Requirements 33.2 and 33.4.
 *
 * 33.2: if either the code or the weight licence is non-commercial, record
 * `false` regardless of what the request claimed, and report the grounding
 * identifiers. 33.4: an engine is commercial only if every third-party
 * component is, so the components fold in as a conjunction.
 */
export function ruleCommercialUse(
  license: LicenseDescriptor,
  list: NonCommercialLicenseList,
  components: readonly LicenseDescriptor[] = [],
): CommercialUseRuling {
  const grounding = new Set<string>();

  for (const descriptor of [license, ...components]) {
    for (const id of [descriptor.codeLicenseId, descriptor.weightLicenseId]) {
      if (list.includes(id)) grounding.add(id);
    }
  }

  const componentsAllow = components.every((component) => component.commercialUseAllowed);
  const allowed = grounding.size === 0 && license.commercialUseAllowed && componentsAllow;

  return {
    commercialUseAllowed: allowed,
    overridden: license.commercialUseAllowed && !allowed,
    groundingLicenseIds: [...grounding].sort(),
    listVersion: list.version,
  };
}
