/**
 * In-memory doubles for the Public_API's four seams.
 *
 * The stores are the domain functions over a `Map`, so a test exercises the same rules a SQL
 * implementation would have to reproduce rather than a simplified stand-in.
 */

import { createHash } from 'node:crypto';

import type { ApiKeyRecord } from '../../domain/public-api/api-key';
import { DEFAULT_REQUESTS_PER_MINUTE } from '../../domain/public-api/rate-limit';
import type { Clock } from '../../services/clock';
import {
  createApiKeyService,
  type ApiKeyService,
} from '../../services/public-api/api-key-service';
import {
  cryptoApiKeySecretSource,
  sha256ApiKeyHasher,
} from '../../services/public-api/crypto-sources';
import {
  createRateLimiter,
  inMemoryRateLimitStore,
  type RateLimiter,
} from '../../services/public-api/rate-limiter';
import type {
  ApiKeyHasher,
  ApiKeySecretSource,
  ApiKeyStore,
  IdSource,
  WebhookDeliveryResult,
  WebhookEndpointStore,
  WebhookSenderPort,
} from '../../services/public-api/ports';

export interface InMemoryApiKeyStore extends ApiKeyStore {
  readonly rows: Map<string, ApiKeyRecord>;
}

export function inMemoryApiKeyStore(seed: readonly ApiKeyRecord[] = []): InMemoryApiKeyStore {
  const rows = new Map<string, ApiKeyRecord>(seed.map((record) => [record.keyId, record]));

  return {
    rows,
    async insert(record) {
      rows.set(record.keyId, record);
    },
    async findByHash(keyHash) {
      return [...rows.values()].find((record) => record.keyHash === keyHash) ?? null;
    },
    async findById(keyId) {
      return rows.get(keyId) ?? null;
    },
    async listForAccount(accountId) {
      return [...rows.values()].filter((record) => record.accountId === accountId);
    },
    async revoke(keyId, revokedAtMs) {
      const existing = rows.get(keyId);
      if (existing === undefined) return null;
      const next: ApiKeyRecord = { ...existing, revokedAtMs };
      rows.set(keyId, next);
      return next;
    },
  };
}

export function inMemoryWebhookStore(): WebhookEndpointStore & { readonly rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async find(keyId) {
      return rows.get(keyId) ?? null;
    },
    async put(keyId, url) {
      rows.set(keyId, url);
    },
    async remove(keyId) {
      rows.delete(keyId);
    },
  };
}

/** Deterministic secrets, so a test can name the key it expects. */
export function sequentialSecretSource(): ApiKeySecretSource {
  let counter = 0;
  return {
    next() {
      counter += 1;
      // 43 base64url characters, distinct per call.
      return `${String(counter).padStart(3, '0')}${'A'.repeat(40)}`;
    },
  };
}

export function sequentialIdSource(prefix = 'id'): IdSource {
  let counter = 0;
  return {
    next() {
      counter += 1;
      return `${prefix}-${String(counter)}`;
    },
  };
}

/** The same SHA-256 the production hasher uses — the hash is not the thing under test. */
export const testHasher: ApiKeyHasher = {
  hash: (key) => createHash('sha256').update(key, 'utf8').digest('hex'),
};

export interface RecordingWebhookSender extends WebhookSenderPort {
  readonly sent: { url: string; payload: unknown }[];
}

/**
 * A sender whose results are scripted.
 *
 * `results` is consumed one per call; when it runs out the last one repeats, so a test that
 * wants "always fails" supplies one failure rather than three.
 */
export function recordingWebhookSender(
  results: readonly WebhookDeliveryResult[] = [{ delivered: true, statusCode: 200, error: null }],
): RecordingWebhookSender {
  const sent: { url: string; payload: unknown }[] = [];
  let index = 0;

  return {
    sent,
    async send(url, payload) {
      sent.push({ url, payload });
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result ?? { delivered: false, statusCode: null, error: 'no scripted result' };
    },
  };
}

/* ------------------------------------------------------- gateway wiring */

/**
 * The Public_API block `createGatewayHarness` mounts.
 *
 * Real services over in-memory stores, sharing the harness clock: what a test exercises is the
 * production `createApiKeyService` and `createRateLimiter`, not a stand-in for them.
 */
export interface PublicApiHarness {
  readonly apiKeys: ApiKeyService;
  readonly rateLimiter: RateLimiter;
  readonly keys: InMemoryApiKeyStore;
  readonly webhooks: WebhookEndpointStore & { readonly rows: Map<string, string> };
  readonly requestsPerMinute: number;
}

export function createPublicApiHarness(options: {
  readonly clock: Clock;
  readonly requestsPerMinute?: number;
}): PublicApiHarness {
  const keys = inMemoryApiKeyStore();
  const webhooks = inMemoryWebhookStore();
  const requestsPerMinute = options.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;

  return {
    keys,
    webhooks,
    requestsPerMinute,
    apiKeys: createApiKeyService({
      keys,
      webhooks,
      clock: options.clock,
      hasher: sha256ApiKeyHasher,
      secrets: cryptoApiKeySecretSource,
      ids: sequentialIdSource('key'),
      defaultRequestsPerMinute: requestsPerMinute,
    }),
    rateLimiter: createRateLimiter({ store: inMemoryRateLimitStore(), clock: options.clock }),
  };
}
