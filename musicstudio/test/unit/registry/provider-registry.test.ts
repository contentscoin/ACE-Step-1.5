import { describe, expect, it } from 'vitest';

import { ASSET_KINDS } from '../../../domain/asset-kind';
import { isRegistryError } from '../../../adapters/registry/errors';
import { selectionCatalogueFor } from '../../../adapters/registry/selection-catalogue';
import {
  createRegistryHarness,
  engineDescriptor,
  permissiveLicense,
} from '../../support/registry-harness';

/**
 * Registration, pricing gate, defaults, listing, selection list and audit:
 * Requirements 20.1, 20.2, 20.9, 20.16, 20.17, 20.19, 20.20, 20.23; 33.2.
 */
describe('engine registration (Req 20.1, 20.16, 20.17, 20.23)', () => {
  it('registers a valid engine as active', () => {
    const harness = createRegistryHarness();

    const result = harness.registry.register({
      descriptor: engineDescriptor('ace-step-1.5'),
      adapter: harness.adapterFactory.create({
        engineId: 'ace-step-1.5',
        executionLocation: 'remote',
      })!,
      actorId: 'operator-1',
    });

    expect(result.activation).toBe('active');
    expect(result.missingPricingKeys).toEqual([]);
    expect(harness.registry.has('ace-step-1.5')).toBe(true);
  });

  it('rejects an invalid descriptor with the field name list (Req 20.23)', () => {
    const harness = createRegistryHarness();

    try {
      harness.register(engineDescriptor('bad', { sampleRate: 96_000 }));
      throw new Error('expected rejection');
    } catch (error) {
      if (!isRegistryError(error)) throw error;
      expect(error.code).toBe('engine_descriptor_invalid');
      expect(error.details.invalidFields).toEqual(['sampleRate']);
    }
    expect(harness.registry.has('bad')).toBe(false);
  });

  it('registers inactive and reports the missing pricing keys (Req 20.16, 20.17)', () => {
    const harness = createRegistryHarness();
    harness.pricing.omit('unpriced');

    const adapter = harness.adapterFactory.create({
      engineId: 'unpriced',
      executionLocation: 'local',
    })!;
    const result = harness.registry.register({
      descriptor: engineDescriptor('unpriced', { supportedAssetKinds: ['song', 'sfx'] }),
      adapter,
      actorId: 'operator-1',
    });

    expect(result.activation).toBe('inactive');
    expect(result.missingPricingKeys).toEqual(['song:unpriced', 'sfx:unpriced']);
    // Registered, but not selectable while inactive.
    expect(harness.registry.has('unpriced')).toBe(true);
    expect(harness.registry.availableEnginesSupporting('song')).toEqual([]);
  });

  it('records the forced commercial-use ruling on registration (Req 33.2)', () => {
    const harness = createRegistryHarness();

    const result = harness.registry.register({
      descriptor: engineDescriptor('nc-engine', {
        license: permissiveLicense({
          weightLicenseId: 'CC-BY-NC-4.0',
          commercialUseAllowed: true,
        }),
      }),
      adapter: harness.adapterFactory.create({
        engineId: 'nc-engine',
        executionLocation: 'remote',
      })!,
      actorId: 'operator-1',
    });

    expect(result.commercialUseAllowed).toBe(false);
    expect(result.commercialUseOverridden).toBe(true);
    expect(result.groundingLicenseIds).toEqual(['CC-BY-NC-4.0']);
  });

  it('refuses a duplicate engine identifier', () => {
    const harness = createRegistryHarness();
    harness.register(engineDescriptor('dup'));

    expect(() => harness.register(engineDescriptor('dup'))).toThrowError(/already registered/);
  });
});

