/**
 * The seams the Public_API needs (Requirement 17).
 *
 * Four, and each is something this environment cannot reach: a database, a counter that has to
 * be atomic across processes, a random source, and an HTTP client pointed at a customer's URL.
 */

import type { ApiKeyRecord } from '../../domain/public-api/api-key';
import type { RateLimitWindow } from '../../domain/public-api/rate-limit';
import type { WebhookPayload } from '../../domain/public-api/webhook';

export interface ApiKeyStore {
  insert(record: ApiKeyRecord): Promise<void>;
  /**
   * Requirement 17.3's lookup. **By hash**, because the plaintext is not stored — see
   * `domain/public-api/api-key.ts`. Returning `null` for an unknown hash is what makes an
   * invalid key indistinguishable from a revoked one at this layer.
   */
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  findById(keyId: string): Promise<ApiKeyRecord | null>;
  listForAccount(accountId: string): Promise<readonly ApiKeyRecord[]>;
  revoke(keyId: string, revokedAtMs: number): Promise<ApiKeyRecord | null>;
}

/** Requirements 17.10, 17.14 — one endpoint per key. See `0018_public_api.sql`. */
export interface WebhookEndpointStore {
  find(keyId: string): Promise<string | null>;
  put(keyId: string, url: string): Promise<void>;
  remove(keyId: string): Promise<void>;
}

/**
 * Requirement 17.7's counter.
 *
 * `consume` is one call rather than a read followed by a write, because two processes reading
 * 59 and both writing 60 is how a limit of 60 admits 61. Design §11.3 puts this on Redis, where
 * the read-modify-write is one `INCR`; the in-memory implementation in the tests is single
 * threaded and therefore atomic for free.
 */
export interface RateLimitStore {
  /** Returns the window *after* counting this request, or `null` if the request is refused. */
  consume(keyId: string, nowMs: number, limit: number): Promise<RateLimitWindow | null>;
  /** Read without counting — for the header on an admitted request. */
  peek(keyId: string, nowMs: number): Promise<RateLimitWindow | null>;
}

/** 32 bytes of CSPRNG output, base64url. `crypto-sources.ts` is the real one. */
export interface ApiKeySecretSource {
  next(): string;
}

/** SHA-256, hex. Not bcrypt — `domain/public-api/api-key.ts` says why. */
export interface ApiKeyHasher {
  hash(key: string): string;
}

export interface IdSource {
  next(): string;
}

/**
 * Requirements 17.10, 17.14 — the delivery itself.
 *
 * Returns rather than throws, and reports the status: a webhook that fails is an ordinary
 * outcome of pointing at a URL someone else operates, and a dispatcher that had to catch
 * exceptions to know that would be a dispatcher whose retry logic is in a `catch` block.
 */
export interface WebhookDeliveryResult {
  readonly delivered: boolean;
  readonly statusCode: number | null;
  readonly error: string | null;
}

export interface WebhookSenderPort {
  send(url: string, payload: WebhookPayload): Promise<WebhookDeliveryResult>;
}
