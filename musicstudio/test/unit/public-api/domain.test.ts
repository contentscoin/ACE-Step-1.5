import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  API_KEY_ENTROPY_BYTES,
  API_KEY_FINGERPRINT_CHARS,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  apiKeyFingerprint,
  apiKeyViolations,
  composeApiKey,
  isUsableApiKey,
  isWellFormedApiKey,
  labelViolations,
  summariseApiKey,
  type ApiKeyRecord,
} from '../../../domain/public-api/api-key';
import {
  DEFAULT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  advanceWindow,
  decideRateLimit,
  retryAfterSeconds,
  windowStartFor,
} from '../../../domain/public-api/rate-limit';
import {
  isValidWebhookUrl,
  webhookPayload,
  webhookUrlViolations,
} from '../../../domain/public-api/webhook';

/**
 * The Public_API domain.
 *
 * **Validates: Requirements 17.1, 17.2, 17.4, 17.7, 17.8, 17.9, 17.10, 17.14**
 *
 * These are the pure parts: what a key looks like, when it stops working, how many requests a
 * minute admits and when the next one may be sent. The impure halves — hashing, storage,
 * delivery — are in `service.test.ts`.
 */

const SECRET = 'A'.repeat(API_KEY_SECRET_LENGTH);

function record(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    keyId: 'key-1',
    accountId: 'account-1',
    keyHash: 'hash',
    fingerprint: `${API_KEY_PREFIX}AAAAAA`,
    label: 'production',
    createdAtMs: 1_700_000_000_000,
    revokedAtMs: null,
    ...overrides,
  };
}

describe('what a key looks like (Reqs 17.1, 17.2)', () => {
  it('accepts a key built from a 32-byte secret', () => {
    expect(isWellFormedApiKey(composeApiKey(SECRET))).toBe(true);
    // base64url of 32 bytes is 43 characters. The two constants have to agree or a real key
    // fails its own length check.
    expect(Math.ceil((API_KEY_ENTROPY_BYTES * 8) / 6)).toBe(API_KEY_SECRET_LENGTH);
  });

  it.each([
    ['sk_live_' + SECRET, 'api_key_prefix_missing'],
    [composeApiKey('A'.repeat(API_KEY_SECRET_LENGTH - 1)), 'api_key_secret_length'],
    [composeApiKey('A'.repeat(API_KEY_SECRET_LENGTH - 1) + '+'), 'api_key_secret_alphabet'],
  ])('rejects %s', (key, violation) => {
    expect(apiKeyViolations(key)).toContain(violation);
  });

  it('does not report a length violation for something that is not a key at all', () => {
    // Reporting "the secret is the wrong length" for `hello` describes a secret that does not
    // exist, and sends a caller looking for the wrong mistake.
    expect(apiKeyViolations('hello')).toEqual(['api_key_prefix_missing']);
  });

  it('rejects a label that is empty or over the bound', () => {
    expect(labelViolations('  ')).toEqual(['api_key_label_length']);
    expect(labelViolations('x'.repeat(61))).toEqual(['api_key_label_length']);
    expect(labelViolations('production')).toEqual([]);
  });
});