describe('default engine invariant (Req 20.2)', () => {
  it('assigns exactly one default per Asset_Kind out of the box', () => {
    const harness = createRegistryHarness();

    for (const assetKind of ASSET_KINDS) {
      expect(harness.registry.defaultEngineIdFor(assetKind)).toBeTypeOf('string');
    }
  });

  it('accepts a default that supports the kind and is active', () => {
    const harness = createRegistryHarness();
    harness.register(engineDescriptor('multi', { supportedAssetKinds: ['song', 'bgm', 'sfx'] }));

    harness.registry.setDefaultEngine('sfx', 'multi', 'operator-1');

    expect(harness.registry.defaultEngineIdFor('sfx')).toBe('multi');
  });

  it('preserves the configured alternative when the default changes', () => {
    const harness = createRegistryHarness({
      assignments: { sfx: { defaultEngineId: 'old', fallbackEngineId: 'spare' } },
    });
    harness.register(engineDescriptor('replacement', { supportedAssetKinds: ['sfx'] }));

    harness.registry.setDefaultEngine('sfx', 'replacement', 'operator-1');

    expect(harness.registry.assignmentFor('sfx')).toEqual({
      defaultEngineId: 'replacement',
      fallbackEngineId: 'spare',
    });
  });

  it.each([
    ['an engine that does not support the kind', 'unsupported_asset_kind', ['song'] as const],
    ['an unregistered engine', 'engine_not_found', undefined],
  ])('refuses %s as the default', (_label, reason, supportedAssetKinds) => {
    const harness = createRegistryHarness();
    if (supportedAssetKinds !== undefined) {
      harness.register(engineDescriptor('narrow', { supportedAssetKinds: [...supportedAssetKinds] }));
    }

    try {
      harness.registry.setDefaultEngine('sfx', supportedAssetKinds ? 'narrow' : 'ghost', 'op');
      throw new Error('expected rejection');
    } catch (error) {
      if (!isRegistryError(error)) throw error;
      expect(error.code).toBe('default_engine_invariant_violated');
      expect(error.details.reason).toBe(reason);
    }
  });

  it('refuses an inactive engine as the default', () => {
    const harness = createRegistryHarness();
    harness.pricing.omit('unpriced');
    harness.registry.register({
      descriptor: engineDescriptor('unpriced', { supportedAssetKinds: ['sfx'] }),
      adapter: harness.adapterFactory.create({
        engineId: 'unpriced',
        executionLocation: 'local',
      })!,
      actorId: 'op',
    });

    expect(() => harness.registry.setDefaultEngine('sfx', 'unpriced', 'op')).toThrowError(
      /cannot be the default/,
    );
  });

  it('refuses to deactivate or delete an engine that is a default', () => {
    const harness = createRegistryHarness({ assignments: { sfx: { defaultEngineId: 'pinned' } } });
    harness.register(engineDescriptor('pinned', { supportedAssetKinds: ['sfx'] }));

    expect(() => harness.registry.setActivation('pinned', 'inactive', 'op')).toThrowError(
      /cannot be the default/,
    );
    expect(() => harness.registry.remove('pinned', 'op')).toThrowError(/cannot be the default/);
  });

  it('refuses a descriptor update that drops support for a kind it defaults for', () => {
    const harness = createRegistryHarness({ assignments: { sfx: { defaultEngineId: 'pinned' } } });
    harness.register(engineDescriptor('pinned', { supportedAssetKinds: ['sfx', 'song'] }));

    expect(() =>
      harness.registry.update(
        'pinned',
        engineDescriptor('pinned', { supportedAssetKinds: ['song'] }),
        'op',
      ),
    ).toThrowError(/cannot be the default/);
  });

  it('reports the kinds whose default is not registered', () => {
    const harness = createRegistryHarness();

    const violations = harness.registry.defaultEngineInvariantViolations();

    expect(violations).toContain('song:default_not_registered');
    expect(violations.length).toBe(ASSET_KINDS.length);
  });
});

describe('engine list query (Req 20.19)', () => {
  it('returns all seven required fields within 5 seconds', () => {
    const harness = createRegistryHarness();
    harness.register(
      engineDescriptor('ace-step-1.5', {
        supportedAssetKinds: ['song', 'bgm'],
        maxOutputDurationMs: 240_000,
        license: permissiveLicense({ attributionText: 'Generated with ACE-Step' }),
      }),
    );
    harness.registry.recordHealthOutcome('ace-step-1.5', {
      checkedAtMs: 1_741_000_000_000,
      outcome: 'success',
      latencyMs: 11,
    });

    const startedAt = Date.now();
    const listings = harness.registry.listEngines();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(listings).toEqual([
      {
        engineId: 'ace-step-1.5',
        supportedAssetKinds: ['song', 'bgm'],
        maxOutputDurationMs: 240_000,
        commercialUseAllowed: true,
        attributionText: 'Generated with ACE-Step',
        availableNow: true,
        lastCheckedAtMs: 1_741_000_000_000,
        lastCheckOutcome: 'success',
        activation: 'active',
      },
    ]);
  });

  it('reports a never-probed engine with a null last check time', () => {
    const harness = createRegistryHarness();
    harness.register(engineDescriptor('fresh'));

    expect(harness.registry.listEngines()[0]).toMatchObject({
      lastCheckedAtMs: null,
      lastCheckOutcome: null,
    });
  });
});

