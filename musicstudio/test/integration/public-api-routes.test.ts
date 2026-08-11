import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API_KEY_PREFIX } from '../../domain/public-api/api-key';
import { createGatewayHarness, type GatewayHarness } from '../support/gateway-harness';

/**
 * The developer Public_API over the real gateway.
 *
 * **Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.11,
 * 17.12, 17.13**
 *
 * The task's acceptance criterion is an end-to-end one — 키 발급 → 생성 요청 → 폴링 → 결과, plus
 * a 429 — so the whole path runs: the real Fastify instance, the real schemas, the real
 * services, and the real error envelope. Only the engine and the stores are doubles.
 *
 * The rate limit is set to 3 rather than the product's 60 because a test that needed 61
 * requests to make one assertion would be a test nobody reads.
 */

let harness: GatewayHarness;

const CREDENTIALS = { email: 'developer@example.com', password: 'correct-horse-battery-staple' };

async function signIn(): Promise<string> {
  await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: CREDENTIALS,
  });
  return login.json<{ accessToken: string }>().accessToken;
}

async function issueKey(token: string, label = 'integration'): Promise<{ key: string; keyId: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { authorization: `Bearer ${token}` },
    payload: { label },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ key: string; summary: { keyId: string } }>();
  return { key: body.key, keyId: body.summary.keyId };
}

function withKey(key: string) {
  return { authorization: `Bearer ${key}` };
}

/** The harness's limit, read once rather than at every call site that loops to it. */
const LIMIT = 3;

beforeEach(() => {
  harness = createGatewayHarness({
    generation: { withSongGateway: true },
    publicApi: { requestsPerMinute: LIMIT },
  });
});

afterEach(async () => {
  await harness.close();
});

