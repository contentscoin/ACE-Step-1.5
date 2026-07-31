import { describe, expect, it } from 'vitest';

import { isRegistryError, type RegistryError } from '../../../adapters/registry/errors';
import { routeGenerationRequest } from '../../../adapters/registry/routing';
import {
  createFrozenCreditBalance,
  createRegistryHarness,
  engineDescriptor,
} from '../../support/registry-harness';

/**
 * Routing and single-hop fallback: Requirements 20.3, 20.4, 20.5, 20.6, 20.10,
 * 20.11, 20.13, 20.22, and the "credit balance unchanged" clauses of 20.11,
 * 20.13 and 20.22.
 */

function expectRejection(fn: () => unknown): RegistryError {
  try {
    fn();
  } catch (error) {
    if (isRegistryError(error)) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

/** Two engines for `sfx`, matching design §3.6 (Woosh default, ACE fallback). */
function sfxHarness() {
  const harness = createRegistryHarness({
    assignments: {
      sfx: { defaultEngineId: 'woosh-flow', fallbackEngineId: 'ace-step-1.5' },
    },
  });
  harness.register(
    engineDescriptor('woosh-flow', { supportedAssetKinds: ['sfx'], maxOutputDurationMs: 10_000 }),
  );
  harness.register(
    engineDescriptor('ace-step-1.5', {
      supportedAssetKinds: ['song', 'bgm', 'sfx', 'stem'],
      maxOutputDurationMs: 240_000,
    }),
  );
  return harness;
}

/** Marks an engine unavailable through three consecutive failures (Req 20.8). */
function failThreeTimes(harness: ReturnType<typeof sfxHarness>, engineId: string): void {
  for (let i = 0; i < 3; i += 1) {
    harness.registry.recordHealthOutcome(engineId, {
      checkedAtMs: harness.clock.now().getTime() + i * 60_000,
      outcome: 'failure',
      latencyMs: 5,
    });
  }
}

describe('explicit engine routing (Req 20.3, 20.5, 20.6, 20.22)', () => {
  it('routes to the named engine and echoes its identifier (Req 20.3)', () => {
    const harness = sfxHarness();

    const decision = routeGenerationRequest(harness.registry, {
      assetKind: 'sfx',
      durationMs: 5_000,
      engineId: 'woosh-flow',
    });

    expect(decision.engineId).toBe('woosh-flow');
    expect(decision.substituted).toBe(false);
    expect(decision.substitutionReason).toBeUndefined();
  });

  it('rejects an unsupported Asset_Kind and returns the supporting engines (Req 20.5)', () => {
    const harness = sfxHarness();

    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, {
        assetKind: 'song',
        durationMs: 5_000,
        engineId: 'woosh-flow',
      }),
    );

    expect(error.code).toBe('asset_kind_unsupported');
    expect(error.details.supportingEngineIds).toEqual(['ace-step-1.5']);
  });

  it('rejects an over-long output and returns that engine maximum (Req 20.6)', () => {
    const harness = sfxHarness();

    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, {
        assetKind: 'sfx',
        durationMs: 10_001,
        engineId: 'woosh-flow',
      }),
    );

    expect(error.code).toBe('output_duration_exceeded');
    expect(error.details).toMatchObject({
      engineId: 'woosh-flow',
      requestedDurationMs: 10_001,
      maxOutputDurationMs: 10_000,
    });
  });

  it('accepts an output exactly at the maximum', () => {
    const harness = sfxHarness();

    expect(
      routeGenerationRequest(harness.registry, {
        assetKind: 'sfx',
        durationMs: 10_000,
        engineId: 'woosh-flow',
      }).engineId,
    ).toBe('woosh-flow');
  });

  it('rejects an unavailable explicit engine instead of substituting (Req 20.22)', () => {
    const harness = sfxHarness();
    const balance = createFrozenCreditBalance(500);
    failThreeTimes(harness, 'woosh-flow');

    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, {
        assetKind: 'sfx',
        durationMs: 5_000,
        engineId: 'woosh-flow',
      }),
    );

    expect(error.code).toBe('engine_unavailable');
    expect(error.details).toMatchObject({ engineId: 'woosh-flow', reason: 'unavailable' });
    // A fallback exists for `sfx`, and it must *not* have been used.
    expect(error.details.availableEngineIds).toEqual(['ace-step-1.5']);
    expect(balance.balance).toBe(500);
  });

  it('rejects an inactive explicit engine and says so (Req 20.22)', () => {
    const harness = sfxHarness();
    // A non-default engine: Requirement 20.2 forbids deactivating a default,
    // so the "inactive" case has to be built from an ordinary engine.
    harness.register(engineDescriptor('retired-sfx', { supportedAssetKinds: ['sfx'] }));
    harness.registry.setActivation('retired-sfx', 'inactive', 'operator-1');

    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, {
        assetKind: 'sfx',
        durationMs: 5_000,
        engineId: 'retired-sfx',
      }),
    );

    expect(error.code).toBe('engine_unavailable');
    expect(error.details.reason).toBe('inactive');
    // The healthy same-kind engines are offered, but nothing was substituted.
    expect(error.details.availableEngineIds).toEqual(['woosh-flow', 'ace-step-1.5']);
  });

  it('rejects an unknown engine identifier', () => {
    const harness = sfxHarness();

    expect(
      expectRejection(() =>
        routeGenerationRequest(harness.registry, {
          assetKind: 'sfx',
          durationMs: 5_000,
          engineId: 'nope',
        }),
      ).code,
    ).toBe('engine_not_found');
  });
});

