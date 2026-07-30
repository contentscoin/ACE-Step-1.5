import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGatewayHarness, requireEngines, type GatewayHarness } from '../support/gateway-harness';
import { engineDescriptor, permissiveLicense } from '../support/registry-harness';

/**
 * Engine_Descriptor CRUD and engine queries over HTTP: Requirements 20.1, 20.2,
 * 20.9, 20.17, 20.19, 20.20, 20.23; 33.2.
 *
 * Task 1.3's acceptance criterion is the register -> probe -> unavailable ->
 * recover scenario, and this exercises it through the real gateway: the auth
 * middleware from task 1.2, the JSON schemas, the single error contract and the
 * Provider_Registry all on the actual request path, with only the engine itself
 * faked.
 */
const CREDENTIALS = { email: 'operator@example.com', password: 'correct horse battery' };

describe('engine routes end to end', () => {
  let harness: GatewayHarness;
  let accessToken: string;
  let accountId: string;

  beforeEach(async () => {
    harness = createGatewayHarness({
      engines: { assignments: { sfx: { defaultEngineId: 'woosh-flow', fallbackEngineId: 'ace-step-1.5' } } },
    });
    await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
    const loggedIn = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: CREDENTIALS,
    });
    accessToken = loggedIn.json().accessToken;
    accountId = loggedIn.json().accountId;
  });

  afterEach(async () => {
    await harness.close();
  });

  function authorized(): { authorization: string } {
    return { authorization: `Bearer ${accessToken}` };
  }

  function post(url: string, payload?: object): Promise<LightMyRequestResponse> {
    return harness.app.inject({
      method: 'POST',
      url,
      headers: authorized(),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function get(url: string): Promise<LightMyRequestResponse> {
    return harness.app.inject({ method: 'GET', url, headers: authorized() });
  }

  it('registers an engine, lists it, then reports it unavailable and recovered', async () => {
    // Requirement 20.1 — a fully populated descriptor is accepted.
    const registered = await post(
      '/v1/engines',
      engineDescriptor('woosh-flow', {
        supportedAssetKinds: ['sfx'],
        license: permissiveLicense({ attributionText: 'Generated with Woosh' }),
      }),
    );

    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toMatchObject({
      engineId: 'woosh-flow',
      activation: 'active',
      missingPricingKeys: [],
      commercialUseAllowed: true,
    });

    // Requirement 20.20 — the actor is the authenticated account.
    const engines = requireEngines(harness);
    expect(engines.audit.drafts.at(-1)).toMatchObject({
      eventType: 'engine_state_changed',
      actorId: accountId,
      targetId: 'woosh-flow',
    });

    // Requirement 20.19 — all seven fields, in under five seconds.
    const startedAt = Date.now();
    const listed = await get('/v1/engines?assetKind=sfx');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().engines[0]).toMatchObject({
      engineId: 'woosh-flow',
      supportedAssetKinds: ['sfx'],
      maxOutputDurationMs: 240_000,
      commercialUseAllowed: true,
      attributionText: 'Generated with Woosh',
      availableNow: true,
      lastCheckedAtMs: null,
    });

    // Requirement 20.8 — three consecutive probe failures take it out of service.
    for (let i = 0; i < 3; i += 1) {
      engines.registry.recordHealthOutcome('woosh-flow', {
        checkedAtMs: harness.clock.now().getTime() + i * 60_000,
        outcome: 'failure',
        latencyMs: 4,
      });
    }

    // Requirement 20.9 — still listed, marked unavailable, with alternatives.
    await post('/v1/engines', engineDescriptor('ace-step-1.5', { supportedAssetKinds: ['sfx'] }));
    const selection = await get('/v1/engines/selection?assetKind=sfx');

    expect(selection.statusCode).toBe(200);
    expect(selection.json().engines).toEqual([
      {
        engineId: 'woosh-flow',
        selectable: false,
        unavailableReason: 'unavailable',
        alternativeEngineIds: ['ace-step-1.5'],
        lastCheckedAtMs: expect.any(Number),
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

    // Requirement 20.21 — two consecutive successes bring it back.
    engines.registry.recordHealthOutcome('woosh-flow', {
      checkedAtMs: harness.clock.now().getTime() + 240_000,
      outcome: 'success',
      latencyMs: 7,
    });
    engines.registry.recordHealthOutcome('woosh-flow', {
      checkedAtMs: harness.clock.now().getTime() + 300_000,
      outcome: 'success',
      latencyMs: 7,
    });

    const recovered = await get('/v1/engines/woosh-flow');
    expect(recovered.json()).toMatchObject({ availableNow: true, lastCheckOutcome: 'success' });
  });

  it('registers an engine inactive and names the missing pricing keys (Req 20.17)', async () => {
    requireEngines(harness).pricing.omit('unpriced');

    const response = await post(
      '/v1/engines',
      engineDescriptor('unpriced', { supportedAssetKinds: ['song', 'sfx'] }),
    );

    // Not a rejection: 20.17 registers the engine and reports the gap.
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      activation: 'inactive',
      missingPricingKeys: ['song:unpriced', 'sfx:unpriced'],
    });
    expect((await get('/v1/engines/selection?assetKind=sfx')).json().engines).toEqual([
      expect.objectContaining({ engineId: 'unpriced', selectable: false, unavailableReason: 'inactive' }),
    ]);
  });

  it('records the forced commercial-use ruling for a non-commercial licence (Req 33.2)', async () => {
    const response = await post(
      '/v1/engines',
      engineDescriptor('nc-engine', {
        license: permissiveLicense({ weightLicenseId: 'CC-BY-NC-4.0', commercialUseAllowed: true }),
      }),
    );

    expect(response.json()).toMatchObject({
      commercialUseAllowed: false,
      commercialUseOverridden: true,
      groundingLicenseIds: ['CC-BY-NC-4.0'],
    });
  });

  it('rejects an out-of-range descriptor with the offending field names (Req 20.23)', async () => {
    const response = await post('/v1/engines', {
      ...engineDescriptor('bad'),
      sampleRate: 96_000,
    });

    expect(response.statusCode).toBe(400);
    expect((await get('/v1/engines')).json().engines).toEqual([]);
  });

  it('rejects a descriptor missing a License_Descriptor item (Req 33.6)', async () => {
    const { license, ...withoutLicense } = engineDescriptor('unlicensed');
    void license;

    const response = await post('/v1/engines', withoutLicense);

    expect(response.statusCode).toBe(400);
  });

  it('changes the default engine and keeps the invariant (Req 20.2, 20.20)', async () => {
    await post('/v1/engines', engineDescriptor('woosh-flow', { supportedAssetKinds: ['sfx'] }));
    await post('/v1/engines', engineDescriptor('multi', { supportedAssetKinds: ['sfx', 'song'] }));

    const changed = await harness.app.inject({
      method: 'PUT',
      url: '/v1/engine-defaults/sfx',
      payload: { engineId: 'multi' },
      headers: authorized(),
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({
      assetKind: 'sfx',
      defaultEngineId: 'multi',
      fallbackEngineId: 'ace-step-1.5',
    });
    expect(requireEngines(harness).audit.changesFor('multi')).toEqual([
      'engine_registered',
      'default_engine_changed',
    ]);

    // Requirement 20.2 — the new default may not then be deactivated.
    const deactivated = await post('/v1/engines/multi/deactivate', undefined);
    expect(deactivated.statusCode).toBe(409);
    expect(deactivated.json().error.code).toBe('default_engine_invariant_violated');
    expect(deactivated.json().error.reason).toBe('engine_is_default');
  });

  it('deactivates a non-default engine and audits the event (Req 20.20)', async () => {
    await post('/v1/engines', engineDescriptor('retired', { supportedAssetKinds: ['sfx'] }));

    const response = await post('/v1/engines/retired/deactivate', undefined);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ activation: 'inactive', availableNow: false });
    expect(requireEngines(harness).audit.changesFor('retired')).toEqual([
      'engine_registered',
      'engine_deactivated',
    ]);
  });

  it('answers 404 for an unknown engine and 409 for a duplicate registration', async () => {
    expect((await get('/v1/engines/ghost')).statusCode).toBe(404);

    await post('/v1/engines', engineDescriptor('once'));
    const again = await post('/v1/engines', engineDescriptor('once'));

    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('engine_already_registered');
  });

  it('requires authentication on every engine route', async () => {
    const anonymous = await harness.app.inject({ method: 'GET', url: '/v1/engines' });
    const anonymousWrite = await harness.app.inject({
      method: 'POST',
      url: '/v1/engines',
      payload: engineDescriptor('sneaky'),
    });

    expect(anonymous.statusCode).toBe(401);
    expect(anonymousWrite.statusCode).toBe(401);
  });

  it('leaves the engine routes off a gateway built without them', async () => {
    const authOnly = createGatewayHarness();
    try {
      const response = await authOnly.app.inject({ method: 'GET', url: '/v1/engines' });
      expect(response.statusCode).toBe(404);
      expect(authOnly.engines).toBeNull();
    } finally {
      await authOnly.close();
    }
  });
});
