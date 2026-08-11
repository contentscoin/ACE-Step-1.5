/**
 * Public_API (task 9.1) — Requirement 17.
 *
 * The pure parts are in `domain/public-api/`; this layer adds the four things that are not —
 * hashing, storage, an atomic counter, and an HTTP call to a customer's endpoint.
 */

export {
  createApiKeyService,
  type ApiKeyService,
  type ApiKeyServiceOptions,
  type AuthenticatedApiKey,
  type IssuedApiKey,
} from './api-key-service';
export {
  cryptoApiKeySecretSource,
  sha256ApiKeyHasher,
  uuidIdSource,
} from './crypto-sources';
export {
  publicApiKeyInvalid,
  publicApiKeyLabelInvalid,
  publicApiKeyNotFound,
  publicApiRateLimited,
  publicApiWebhookInvalid,
} from './errors';
export type {
  ApiKeyHasher,
  ApiKeySecretSource,
  ApiKeyStore,
  IdSource,
  RateLimitStore,
  WebhookDeliveryResult,
  WebhookEndpointStore,
  WebhookSenderPort,
} from './ports';
export {
  createRateLimiter,
  inMemoryRateLimitStore,
  type RateLimiter,
} from './rate-limiter';
export {
  WEBHOOK_MAX_ATTEMPTS,
  createWebhookDispatcher,
  type DispatchOutcome,
  type WebhookDispatcher,
} from './webhook-dispatcher';
