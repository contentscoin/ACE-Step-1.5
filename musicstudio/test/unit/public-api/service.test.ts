import { describe, expect, it } from 'vitest';

import { createApiKeyAuthenticationHook } from '../../../api/gateway/public-api-authentication';
import { API_KEY_PREFIX, isWellFormedApiKey } from '../../../domain/public-api/api-key';
import { GenerationError } from '../../../services/generation/errors';
import { createApiKeyService } from '../../../services/public-api/api-key-service';
import {
  createRateLimiter,
  inMemoryRateLimitStore,
} from '../../../services/public-api/rate-limiter';
import {
  WEBHOOK_MAX_ATTEMPTS,
  createWebhookDispatcher,
} from '../../../services/public-api/webhook-dispatcher';
import { createMutableClock } from '../../support/mutable-clock';
import {
  inMemoryApiKeyStore,
  inMemoryWebhookStore,
  recordingWebhookSender,
  sequentialIdSource,
  sequentialSecretSource,
  testHasher,
} from '../../support/public-api-harness';

/**
 * The Public_API services.
 *
 * **Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.7, 17.8, 17.9, 17.10, 17.14**
 *
 * The claims worth making here are all about what the code *cannot* do: the key cannot be
 * recovered after issue, a revoked key cannot authenticate, a refused request cannot extend its
 * own lockout, and a broken customer endpoint cannot fail a job.
 */

const NOW = 1_700_000_040_000;

function build() {
  const keys = inMemoryApiKeyStore();
  const webhooks = inMemoryWebhookStore();
  const clock = createMutableClock(new Date(NOW));

  const service = createApiKeyService({
    keys,
    webhooks,
    clock,
    hasher: testHasher,
    secrets: sequentialSecretSource(),
    ids: sequentialIdSource('key'),
  });

  return { service, keys, webhooks, clock };
}

describe('issuing a key (Reqs 17.1, 17.2)', () => {
  it('returns the key once and stores only its hash', async () => {
    const { service, keys } = build();

    const issued = await service.issue('account-1', 'production');

    expect(isWellFormedApiKey(issued.key)).toBe(true);
    const stored = keys.rows.get(issued.summary.keyId);
    expect(stored?.keyHash).toBe(testHasher.hash(issued.key));
    // The stored row, serialised whole, must not contain the key anywhere in it.
    expect(JSON.stringify(stored)).not.toContain(issued.key.slice(API_KEY_PREFIX.length));
  });

  it('has no second way to ask for it', async () => {
    const { service } = build();
    const issued = await service.issue('account-1', 'production');

    const listed = await service.list('account-1');

    // Requirement 17.1's "한 번만" is a property of there being nowhere else to read it.
    expect(JSON.stringify(listed)).not.toContain(issued.key.slice(API_KEY_PREFIX.length));
    expect(listed[0]?.fingerprint).toBe(issued.summary.fingerprint);
  });

  it('refuses a label that is empty or too long', async () => {
    const { service } = build();

    await expect(service.issue('account-1', '   ')).rejects.toThrow(GenerationError);
    await expect(service.issue('account-1', 'x'.repeat(61))).rejects.toThrow(GenerationError);
  });

  it('lists newest first', async () => {
    const { service, clock } = build();
    await service.issue('account-1', 'first');
    clock.set(new Date(NOW + 1_000));
    await service.issue('account-1', 'second');

    expect((await service.list('account-1')).map((key) => key.label)).toEqual([
      'second',
      'first',
    ]);
  });
});

describe('authenticating (Reqs 17.3, 17.4, 17.9)', () => {
  it('accepts the key it issued', async () => {
    const { service } = build();
    const issued = await service.issue('account-1', 'production');

    expect(await service.authenticate(issued.key)).toMatchObject({
      accountId: 'account-1',
      keyId: issued.summary.keyId,
    });
  });

  it.each([
    ['nothing', null],
    ['a malformed key', 'not-a-key'],
    ['a well-formed key that was never issued', `${API_KEY_PREFIX}${'Z'.repeat(43)}`],
  ])('answers null for %s', async (_name, candidate) => {
    const { service } = build();

    expect(await service.authenticate(candidate)).toBeNull();
  });

  it('stops accepting a revoked key from the instant it is revoked', async () => {
    const { service, clock } = build();
    const issued = await service.issue('account-1', 'production');

    clock.set(new Date(NOW + 5_000));
    await service.revoke('account-1', issued.summary.keyId);

    expect(await service.authenticate(issued.key)).toBeNull();
  });

  it('does not hash a candidate it has already rejected on shape', async () => {
    // Not an optimisation: hashing arbitrary caller input and looking it up is a lookup that can
    // be made to match. This asserts the store is never consulted for a malformed candidate.
    const keys = inMemoryApiKeyStore();
    let lookups = 0;
    const service = createApiKeyService({
      keys: {
        ...keys,
        findByHash: async (hash) => {
          lookups += 1;
          return keys.findByHash(hash);
        },
      },
      hasher: testHasher,
      secrets: sequentialSecretSource(),
      ids: sequentialIdSource('key'),
    });

    expect(await service.authenticate('bearer-ish nonsense')).toBeNull();
    expect(lookups).toBe(0);
  });
});