describe('selection list while unavailable (Req 20.9)', () => {
  it('marks the engine unavailable and offers same-kind alternatives', () => {
    const harness = createRegistryHarness({
      assignments: { sfx: { defaultEngineId: 'woosh-flow', fallbackEngineId: 'ace-step-1.5' } },
    });
    harness.register(engineDescriptor('woosh-flow', { supportedAssetKinds: ['sfx'] }));
    harness.register(engineDescriptor('ace-step-1.5', { supportedAssetKinds: ['sfx', 'song'] }));
    for (let i = 0; i < 3; i += 1) {
      harness.registry.recordHealthOutcome('woosh-flow', {
        checkedAtMs: 2_000 + i,
        outcome: 'failure',
        latencyMs: 1,
      });
    }

    const catalogue = selectionCatalogueFor(harness.registry, 'sfx');

    expect(catalogue).toEqual([
      {
        engineId: 'woosh-flow',
        selectable: false,
        unavailableReason: 'unavailable',
        alternativeEngineIds: ['ace-step-1.5'],
        lastCheckedAtMs: 2_002,
        lastCheckOutcome: 'failure',
        isDefault: true,
      },
      {
        engineId: 'ace-step-1.5',
        selectable: true,
        unavailableReason: null,
        alternativeEngineIds: [],
        lastCheckedAtMs: null,
        lastCheckOutcome: null,
        isDefault: false,
      },
    ]);
  });

  it('distinguishes an operator-deactivated engine from a failing one', () => {
    const harness = createRegistryHarness({ assignments: { sfx: { defaultEngineId: 'other' } } });
    harness.register(engineDescriptor('other', { supportedAssetKinds: ['sfx'] }));
    harness.register(engineDescriptor('retired', { supportedAssetKinds: ['sfx'] }));
    harness.registry.setActivation('retired', 'inactive', 'operator-1');

    const entry = selectionCatalogueFor(harness.registry, 'sfx').find(
      (candidate) => candidate.engineId === 'retired',
    );

    expect(entry).toMatchObject({ selectable: false, unavailableReason: 'inactive' });
  });
});

describe('audit trail (Req 20.20)', () => {
  it('records all five registry events with actor, target and both values', () => {
    const harness = createRegistryHarness({ assignments: { sfx: { defaultEngineId: 'seed' } } });
    harness.register(engineDescriptor('seed', { supportedAssetKinds: ['sfx'] }));
    harness.register(engineDescriptor('worker', { supportedAssetKinds: ['sfx'] }), 'operator-7');

    // unavailable transition
    for (let i = 0; i < 3; i += 1) {
      harness.registry.recordHealthOutcome('worker', {
        checkedAtMs: 10_000 + i,
        outcome: 'failure',
        latencyMs: 1,
      });
    }
    // recovery transition
    harness.registry.recordHealthOutcome('worker', {
      checkedAtMs: 20_000,
      outcome: 'success',
      latencyMs: 1,
    });
    harness.registry.recordHealthOutcome('worker', {
      checkedAtMs: 20_001,
      outcome: 'success',
      latencyMs: 1,
    });
    // default change, then deactivation
    harness.registry.setDefaultEngine('sfx', 'worker', 'operator-7');
    harness.registry.setActivation('seed', 'inactive', 'operator-7');

    expect(harness.audit.changesFor('worker')).toEqual([
      'engine_registered',
      'engine_became_unavailable',
      'engine_became_available',
      'default_engine_changed',
    ]);
    expect(harness.audit.changesFor('seed')).toEqual(['engine_registered', 'engine_deactivated']);

    const unavailableEvent = harness.audit.drafts.find(
      (draft) => (draft.afterValue as { change?: string }).change === 'engine_became_unavailable',
    );
    expect(unavailableEvent).toMatchObject({
      eventType: 'engine_state_changed',
      // Health transitions are automated, so there is no operator actor.
      actorId: null,
      targetId: 'worker',
      beforeValue: { state: { availability: 'available' } },
      afterValue: { state: { availability: 'unavailable' } },
    });
    // Requirement 20.20 requires the event time in milliseconds.
    expect(unavailableEvent?.eventTime?.getTime()).toBe(10_002);

    const registration = harness.audit.drafts.find(
      (draft) =>
        draft.targetId === 'worker' &&
        (draft.afterValue as { change?: string }).change === 'engine_registered',
    );
    expect(registration).toMatchObject({ actorId: 'operator-7', beforeValue: null });
  });

  it('records a License_Descriptor change with both values (Req 33.16)', () => {
    const harness = createRegistryHarness();
    harness.register(engineDescriptor('licensed'));

    harness.registry.update(
      'licensed',
      engineDescriptor('licensed', {
        license: permissiveLicense({ attributionText: 'Updated attribution' }),
      }),
      'operator-3',
    );

    const licenseEvent = harness.audit.drafts.find(
      (draft) => draft.eventType === 'license_changed',
    );
    expect(licenseEvent).toMatchObject({ actorId: 'operator-3', targetId: 'licensed' });
    expect((licenseEvent?.afterValue as { attributionText: string }).attributionText).toBe(
      'Updated attribution',
    );
  });
});