describe('the fingerprint (Req 17.9)', () => {
  it('names a key without revealing it', () => {
    const key = composeApiKey(SECRET);

    const fingerprint = apiKeyFingerprint(key);

    expect(fingerprint).toBe(`${API_KEY_PREFIX}${'A'.repeat(API_KEY_FINGERPRINT_CHARS)}`);
    // The whole point: what is shown cannot be used.
    expect(isWellFormedApiKey(fingerprint ?? '')).toBe(false);
  });

  it('has none for something that is not a key', () => {
    // Truncating whatever arrived would put attacker-controlled text into an operator's list.
    expect(apiKeyFingerprint('<script>alert(1)</script>')).toBeNull();
  });

  it('is derived, so it cannot drift from the key it names', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        (secret) => {
          const key = composeApiKey(secret);
          expect(apiKeyFingerprint(key)).toBe(key.slice(0, API_KEY_PREFIX.length + API_KEY_FINGERPRINT_CHARS));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('never puts the plaintext in a summary', () => {
    const summary = summariseApiKey(record());

    expect(Object.values(summary).join(' ')).not.toContain(SECRET);
    expect(Object.keys(summary).sort()).toEqual([
      'createdAtMs',
      'fingerprint',
      'keyId',
      'label',
      'revokedAtMs',
    ]);
  });
});

describe('revocation (Reqs 17.4, 17.9)', () => {
  it('stops working from the instant it is revoked, not before', () => {
    const revoked = record({ revokedAtMs: 2_000 });

    expect(isUsableApiKey(revoked, 1_999)).toBe(true);
    expect(isUsableApiKey(revoked, 2_000)).toBe(false);
    expect(isUsableApiKey(revoked, 2_001)).toBe(false);
  });

  it('a key that was never revoked is usable at any time', () => {
    expect(isUsableApiKey(record(), 0)).toBe(true);
    expect(isUsableApiKey(record(), Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('rate limiting (Reqs 17.7, 17.8)', () => {
  const MINUTE = 1_700_000_040_000; // exactly on a minute boundary

  it('admits the limit and refuses the next', () => {
    let window = null as ReturnType<typeof advanceWindow> | null;
    for (let request = 1; request <= DEFAULT_REQUESTS_PER_MINUTE; request += 1) {
      const decision = decideRateLimit(window, MINUTE);
      expect(decision.allowed, `request ${String(request)}`).toBe(true);
      window = advanceWindow(window, MINUTE);
    }

    const over = decideRateLimit(window, MINUTE);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it('counts down the remaining requests', () => {
    const first = decideRateLimit(null, MINUTE, 3);
    expect(first.remaining).toBe(2);
    expect(decideRateLimit(advanceWindow(null, MINUTE), MINUTE, 3).remaining).toBe(1);
  });

  it('starts again in the next minute', () => {
    let window = null as ReturnType<typeof advanceWindow> | null;
    for (let request = 0; request < DEFAULT_REQUESTS_PER_MINUTE; request += 1) {
      window = advanceWindow(window, MINUTE);
    }
    expect(decideRateLimit(window, MINUTE).allowed).toBe(false);

    expect(decideRateLimit(window, MINUTE + RATE_LIMIT_WINDOW_MS).allowed).toBe(true);
  });

  it('names the end of the window as the retry time (Req 17.8)', () => {
    const decision = decideRateLimit(null, MINUTE + 100, 0);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAtMs).toBe(windowStartFor(MINUTE + 100) + RATE_LIMIT_WINDOW_MS);
  });

  it('rounds Retry-After up, and never to zero', () => {
    // Rounding down names a moment still inside the window, so a client obeying the header gets
    // a second 429 — which is how a rate limit becomes a load generator.
    expect(retryAfterSeconds(MINUTE + 1_500, MINUTE)).toBe(2);
    expect(retryAfterSeconds(MINUTE + 1, MINUTE)).toBe(1);
    expect(retryAfterSeconds(MINUTE, MINUTE)).toBe(1);
    expect(retryAfterSeconds(MINUTE - 5_000, MINUTE)).toBe(1);
  });

  it('a limit of zero admits nothing', () => {
    expect(decideRateLimit(null, MINUTE, 0).allowed).toBe(false);
  });

  it('never admits more than the limit in one window, for any arrival pattern', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: RATE_LIMIT_WINDOW_MS - 1 }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 20 }),
        (offsets, limit) => {
          let window = null as ReturnType<typeof advanceWindow> | null;
          let admitted = 0;
          for (const offset of offsets) {
            const at = MINUTE + offset;
            if (decideRateLimit(window, at, limit).allowed) {
              admitted += 1;
              window = advanceWindow(window, at);
            }
          }
          expect(admitted).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('webhook URLs (Reqs 17.10, 17.14)', () => {
  it('accepts an https URL', () => {
    expect(isValidWebhookUrl('https://hooks.example.com/musicstudio')).toBe(true);
  });

  it.each([
    ['http://hooks.example.com/x', 'webhook_url_not_https'],
    ['not a url', 'webhook_url_unparseable'],
    ['https://user:secret@hooks.example.com/x', 'webhook_url_credentials'],
    [`https://hooks.example.com/${'x'.repeat(2_100)}`, 'webhook_url_length'],
  ])('rejects %s', (url, violation) => {
    expect(webhookUrlViolations(url)).toContain(violation);
  });
});

describe('the webhook payload (Reqs 17.10, 17.14)', () => {
  const source = {
    deliveryId: 'delivery-1',
    jobId: 'job-1',
    state: 'succeeded' as const,
    assetKind: 'mix' as const,
    assetIds: ['asset-1'],
    failureReason: null,
    occurredAtMs: 1_700_000_000_000,
  };

  it('carries Asset_Kind on every delivery, not only the mixdown one', () => {
    // 17.14 names it for mixdowns. A consumer that had to branch on which clause produced a
    // body would get it wrong for the kind nobody tested.
    expect(webhookPayload({ ...source, assetKind: 'song' }).assetKind).toBe('song');
    expect(webhookPayload(source).assetKind).toBe('mix');
  });

  it('carries no audio and nothing about the account', () => {
    const payload = webhookPayload(source);

    expect(Object.keys(payload).sort()).toEqual([
      'assetIds',
      'assetKind',
      'deliveryId',
      'event',
      'failureReason',
      'jobId',
      'occurredAtMs',
      'state',
    ]);
  });

  it('copies the asset ids rather than aliasing them', () => {
    const assetIds = ['asset-1'];
    const payload = webhookPayload({ ...source, assetIds });

    assetIds.push('asset-2');

    // The payload outlives the record it was built from.
    expect(payload.assetIds).toEqual(['asset-1']);
  });
});
