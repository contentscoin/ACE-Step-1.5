import { describe, expect, it } from 'vitest';

import {
  DEEPAFX_ENGINE_ID,
  DEEPAFX_LICENSE,
  DEEPAFX_SUGGESTION_TIMEOUT_MS,
  DEEPAFX_WEIGHT_LICENSE_ID,
  deepAfxEngineDescriptor,
} from '../../../adapters/deepafx/license';
import {
  DEEPAFX_SUGGEST_PATH,
  SuggestionModelUnavailableError,
  createDeepAfxAdapter,
} from '../../../adapters/deepafx/deepafx-adapter';
import { validateLicenseDescriptor } from '../../../adapters/registry/license-descriptor';
import {
  createNonCommercialLicenseList,
  ruleCommercialUse,
} from '../../../adapters/registry/non-commercial-licenses';
import { validateEngineDescriptor } from '../../../adapters/registry/descriptor-validation';
import { resolveCommercialUseOnWrite } from '../../../domain/commercial-use';
import { SUGGESTION_TIMEOUT_MS } from '../../../domain/mastering/bounds';
import {
  START_LOUDNESS_LUFS,
  START_TRUE_PEAK_DBTP,
  VALID_SUGGESTION_ITEMS,
  audioRef,
  createFakeDeepAfxTransport,
  createTimingOutRunner,
  immediateTimeoutRunner,
  measurement,
} from '../../support/mastering-harness';

/**
 * `DeepAFx_Adapter` — the 120-second budget, the fallback trigger, and the licence route.
 *
 * **Validates: Requirements 30.19, 30.20, 30.21, 30.23, 33.1, 33.2, 33.5, 33.6, 33.21, 33.22**
 *
 * **DeepAFx is not reachable from this environment and its licence is non-commercial**, so
 * every test here runs against the in-memory transport in `test/support/mastering-harness.ts`.
 * That is not a limitation for what needs proving: Requirements 30.20 and 30.21 are about the
 * *absence* of a response, and the timeout path is only testable at all through the injectable
 * runner — the alternative is a test that waits two minutes, which means a branch nobody
 * checks.
 *
 * The licence tests do not check a new mechanism. They check that DeepAFx's non-commercial
 * identifier reaches the *existing* ruling, and that the ruling overrides a descriptor that
 * claimed otherwise — which is the property Requirement 33.2 exists to guarantee.
 */

const SUGGEST_REQUEST = { source: audioRef(), measurement: measurement() };

function ok(chain: unknown = VALID_SUGGESTION_ITEMS) {
  return { httpStatus: 200, envelope: { chain, model: DEEPAFX_ENGINE_ID } };
}

describe('Requirement 30.20 — the 120-second budget', () => {
  it('is the number `domain/mastering/bounds.ts` declares, not a second literal', () => {
    expect(DEEPAFX_SUGGESTION_TIMEOUT_MS).toBe(SUGGESTION_TIMEOUT_MS);
    expect(DEEPAFX_SUGGESTION_TIMEOUT_MS).toBe(120_000);
  });

  it('declares the service unavailable when the budget elapses', async () => {
    // Tested through the injectable runner rather than by waiting: see the module comment.
    const transport = createFakeDeepAfxTransport(ok());
    const adapter = createDeepAfxAdapter({
      transport,
      commercialUseAllowed: false,
      timeoutRunner: createTimingOutRunner(SUGGESTION_TIMEOUT_MS),
    });

    await expect(adapter.suggest(SUGGEST_REQUEST)).rejects.toThrow(
      SuggestionModelUnavailableError,
    );
  });

  it('reports the reason and the budget on the timeout, so 30.21 can log why', async () => {
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport(ok()),
      commercialUseAllowed: false,
      timeoutRunner: createTimingOutRunner(SUGGESTION_TIMEOUT_MS),
    });

    await adapter.suggest(SUGGEST_REQUEST).then(
      () => expect.fail('expected the call to be refused'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(SuggestionModelUnavailableError);
        const unavailable = error as SuggestionModelUnavailableError;
        expect(unavailable.reason).toBe('timed_out');
        expect(unavailable.budgetMs).toBe(120_000);
      },
    );
  });

  it('does not start the operation once the budget has elapsed', async () => {
    // A transport that would have succeeded must not be able to mask the timeout.
    const transport = createFakeDeepAfxTransport(ok());
    const adapter = createDeepAfxAdapter({
      transport,
      commercialUseAllowed: false,
      timeoutRunner: createTimingOutRunner(SUGGESTION_TIMEOUT_MS),
    });

    await adapter.suggest(SUGGEST_REQUEST).catch(() => undefined);

    expect(transport.requests).toHaveLength(0);
  });

  it('cannot be configured above the clause\u2019s ceiling', async () => {
    // `Math.min`, not `??`: a configuration asking for 300 s would silently breach 30.20.
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport(ok()),
      commercialUseAllowed: false,
      timeoutMs: 300_000,
      timeoutRunner: {
        async run(_operation, budgetMs) {
          return { kind: 'timed_out', budgetMs };
        },
      },
    });

    await adapter.suggest(SUGGEST_REQUEST).then(
      () => expect.fail('expected the call to be refused'),
      (error: unknown) => {
        expect((error as SuggestionModelUnavailableError).budgetMs).toBe(120_000);
      },
    );
  });

  it('can be shortened, which is how a test narrows the budget', async () => {
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport(ok()),
      commercialUseAllowed: false,
      timeoutMs: 25,
      timeoutRunner: {
        async run(_operation, budgetMs) {
          return { kind: 'timed_out', budgetMs };
        },
      },
    });

    await adapter.suggest(SUGGEST_REQUEST).then(
      () => expect.fail('expected the call to be refused'),
      (error: unknown) => {
        expect((error as SuggestionModelUnavailableError).budgetMs).toBe(25);
      },
    );
  });
});