describe('revoking (Req 17.9)', () => {
  it('is idempotent and keeps the first instant', async () => {
    const { service, clock } = build();
    const issued = await service.issue('account-1', 'production');

    clock.set(new Date(NOW + 1_000));
    const first = await service.revoke('account-1', issued.summary.keyId);
    clock.set(new Date(NOW + 9_000));
    const second = await service.revoke('account-1', issued.summary.keyId);

    expect(second.revokedAtMs).toBe(first.revokedAtMs);
  });

  it('answers 404 rather than 403 for another account s key', async () => {
    const { service } = build();
    const issued = await service.issue('account-1', 'production');

    // A 403 would confirm the identifier names a real key on some other account.
    const error = await service
      .revoke('account-2', issued.summary.keyId)
      .catch((thrown: unknown) => thrown as GenerationError);

    expect((error as GenerationError).statusCode).toBe(404);
  });
});

describe('the webhook endpoint (Reqs 17.10, 17.14)', () => {
  it('registers an https URL against the key', async () => {
    const { service, webhooks } = build();
    const issued = await service.issue('account-1', 'production');

    await service.setWebhook('account-1', issued.summary.keyId, 'https://hooks.example.com/x');

    expect(webhooks.rows.get(issued.summary.keyId)).toBe('https://hooks.example.com/x');
  });

  it('refuses a URL that is not https, and stores nothing', async () => {
    const { service, webhooks } = build();
    const issued = await service.issue('account-1', 'production');

    await expect(
      service.setWebhook('account-1', issued.summary.keyId, 'http://hooks.example.com/x'),
    ).rejects.toThrow(GenerationError);
    expect(webhooks.rows.size).toBe(0);
  });

  it('refuses to set one on another account s key', async () => {
    const { service } = build();
    const issued = await service.issue('account-1', 'production');

    await expect(
      service.setWebhook('account-2', issued.summary.keyId, 'https://hooks.example.com/x'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('rate limiting (Reqs 17.7, 17.8)', () => {
  function limiter() {
    const clock = createMutableClock(new Date(NOW));
    return { limiter: createRateLimiter({ store: inMemoryRateLimitStore(), clock }), clock };
  }

  it('admits up to the limit and then refuses with the retry time', async () => {
    const { limiter: rate } = limiter();

    await rate.consume('key-1', 2);
    await rate.consume('key-1', 2);

    const error = await rate.consume('key-1', 2).catch((thrown: unknown) => thrown as GenerationError);

    expect((error as GenerationError).statusCode).toBe(429);
    expect((error as GenerationError).code).toBe('public_api_rate_limited');
    expect((error as GenerationError).details.retryAtMs).toBe(NOW + 60_000);
    expect((error as GenerationError).details.retryAfterSeconds).toBe(60);
  });

  it('counts each key separately', async () => {
    const { limiter: rate } = limiter();
    await rate.consume('key-1', 1);

    await expect(rate.consume('key-2', 1)).resolves.toMatchObject({ allowed: true });
  });

  it('leaves the stored count at the limit however many refusals follow', async () => {
    // The observable claim, and the only one: a refused request is not counted, so the number
    // in the store stays bounded by the limit. It does *not* shorten a lockout — with a fixed
    // window nothing does, because the window rolls over on the clock rather than on the count.
    const store = inMemoryRateLimitStore();
    const rate = createRateLimiter({ store, clock: createMutableClock(new Date(NOW)) });

    await rate.consume('key-1', 1);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await rate.consume('key-1', 1).catch(() => undefined);
    }

    expect((await store.peek('key-1', NOW))?.count).toBe(1);
  });

  it('reports how many the window has left', async () => {
    const { limiter: rate } = limiter();

    expect((await rate.consume('key-1', 3)).remaining).toBe(2);
    expect((await rate.consume('key-1', 3)).remaining).toBe(1);
  });
});

describe('dispatching a webhook (Reqs 17.10, 17.14)', () => {
  const JOB = {
    jobId: 'job-1',
    state: 'succeeded' as const,
    assetKind: 'mix' as const,
    assetIds: ['asset-1'],
    failureReason: null,
  };

  function dispatcher(
    results?: readonly { delivered: boolean; statusCode: number | null; error: string | null }[],
    endpoint: string | null = 'https://hooks.example.com/x',
  ) {
    const sender = recordingWebhookSender(results);
    return {
      sender,
      dispatcher: createWebhookDispatcher({
        sender,
        ids: sequentialIdSource('delivery'),
        clock: createMutableClock(new Date(NOW)),
        endpointFor: async () => endpoint,
      }),
    };
  }

  it('sends the result with the Asset_Kind', async () => {
    const { dispatcher: dispatch, sender } = dispatcher();

    const outcome = await dispatch.onJobTerminal('key-1', JOB);

    expect(outcome.delivered).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.payload).toMatchObject({ assetKind: 'mix', jobId: 'job-1' });
  });

  it('does nothing when no endpoint is registered', async () => {
    const { dispatcher: dispatch, sender } = dispatcher(undefined, null);

    expect((await dispatch.onJobTerminal('key-1', JOB)).attempted).toBe(false);
    expect(sender.sent).toEqual([]);
  });

  it('does nothing for a job that did not come through the API', async () => {
    const { dispatcher: dispatch, sender } = dispatcher();

    expect((await dispatch.onJobTerminal(null, JOB)).attempted).toBe(false);
    expect(sender.sent).toEqual([]);
  });

  it('retries a 5xx up to the attempt bound', async () => {
    const { dispatcher: dispatch, sender } = dispatcher([
      { delivered: false, statusCode: 503, error: null },
    ]);

    const outcome = await dispatch.onJobTerminal('key-1', JOB);

    expect(outcome.delivered).toBe(false);
    expect(outcome.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(sender.sent).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
  });

  it('retries a transport error', async () => {
    const { sender } = dispatcher();
    const { dispatcher: dispatch, sender: failing } = dispatcher([
      { delivered: false, statusCode: null, error: 'ECONNREFUSED' },
      { delivered: true, statusCode: 200, error: null },
    ]);

    const outcome = await dispatch.onJobTerminal('key-1', JOB);

    expect(outcome.delivered).toBe(true);
    expect(failing.sent).toHaveLength(2);
    expect(sender.sent).toEqual([]);
  });

  it('does not retry a 4xx', async () => {
    // The endpoint understood the request and refused it. Retrying that is load, not recovery.
    const { dispatcher: dispatch, sender } = dispatcher([
      { delivered: false, statusCode: 410, error: null },
    ]);

    const outcome = await dispatch.onJobTerminal('key-1', JOB);

    expect(outcome.attempts).toBe(1);
    expect(sender.sent).toHaveLength(1);
  });

  it('never throws, so a broken endpoint cannot fail a job', async () => {
    const { dispatcher: dispatch } = dispatcher([
      { delivered: false, statusCode: 500, error: 'boom' },
    ]);

    await expect(dispatch.onJobTerminal('key-1', JOB)).resolves.toMatchObject({
      delivered: false,
    });
  });

  it('gives each delivery its own identifier', async () => {
    const { dispatcher: dispatch } = dispatcher();

    const first = await dispatch.onJobTerminal('key-1', JOB);
    const second = await dispatch.onJobTerminal('key-1', JOB);

    expect(first.payload?.deliveryId).not.toBe(second.payload?.deliveryId);
  });
});

describe('the authentication hook itself (Req 17.4)', () => {
  /**
   * Tested directly rather than only through the gateway, because through the gateway it is
   * *masked*: the rate-limit hook runs next and refuses an unauthenticated request too, so
   * removing this hook's own rejection changes no status code and no counter. The redundancy is
   * deliberate defence in depth; it also means the composition cannot show this hook working.
   */
  function fakeRequest(authorization?: string) {
    return {
      headers: authorization === undefined ? {} : { authorization },
      authenticatedApiKey: null as unknown,
    };
  }

  async function hookFor(key?: string) {
    const { service } = build();
    const hook = createApiKeyAuthenticationHook(service);
    const request = fakeRequest(key === undefined ? undefined : `Bearer ${key}`);
    // The hook only reads `headers` and writes `authenticatedApiKey`.
    await (hook as unknown as (req: unknown, reply: unknown) => Promise<void>)(request, {});
    return request;
  }

  it('rejects a request carrying no key', async () => {
    await expect(hookFor()).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a key that was never issued', async () => {
    await expect(hookFor(`${API_KEY_PREFIX}${'Z'.repeat(43)}`)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('admits a key that was, and records who it belongs to', async () => {
    const { service } = build();
    const issued = await service.issue('account-1', 'production');
    const hook = createApiKeyAuthenticationHook(service);
    const request = fakeRequest(`Bearer ${issued.key}`);

    await (hook as unknown as (req: unknown, reply: unknown) => Promise<void>)(request, {});

    expect(request.authenticatedApiKey).toMatchObject({ accountId: 'account-1' });
  });
});
