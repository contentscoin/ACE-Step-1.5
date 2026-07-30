import { describe, expect, it } from 'vitest';

import {
  createNonCommercialLicenseList,
  ruleCommercialUse,
} from '../../../adapters/registry/non-commercial-licenses';
import { permissiveLicense } from '../../support/registry-harness';

/** Requirements 33.2, 33.3, 33.4 — the ruling Requirement 20.1 stores per engine. */
describe('non-commercial licence ruling (Req 33.2–33.4)', () => {
  const list = createNonCommercialLicenseList(['CC-BY-NC-4.0', 'research-only'], 7);

  it('forces commercial use to false and reports the grounding identifier (Req 33.2)', () => {
    const ruling = ruleCommercialUse(
      permissiveLicense({ weightLicenseId: 'CC-BY-NC-4.0', commercialUseAllowed: true }),
      list,
    );

    expect(ruling.commercialUseAllowed).toBe(false);
    expect(ruling.overridden).toBe(true);
    expect(ruling.groundingLicenseIds).toEqual(['CC-BY-NC-4.0']);
    expect(ruling.listVersion).toBe(7);
  });

  it('matches the list case-insensitively', () => {
    expect(
      ruleCommercialUse(permissiveLicense({ codeLicenseId: 'cc-by-nc-4.0' }), list)
        .commercialUseAllowed,
    ).toBe(false);
  });

  it('leaves a permissive licence permitted and not overridden', () => {
    const ruling = ruleCommercialUse(permissiveLicense(), list);

    expect(ruling.commercialUseAllowed).toBe(true);
    expect(ruling.overridden).toBe(false);
    expect(ruling.groundingLicenseIds).toEqual([]);
  });

  it('does not mark a request that already asked for false as overridden', () => {
    const ruling = ruleCommercialUse(
      permissiveLicense({ weightLicenseId: 'research-only', commercialUseAllowed: false }),
      list,
    );

    expect(ruling.commercialUseAllowed).toBe(false);
    expect(ruling.overridden).toBe(false);
  });

  it('is permitted only when every third-party component is (Req 33.4)', () => {
    const allPermissive = ruleCommercialUse(permissiveLicense(), list, [
      permissiveLicense(),
      permissiveLicense(),
    ]);
    const oneRestricted = ruleCommercialUse(permissiveLicense(), list, [
      permissiveLicense(),
      permissiveLicense({ commercialUseAllowed: false }),
    ]);
    const oneNonCommercialId = ruleCommercialUse(permissiveLicense(), list, [
      permissiveLicense({ codeLicenseId: 'research-only' }),
    ]);

    expect(allPermissive.commercialUseAllowed).toBe(true);
    expect(oneRestricted.commercialUseAllowed).toBe(false);
    expect(oneNonCommercialId.commercialUseAllowed).toBe(false);
    expect(oneNonCommercialId.groundingLicenseIds).toEqual(['research-only']);
  });

  it('bumps the list version by exactly 1 on each add and remove (Req 33.3)', () => {
    const base = createNonCommercialLicenseList(['CC-BY-NC-4.0', 'research-only'], 3);

    const added = base.add('OpenRAIL-NC');
    expect(added.version).toBe(4);
    expect(added.includes('openrail-nc')).toBe(true);

    const removed = added.remove('research-only');
    expect(removed.version).toBe(5);
    expect(removed.includes('research-only')).toBe(false);
  });

  it('does not bump the version when the edit changes nothing', () => {
    const base = createNonCommercialLicenseList(['CC-BY-NC-4.0', 'research-only'], 3);

    expect(base.add('CC-BY-NC-4.0').version).toBe(3);
    expect(base.remove('MIT').version).toBe(3);
  });

  it('keeps at least one entry in the list (Req 33.3 lower bound)', () => {
    const single = createNonCommercialLicenseList(['CC-BY-NC-4.0'], 1);

    expect(single.remove('CC-BY-NC-4.0').ids).toEqual(['cc-by-nc-4.0']);
    expect(single.remove('CC-BY-NC-4.0').version).toBe(1);
  });
});