describe('the happy path', () => {
  it('returns the chain unvalidated, for Requirement 30.2 to judge', async () => {
    // A suggestion the adapter had already coerced into range would make 30.2's invariant
    // unfalsifiable.
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport(ok()),
      commercialUseAllowed: false,
      timeoutRunner: immediateTimeoutRunner,
    });

    const response = await adapter.suggest(SUGGEST_REQUEST);

    expect(response.items).toEqual(VALID_SUGGESTION_ITEMS);
  });

  it('sends the measurements rather than making the service re-measure', async () => {
    // Two BS.1770-4 implementations in the loop would make Requirement 30.24's agreement a
    // three-way problem.
    const transport = createFakeDeepAfxTransport(ok());
    const adapter = createDeepAfxAdapter({
      transport,
      commercialUseAllowed: false,
      timeoutRunner: immediateTimeoutRunner,
    });

    await adapter.suggest(SUGGEST_REQUEST);

    expect(transport.requests[0]?.path).toBe(DEEPAFX_SUGGEST_PATH);
    expect(transport.requests[0]?.body).toMatchObject({
      audio: { object_key: 'audio/original.flac', sample_rate: 48_000 },
      measurement: {
        integrated_loudness_lufs: START_LOUDNESS_LUFS,
        true_peak_dbtp: START_TRUE_PEAK_DBTP,
      },
    });
  });

  it('sends all ten band energies', async () => {
    const transport = createFakeDeepAfxTransport(ok());
    const adapter = createDeepAfxAdapter({
      transport,
      commercialUseAllowed: false,
      timeoutRunner: immediateTimeoutRunner,
    });

    await adapter.suggest(SUGGEST_REQUEST);

    const body = transport.requests[0]?.body as {
      measurement: { octave_bands: readonly unknown[] };
    };
    expect(body.measurement.octave_bands).toHaveLength(10);
  });
});

describe('Requirement 30.21 — every unavailable state reaches the fallback the same way', () => {
  it('treats a transport failure as unavailable', async () => {
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport(() => Promise.reject(new Error('ECONNREFUSED'))),
      commercialUseAllowed: false,
      timeoutRunner: immediateTimeoutRunner,
    });

    await adapter.suggest(SUGGEST_REQUEST).then(
      () => expect.fail('expected the call to be refused'),
      (error: unknown) => {
        expect((error as SuggestionModelUnavailableError).reason).toBe('transport_failed');
      },
    );
  });

  it('treats a non-2xx status as unavailable', async () => {
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport({ httpStatus: 503, envelope: {} }),
      commercialUseAllowed: false,
      timeoutRunner: immediateTimeoutRunner,
    });

    await adapter.suggest(SUGGEST_REQUEST).then(
      () => expect.fail('expected the call to be refused'),
      (error: unknown) => {
        const unavailable = error as SuggestionModelUnavailableError;
        expect(unavailable.reason).toBe('transport_failed');
        expect(unavailable.detail).toBe('HTTP 503');
      },
    );
  });

  it('treats a 2xx body with no chain as unavailable', async () => {
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport({ httpStatus: 200, envelope: { model: 'x' } }),
      commercialUseAllowed: false,
      timeoutRunner: immediateTimeoutRunner,
    });

    await adapter.suggest(SUGGEST_REQUEST).then(
      () => expect.fail('expected the call to be refused'),
      (error: unknown) => {
        expect((error as SuggestionModelUnavailableError).reason).toBe('malformed_response');
      },
    );
  });
});