describe('default engine routing and single re-route (Req 20.4, 20.10, 20.11)', () => {
  it('uses the kind default when no engine is named (Req 20.4)', () => {
    const harness = sfxHarness();

    const decision = routeGenerationRequest(harness.registry, {
      assetKind: 'sfx',
      durationMs: 5_000,
    });

    expect(decision.engineId).toBe('woosh-flow');
    expect(decision.substituted).toBe(false);
  });

  it('re-routes once to the alternative and reports the reason (Req 20.10)', () => {
    const harness = sfxHarness();
    failThreeTimes(harness, 'woosh-flow');

    const decision = routeGenerationRequest(harness.registry, {
      assetKind: 'sfx',
      durationMs: 5_000,
    });

    expect(decision.engineId).toBe('ace-step-1.5');
    expect(decision.substituted).toBe(true);
    expect(decision.substitutionReason).toBe('default_engine_unavailable');
    expect(decision.replacedEngineId).toBe('woosh-flow');
  });

  it('does not re-route a second time when the alternative is also down (Req 20.11)', () => {
    const harness = sfxHarness();
    const balance = createFrozenCreditBalance(120);
    failThreeTimes(harness, 'woosh-flow');
    failThreeTimes(harness, 'ace-step-1.5');

    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, { assetKind: 'sfx', durationMs: 5_000 }),
    );

    expect(error.code).toBe('no_available_engine');
    expect(error.details.candidates).toEqual([
      { engineId: 'woosh-flow', lastCheckedAtMs: expect.any(Number), lastCheckOutcome: 'failure' },
      { engineId: 'ace-step-1.5', lastCheckedAtMs: expect.any(Number), lastCheckOutcome: 'failure' },
    ]);
    expect(balance.balance).toBe(120);
  });

  it('does not re-route for a kind with no configured alternative (Req 20.10 WHERE)', () => {
    const harness = createRegistryHarness({
      assignments: { song: { defaultEngineId: 'ace-step-1.5' } },
    });
    harness.register(engineDescriptor('ace-step-1.5', { supportedAssetKinds: ['song'] }));
    harness.register(engineDescriptor('other-song-engine', { supportedAssetKinds: ['song'] }));
    for (let i = 0; i < 3; i += 1) {
      harness.registry.recordHealthOutcome('ace-step-1.5', {
        checkedAtMs: 1_000 + i,
        outcome: 'failure',
        latencyMs: 1,
      });
    }

    // `other-song-engine` supports `song` and is healthy, but it is not the
    // configured alternative, so 20.10 does not apply and the request is refused.
    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, { assetKind: 'song', durationMs: 5_000 }),
    );

    expect(error.code).toBe('no_available_engine');
  });

  it('rejects when the alternative cannot satisfy the requested length', () => {
    const harness = createRegistryHarness({
      assignments: { sfx: { defaultEngineId: 'woosh-flow', fallbackEngineId: 'short-engine' } },
    });
    harness.register(engineDescriptor('woosh-flow', { supportedAssetKinds: ['sfx'] }));
    harness.register(
      engineDescriptor('short-engine', {
        supportedAssetKinds: ['sfx'],
        maxOutputDurationMs: 2_000,
      }),
    );
    for (let i = 0; i < 3; i += 1) {
      harness.registry.recordHealthOutcome('woosh-flow', {
        checkedAtMs: 1_000 + i,
        outcome: 'failure',
        latencyMs: 1,
      });
    }

    expect(
      expectRejection(() =>
        routeGenerationRequest(harness.registry, { assetKind: 'sfx', durationMs: 9_000 }),
      ).code,
    ).toBe('no_available_engine');
  });

  it('rejects when the kind default engine is not registered at all (Req 20.11)', () => {
    const harness = createRegistryHarness();

    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, { assetKind: 'dialogue', durationMs: 5_000 }),
    );

    expect(error.code).toBe('no_available_engine');
    expect(error.details.candidates).toEqual([]);
  });

  it('returns to the default engine once it recovers (Req 20.21 seen from routing)', () => {
    const harness = sfxHarness();
    failThreeTimes(harness, 'woosh-flow');
    expect(
      routeGenerationRequest(harness.registry, { assetKind: 'sfx', durationMs: 5_000 }).engineId,
    ).toBe('ace-step-1.5');

    harness.registry.recordHealthOutcome('woosh-flow', {
      checkedAtMs: 500_000,
      outcome: 'success',
      latencyMs: 8,
    });
    harness.registry.recordHealthOutcome('woosh-flow', {
      checkedAtMs: 560_000,
      outcome: 'success',
      latencyMs: 8,
    });

    const decision = routeGenerationRequest(harness.registry, {
      assetKind: 'sfx',
      durationMs: 5_000,
    });
    expect(decision.engineId).toBe('woosh-flow');
    expect(decision.substituted).toBe(false);
  });
});

