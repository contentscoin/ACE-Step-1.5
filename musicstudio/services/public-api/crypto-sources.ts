/**
 * The real random source and hasher behind an API key (Requirements 17.1, 17.2).
 *
 * `randomBytes`, not `Math.random`, for the same reason `services/sharing/share-token.ts` gives:
 * an API key is a bearer credential and a predictable one is not a credential.
 *
 * SHA-256 rather than bcrypt because the input is 256 bits of uniform random — there is nothing
 * to slow a guesser down about, and a work factor of 12 would put a quarter of a second in front
 * of every API request. `domain/public-api/api-key.ts` sets that out in full.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { API_KEY_ENTROPY_BYTES } from '../../domain/public-api/api-key';
import type { ApiKeyHasher, ApiKeySecretSource, IdSource } from './ports';

export const cryptoApiKeySecretSource: ApiKeySecretSource = {
  next: () => randomBytes(API_KEY_ENTROPY_BYTES).toString('base64url'),
};

export const sha256ApiKeyHasher: ApiKeyHasher = {
  hash: (key) => createHash('sha256').update(key, 'utf8').digest('hex'),
};

export const uuidIdSource: IdSource = {
  next: () => randomUUID(),
};