describe('Requirements 33.1, 33.2, 33.6 — the licence descriptor', () => {
  it('is a valid License_Descriptor', () => {
    expect(validateLicenseDescriptor(DEEPAFX_LICENSE)).toEqual([]);
  });

  it('states the non-commercial weight licence honestly', () => {
    expect(DEEPAFX_LICENSE.weightLicenseId).toBe(DEEPAFX_WEIGHT_LICENSE_ID);
    expect(DEEPAFX_LICENSE.commercialUseAllowed).toBe(false);
  });

  it('carries a terms-of-service link, as Requirement 33.5 asks of a remote model', () => {
    expect(deepAfxEngineDescriptor().executionLocation).toBe('remote');
    expect(DEEPAFX_LICENSE.termsOfServiceUrl).toBeDefined();
  });

  it('produces a valid Engine_Descriptor', () => {
    expect(validateEngineDescriptor(deepAfxEngineDescriptor())).toEqual([]);
  });
});

describe('Requirement 33.2 — the ruling overrides the descriptor, in both directions', () => {
  it('records `false` because the weight licence is on the non-commercial list', () => {
    const list = createNonCommercialLicenseList();

    const ruling = ruleCommercialUse(DEEPAFX_LICENSE, list);

    expect(ruling.commercialUseAllowed).toBe(false);
    // The grounding identifier comes back as the descriptor spelled it, not lower-cased: the
    // list matches case-insensitively but reports what it was given, so an operator reading
    // the audit entry sees the string on the model.
    expect(ruling.groundingLicenseIds).toContain(DEEPAFX_WEIGHT_LICENSE_ID);
    expect(ruling.listVersion).toBe(list.version);
  });

  it('still records `false` if the descriptor is edited to claim otherwise', () => {
    // The property Requirement 33.2 exists to guarantee: a future editor who "corrects"
    // `commercialUseAllowed` to true finds the registry overriding them and saying why. This
    // is the non-bypassable half of the gate — there is no argument to any of this that
    // could widen permission.
    const ruling = ruleCommercialUse(
      { ...DEEPAFX_LICENSE, commercialUseAllowed: true },
      createNonCommercialLicenseList(),
    );

    expect(ruling.commercialUseAllowed).toBe(false);
    expect(ruling.overridden).toBe(true);
  });
});

describe('Requirements 30.23, 33.21, 33.22 — the ruling reaches the asset', () => {
  it('folds into the asset\u2019s commercial-use flag as one term of a conjunction', () => {
    // Requirement 30.23: an asset a DeepAFx suggestion was applied to is recorded as
    // non-commercial. Not a second mechanism — the suggestion carries the ruling and
    // `resolveCommercialUseOnWrite` folds it in.
    const ruling = ruleCommercialUse(DEEPAFX_LICENSE, createNonCommercialLicenseList());

    const stored = resolveCommercialUseOnWrite(
      { provenanceAllowed: true, engineAllowed: [true, ruling.commercialUseAllowed] },
      [true],
    );

    expect(stored).toBe(false);
  });

  it('cannot be widened by a permissive parent or provenance', () => {
    // A conjunction: no other input can make the result true once one term is false. This is
    // what makes Requirement 33.22's refusal non-bypassable.
    for (const provenanceAllowed of [true, false]) {
      for (const parents of [[true], [true, true], []]) {
        expect(
          resolveCommercialUseOnWrite({ provenanceAllowed, engineAllowed: [false] }, parents),
        ).toBe(false);
      }
    }
  });

  it('the adapter passes the ruling through and cannot alter it', async () => {
    const adapter = createDeepAfxAdapter({
      transport: createFakeDeepAfxTransport(ok()),
      commercialUseAllowed: false,
      timeoutRunner: immediateTimeoutRunner,
    });

    const response = await adapter.suggest(SUGGEST_REQUEST);

    expect(response.commercialUseAllowed).toBe(false);
  });
});