describe('issuing a key (Requirements 17.1, 17.2)', () => {
  it('returns the key once, and never again', async () => {
    const token = await signIn();

    const issued = await issueKey(token);
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(issued.key.startsWith(API_KEY_PREFIX)).toBe(true);
    // Requirement 17.1's "한 번만": the listing has the fingerprint and no key. The schema's
    // `additionalProperties: false` is what makes that true of the wire and not only of the
    // service — a key added to the payload by mistake would be stripped by the serialiser.
    expect(listed.body).not.toContain(issued.key.slice(API_KEY_PREFIX.length));
    expect(listed.json<{ keys: { fingerprint: string }[] }>().keys[0]?.fingerprint).toMatch(
      /^ms_live_.{6}$/,
    );
  });

  it('needs a session, not a key — a key cannot mint its own successor', async () => {
    // A leaked key that could issue keys makes revoking the leaked one accomplish nothing.
    const token = await signIn();
    const { key } = await issueKey(token);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: withKey(key),
      payload: { label: 'second' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an empty label', async () => {
    const token = await signIn();

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { label: '' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('authentication (Requirements 17.3, 17.4, 17.9)', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a bearer token that is not a key', 'Bearer nonsense'],
    ['a well-formed key that was never issued', `Bearer ${API_KEY_PREFIX}${'Z'.repeat(43)}`],
  ])('answers 401 for %s', async (_name, authorization) => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/job-1',
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });

    expect(response.statusCode).toBe(401);
    // One code for all of them: distinguishing "unknown" from "revoked" answers the question an
    // attacker holding a candidate key is asking.
    expect(response.json<{ error: { code: string } }>().error.code).toBe('public_api_key_invalid');
  });

  it('does not spend a key s window on a request it never authenticated', async () => {
    // The ordering claim in `public-api-authentication.ts`: authenticate, then count. The other
    // order lets an unauthenticated caller fill any key's window by guessing its identifier —
    // a denial of service delivered through the rate limiter.
    //
    // This also pins the authentication hook's *own* rejection. Without it the request would
    // reach the limiter, be counted, and only then be refused by the limiter's own guard: the
    // status code would be unchanged and the counter would not.
    const token = await signIn();
    const { key } = await issueKey(token);

    for (let attempt = 0; attempt < LIMIT * 3; attempt += 1) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/public/v1/jobs/nope',
        headers: { authorization: `Bearer ${API_KEY_PREFIX}${'Z'.repeat(43)}` },
      });
      expect(response.statusCode).toBe(401);
    }

    const admitted = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/nope',
      headers: withKey(key),
    });
    expect(admitted.headers['x-ratelimit-remaining']).toBe(String(LIMIT - 1));
  });

  it('answers 401 after the key is revoked (Requirement 17.9)', async () => {
    const token = await signIn();
    const { key, keyId } = await issueKey(token);

    // Works before.
    expect(
      (await harness.app.inject({ method: 'GET', url: '/public/v1/jobs/nope', headers: withKey(key) }))
        .statusCode,
    ).not.toBe(401);

    await harness.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const after = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/nope',
      headers: withKey(key),
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('the acceptance criterion: issue → submit → poll (Requirements 17.5, 17.6, 17.11)', () => {
  it('accepts a song request, returns an identifier, and polls it', async () => {
    const token = await signIn();
    const { key } = await issueKey(token);

    const submitted = await harness.app.inject({
      method: 'POST',
      url: '/public/v1/generations/song',
      headers: withKey(key),
      payload: { mode: 'simple', description: 'a calm piano piece' },
    });

    // 202, not 201: Requirement 17.5 returns an identifier and processes asynchronously, so
    // nothing has been created yet.
    expect(submitted.statusCode).toBe(202);
    const { jobId, assetKind } = submitted.json<{ jobId: string; assetKind: string }>();
    expect(jobId).toBeTruthy();
    // Requirement 17.11's separate endpoints: the kind comes from the path.
    expect(assetKind).toBe('song');

    const polled = await harness.app.inject({
      method: 'GET',
      url: `/public/v1/jobs/${jobId}`,
      headers: withKey(key),
    });

    expect(polled.statusCode).toBe(200);
    expect(polled.json<{ jobId: string }>().jobId).toBe(jobId);
  });

  it('refuses a request that the gateway s own validation rejects', async () => {
    // The façade does not validate: it calls the same gateway the signed-in surface calls, so a
    // malformed request is refused by the one implementation rather than by a second copy of it.
    const token = await signIn();
    const { key } = await issueKey(token);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/public/v1/generations/song',
      headers: withKey(key),
      payload: { mode: 'simple', description: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('cannot read another account s job', async () => {
    const tokenA = await signIn();
    const { key: keyA } = await issueKey(tokenA);
    const submitted = await harness.app.inject({
      method: 'POST',
      url: '/public/v1/generations/song',
      headers: withKey(keyA),
      payload: { mode: 'simple', description: 'a calm piano piece' },
    });
    const { jobId } = submitted.json<{ jobId: string }>();

    await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'other@example.com', password: CREDENTIALS.password },
    });
    const otherLogin = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'other@example.com', password: CREDENTIALS.password },
    });
    const { key: keyB } = await issueKey(otherLogin.json<{ accessToken: string }>().accessToken, 'b');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/public/v1/jobs/${jobId}`,
      headers: withKey(keyB),
    });

    // 403, because that is what the orchestrator answers on the signed-in surface too
    // (Requirement 11.9 fixes the code). The claim under test is that the API applies the
    // *same* rule, not a second one written for it — so the assertion follows the orchestrator
    // rather than the other way round.
    expect(response.statusCode).toBe(403);
  });
});

describe('rate limiting (Requirements 17.7, 17.8)', () => {
  it('answers 429 with a retry time once the key is over its limit', async () => {
    const token = await signIn();
    const { key } = await issueKey(token);

    for (let request = 0; request < LIMIT; request += 1) {
      const admitted = await harness.app.inject({
        method: 'GET',
        url: '/public/v1/jobs/nope',
        headers: withKey(key),
      });
      expect(admitted.statusCode).not.toBe(429);
    }

    const refused = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/nope',
      headers: withKey(key),
    });

    expect(refused.statusCode).toBe(429);
    const body = refused.json<{ error: { code: string; retryAtMs: number; retryAfterSeconds: number } }>();
    expect(body.error.code).toBe('public_api_rate_limited');
    // Requirement 17.8 asks for 재시도 가능 시각 — an instant, not only a duration.
    expect(body.error.retryAtMs).toBeGreaterThan(harness.clock.now().getTime());
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each key separately', async () => {
    const token = await signIn();
    const { key: first } = await issueKey(token, 'first');
    const { key: second } = await issueKey(token, 'second');

    for (let request = 0; request < LIMIT; request += 1) {
      await harness.app.inject({ method: 'GET', url: '/public/v1/jobs/nope', headers: withKey(first) });
    }

    const other = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/nope',
      headers: withKey(second),
    });
    expect(other.statusCode).not.toBe(429);
  });

  it('starts again in the next minute', async () => {
    const token = await signIn();
    const { key } = await issueKey(token);
    for (let request = 0; request < LIMIT; request += 1) {
      await harness.app.inject({ method: 'GET', url: '/public/v1/jobs/nope', headers: withKey(key) });
    }
    expect(
      (await harness.app.inject({ method: 'GET', url: '/public/v1/jobs/nope', headers: withKey(key) }))
        .statusCode,
    ).toBe(429);

    harness.clock.set(new Date(harness.clock.now().getTime() + 60_000));

    const after = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/nope',
      headers: withKey(key),
    });
    expect(after.statusCode).not.toBe(429);
  });

  it('tells an admitted caller where it stands', async () => {
    // Headers on success are what let a client pace itself rather than discover the ceiling by
    // hitting it.
    const token = await signIn();
    const { key } = await issueKey(token);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/nope',
      headers: withKey(key),
    });

    expect(response.headers['x-ratelimit-limit']).toBe('3');
    expect(response.headers['x-ratelimit-remaining']).toBe('2');
  });

  it('does not count a request it refused', async () => {
    // The stored count stays bounded by the limit, so the next window starts from zero and
    // `remaining` is meaningful rather than a clamped negative. It does not shorten the
    // lockout — see `rate-limiter.ts` for why that plausible version is false.
    const token = await signIn();
    const { key } = await issueKey(token);
    const limit = LIMIT;
    for (let request = 0; request < limit + 5; request += 1) {
      await harness.app.inject({ method: 'GET', url: '/public/v1/jobs/nope', headers: withKey(key) });
    }

    harness.clock.set(new Date(harness.clock.now().getTime() + 60_000));

    const response = await harness.app.inject({
      method: 'GET',
      url: '/public/v1/jobs/nope',
      headers: withKey(key),
    });
    expect(response.headers['x-ratelimit-remaining']).toBe(String(limit - 1));
  });
});

describe('the webhook endpoint (Requirements 17.10, 17.14)', () => {
  it('registers an https URL and refuses anything else', async () => {
    const token = await signIn();
    const { keyId } = await issueKey(token);
    const authorization = { authorization: `Bearer ${token}` };

    const accepted = await harness.app.inject({
      method: 'PUT',
      url: `/v1/api-keys/${keyId}/webhook`,
      headers: authorization,
      payload: { url: 'https://hooks.example.com/musicstudio' },
    });
    expect(accepted.statusCode).toBe(204);

    const refused = await harness.app.inject({
      method: 'PUT',
      url: `/v1/api-keys/${keyId}/webhook`,
      headers: authorization,
      payload: { url: 'http://hooks.example.com/musicstudio' },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('answers 404 for another account s key', async () => {
    const token = await signIn();
    const { keyId } = await issueKey(token);

    await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'other@example.com', password: CREDENTIALS.password },
    });
    const otherLogin = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'other@example.com', password: CREDENTIALS.password },
    });

    const response = await harness.app.inject({
      method: 'PUT',
      url: `/v1/api-keys/${keyId}/webhook`,
      headers: { authorization: `Bearer ${otherLogin.json<{ accessToken: string }>().accessToken}` },
      payload: { url: 'https://hooks.example.com/x' },
    });

    expect(response.statusCode).toBe(404);
  });
});
