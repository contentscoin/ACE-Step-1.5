/**
 * The Public_API's rejections (Requirements 17.4, 17.8).
 *
 * Two of them are fixed by the requirements — 401 for a key that does not authenticate, 429 for
 * one over its limit — and the rest follow the codes the rest of the gateway already uses.
 *
 * ### One 401, not three
 *
 * A missing key, a malformed key, an unknown key and a revoked key are all
 * `public_api_key_invalid`. Distinguishing them would answer a question the caller has no right
 * to ask: "is this key one of yours" is exactly what an attacker holding a candidate wants to
 * know, and a distinct code for "revoked" confirms the key was real. The *details* say which
 * header was involved, because that is about the request, not about the credential.
 */

import { GenerationError } from '../generation/errors';

/** Requirement 17.4 — every authentication failure, indistinguishable from every other. */
export function publicApiKeyInvalid(): GenerationError {
  return new GenerationError(
    401,
    'public_api_key_invalid',
    'The API key is missing, malformed, unknown or revoked.',
    { header: 'authorization' },
  );
}

/** Requirement 17.8 — over the limit, with the time a retry may be made. */
export function publicApiRateLimited(details: {
  readonly limit: number;
  readonly retryAtMs: number;
  readonly retryAfterSeconds: number;
}): GenerationError {
  return new GenerationError(
    429,
    'public_api_rate_limited',
    'The API key has exceeded its requests-per-minute limit.',
    details,
  );
}

export function publicApiKeyNotFound(keyId: string): GenerationError {
  return new GenerationError(404, 'public_api_key_not_found', 'No such API key.', { keyId });
}

export function publicApiWebhookInvalid(violations: readonly string[]): GenerationError {
  return new GenerationError(
    400,
    'public_api_webhook_invalid',
    'The webhook URL is not acceptable.',
    { violations },
  );
}

export function publicApiKeyLabelInvalid(violations: readonly string[]): GenerationError {
  return new GenerationError(
    400,
    'public_api_key_label_invalid',
    'The API key label is not acceptable.',
    { violations },
  );
}
