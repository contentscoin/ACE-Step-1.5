/**
 * API key lifecycle — Requirements 17.1, 17.2, 17.3, 17.4, 17.9.
 *
 * ### `issue` is the only function that ever returns the key
 *
 * It returns it once, in the same call that stores its hash, and nothing else in this module
 * has an expression that could produce it. That is what makes Requirement 17.1's "한 번만" a
 * property of the code rather than a discipline: there is no second place to ask.
 *
 * ### Authentication returns `null` rather than throwing
 *
 * The four ways to fail — no key, malformed, unknown, revoked — are one outcome to a caller, and
 * the route turns the `null` into Requirement 17.4's 401. Returning rather than throwing keeps
 * the distinction *inside* this module, where the revoked case can be handled without a code
 * that tells a caller their guess was a real key.
 *
 * ### The hash is computed on a well-formed key only
 *
 * A malformed candidate is rejected before it is hashed. That is not an optimisation: hashing
 * arbitrary caller input and looking it up is a lookup that can be made to match — not here,
 * with SHA-256 over a fixed alphabet, but the check costs nothing and removes the question.
 */

import {
  apiKeyFingerprint,
  composeApiKey,
  isUsableApiKey,
  isWellFormedApiKey,
  labelViolations,
  summariseApiKey,
  type ApiKeyRecord,
  type ApiKeySummary,
} from '../../domain/public-api/api-key';
import { DEFAULT_REQUESTS_PER_MINUTE } from '../../domain/public-api/rate-limit';
import { isValidWebhookUrl, webhookUrlViolations } from '../../domain/public-api/webhook';
import type { Clock } from '../clock';
import { systemClock } from '../clock';
import {
  publicApiKeyLabelInvalid,
  publicApiKeyNotFound,
  publicApiWebhookInvalid,
} from './errors';
import type {
  ApiKeyHasher,
  ApiKeySecretSource,
  ApiKeyStore,
  IdSource,
  WebhookEndpointStore,
} from './ports';

export interface ApiKeyServiceOptions {
  readonly keys: ApiKeyStore;
  readonly hasher: ApiKeyHasher;
  readonly secrets: ApiKeySecretSource;
  readonly ids: IdSource;
  readonly clock?: Clock;
  readonly webhooks?: WebhookEndpointStore;
  readonly defaultRequestsPerMinute?: number;
}

/** Requirement 17.1's one-time exposure. The only shape in this module that holds the key. */
export interface IssuedApiKey {
  readonly summary: ApiKeySummary;
  /** Shown once, never stored, and absent from every other return type here. */
  readonly key: string;
}

/** What authentication yields when it succeeds. */
export interface AuthenticatedApiKey {
  readonly keyId: string;
  readonly accountId: string;
  readonly requestsPerMinute: number;
}

export function createApiKeyService(options: ApiKeyServiceOptions) {
  const { keys, hasher, secrets, ids } = options;
  const clock = options.clock ?? systemClock;
  const defaultLimit = options.defaultRequestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;

  function nowMs(): number {
    return clock.now().getTime();
  }

  return {
    /** Requirements 17.1, 17.2. */
    async issue(accountId: string, label: string): Promise<IssuedApiKey> {
      const violations = labelViolations(label);
      if (violations.length > 0) throw publicApiKeyLabelInvalid(violations);

      const key = composeApiKey(secrets.next());
      // The source is contracted to produce a base64url secret of the right length. If it does
      // not, that is a wiring fault and it surfaces here rather than as a key that authenticates
      // once and then fails its own format check on the next request.
      const fingerprint = apiKeyFingerprint(key);
      if (fingerprint === null) {
        throw new Error('the API key secret source produced a malformed secret');
      }

      const record: ApiKeyRecord = {
        keyId: ids.next(),
        accountId,
        keyHash: hasher.hash(key),
        fingerprint,
        label: label.trim(),
        createdAtMs: nowMs(),
        revokedAtMs: null,
      };
      await keys.insert(record);

      return { summary: summariseApiKey(record), key };
    },

    /**
     * Requirements 17.3, 17.4, 17.9 — who this key belongs to, or `null`.
     *
     * `null` covers all four failures. See the module header.
     */
    async authenticate(candidate: string | null): Promise<AuthenticatedApiKey | null> {
      if (candidate === null || !isWellFormedApiKey(candidate)) return null;

      const record = await keys.findByHash(hasher.hash(candidate));
      if (record === null || !isUsableApiKey(record, nowMs())) return null;

      return {
        keyId: record.keyId,
        accountId: record.accountId,
        requestsPerMinute: defaultLimit,
      };
    },

    /** Requirement 17.9. Idempotent: revoking an already-revoked key keeps the first instant. */
    async revoke(accountId: string, keyId: string): Promise<ApiKeySummary> {
      const existing = await keys.findById(keyId);
      // A key belonging to another account answers 404 rather than 403: a 403 would confirm
      // that the identifier names a real key on some other account.
      if (existing === null || existing.accountId !== accountId) {
        throw publicApiKeyNotFound(keyId);
      }
      if (existing.revokedAtMs !== null) return summariseApiKey(existing);

      const revoked = await keys.revoke(keyId, nowMs());
      if (revoked === null) throw publicApiKeyNotFound(keyId);
      return summariseApiKey(revoked);
    },

    /** Requirement 17.9's list. Summaries, so no path here can return a key. */
    async list(accountId: string): Promise<readonly ApiKeySummary[]> {
      const records = await keys.listForAccount(accountId);
      return [...records]
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map(summariseApiKey);
    },

    /** Requirements 17.10, 17.14 — register where results are sent. */
    async setWebhook(accountId: string, keyId: string, url: string): Promise<void> {
      const record = await keys.findById(keyId);
      if (record === null || record.accountId !== accountId) throw publicApiKeyNotFound(keyId);
      if (!isValidWebhookUrl(url)) throw publicApiWebhookInvalid(webhookUrlViolations(url));

      await options.webhooks?.put(keyId, url);
    },

    async clearWebhook(accountId: string, keyId: string): Promise<void> {
      const record = await keys.findById(keyId);
      if (record === null || record.accountId !== accountId) throw publicApiKeyNotFound(keyId);
      await options.webhooks?.remove(keyId);
    },

    async webhookFor(keyId: string): Promise<string | null> {
      return (await options.webhooks?.find(keyId)) ?? null;
    },
  };
}

export type ApiKeyService = ReturnType<typeof createApiKeyService>;