describe('quota-driven rejection (Req 20.13)', () => {
  it('rejects with the next reset instant and the usable alternatives', () => {
    const harness = createRegistryHarness({ startAt: new Date('2025-03-01T20:00:00.000Z') });
    harness.register(
      engineDescriptor('metered', {
        supportedAssetKinds: ['sfx'],
        dailyQuota: { maxRequests: 2, maxGpuSeconds: 50 },
      }),
    );
    harness.register(engineDescriptor('spare', { supportedAssetKinds: ['sfx'] }));
    const balance = createFrozenCreditBalance(90);

    harness.registry.quotas.consume('metered', { requests: 2, gpuSeconds: 2 });

    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, {
        assetKind: 'sfx',
        durationMs: 5_000,
        engineId: 'metered',
      }),
    );

    expect(error.code).toBe('engine_quota_exhausted');
    expect(error.details).toMatchObject({
      engineId: 'metered',
      exhausted: ['requests'],
      nextResetAtMs: Date.parse('2025-03-02T00:00:00.000Z'),
      availableEngineIds: ['spare'],
    });
    expect(balance.balance).toBe(90);
  });

  it('routes again after the 00:00 UTC reset (Req 20.12)', () => {
    const harness = createRegistryHarness({ startAt: new Date('2025-03-01T23:59:00.000Z') });
    harness.register(
      engineDescriptor('metered', {
        supportedAssetKinds: ['sfx'],
        dailyQuota: { maxRequests: 1, maxGpuSeconds: 50 },
      }),
    );
    harness.registry.quotas.consume('metered', { requests: 1, gpuSeconds: 1 });

    expect(
      expectRejection(() =>
        routeGenerationRequest(harness.registry, {
          assetKind: 'sfx',
          durationMs: 5_000,
          engineId: 'metered',
        }),
      ).code,
    ).toBe('engine_quota_exhausted');

    harness.clock.advanceSeconds(60);

    expect(
      routeGenerationRequest(harness.registry, {
        assetKind: 'sfx',
        durationMs: 5_000,
        engineId: 'metered',
      }).engineId,
    ).toBe('metered');
  });

  it('counts GPU seconds per request from the descriptor', () => {
    const harness = createRegistryHarness();
    harness.register(
      engineDescriptor('gpu-hungry', {
        supportedAssetKinds: ['sfx'],
        gpuSecondsPerRequest: 30,
        dailyQuota: { maxRequests: 100, maxGpuSeconds: 40 },
      }),
    );

    expect(harness.registry.quotaRequirementFor('gpu-hungry')).toEqual({
      requests: 1,
      gpuSeconds: 30,
    });

    harness.registry.quotas.consume('gpu-hungry', { requests: 1, gpuSeconds: 30 });
    const error = expectRejection(() =>
      routeGenerationRequest(harness.registry, {
        assetKind: 'sfx',
        durationMs: 5_000,
        engineId: 'gpu-hungry',
      }),
    );

    expect(error.details.exhausted).toEqual(['gpuSeconds']);
  });
});
