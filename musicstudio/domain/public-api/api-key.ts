/**
 * API_Key — Requirements 17.1, 17.2, 17.3, 17.4, 17.9.
 *
 * ### The key is shown once because it is only ever stored hashed
 *
 * 17.1 says 발급 시점에 한 번만 평문으로 노출 and 17.2 says 단방향 해시 형태로만 저장. Those are
 * one decision, not two: the key is shown once *because* nothing keeps it. A design that stored
 * the plaintext and merely declined to show it again would satisfy the wording of 17.1 while
 * making 17.2 false, and the two clauses would then disagree about whether a leaked database is
 * a leaked key.
 *
 * ### The prefix is the part that is *not* secret
 *
 * A key is `ms_live_<43 base64url chars>`. The first two segments are fixed and public; the
 * third is 256 bits of CSPRNG output. Splitting them buys two things:
 *
 * - **A key found in a log or a repository is recognisable.** Secret scanners match on a
 *   prefix, and a bare base64 blob matches nothing. This is the reason GitHub, Stripe and
 *   OpenAI all prefix theirs.
 * - **A fingerprint that can be shown.** `ms_live_A1b2…` identifies a key in a list without
 *   revealing it, so revoking the right one (17.9) does not require the plaintext.
 *
 * The random part is 32 bytes rather than 16 because a bearer credential with no second factor
 * is the whole of the authentication, and base64url of 32 bytes costs 43 characters.
 *
 * ### Why the hash is not bcrypt
 *
 * Passwords are bcrypt (`services/account/password-hasher.ts`, work factor 12) because they are
 * low-entropy and guessable, so the cost of a guess has to be raised. An API key is 256 bits of
 * uniform random: there is nothing to guess, and a work factor of 12 would instead put ~250 ms
 * of hashing in front of *every* API request, which is the rate limit of Requirement 17.7 spent
 * on arithmetic. SHA-256 over a high-entropy secret is the right tool, and the store is what
 * makes the lookup constant-time.
 */

/** The public, fixed part. A key that does not start with this is not one of ours. */
export const API_KEY_PREFIX = 'ms_live_';

/** Bytes of CSPRNG output behind the secret segment. */
export const API_KEY_ENTROPY_BYTES = 32;

/** base64url of 32 bytes. Fixed, so a truncated key is a length check rather than a guess. */
export const API_KEY_SECRET_LENGTH = 43;

/** Characters of the secret shown in a fingerprint. Enough to tell keys apart, far too few to use. */
export const API_KEY_FINGERPRINT_CHARS = 6;

export const API_KEY_LABEL_MAX_LENGTH = 60;

/** base64url: the alphabet `randomBytes(...).toString('base64url')` produces. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ApiKeyViolation =
  | 'api_key_prefix_missing'
  | 'api_key_secret_length'
  | 'api_key_secret_alphabet'
  | 'api_key_label_length';

/** The stored record. Note what is *not* here: the key itself. */
export interface ApiKeyRecord {
  readonly keyId: string;
  readonly accountId: string;
  /** Requirement 17.2 — the only form of the key that is kept. */
  readonly keyHash: string;
  /** Requirement 17.9's handle: shown in a list, useless as a credential. */
  readonly fingerprint: string;
  readonly label: string;
  readonly createdAtMs: number;
  /** Requirement 17.9 — set on revocation, and never unset. */
  readonly revokedAtMs: number | null;
}

/** Build a key from the secret segment a CSPRNG produced. */
export function composeApiKey(secret: string): string {
  return `${API_KEY_PREFIX}${secret}`;
}

export function apiKeyViolations(key: string): ApiKeyViolation[] {
  const violations: ApiKeyViolation[] = [];
  if (!key.startsWith(API_KEY_PREFIX)) {
    violations.push('api_key_prefix_missing');
    // Everything below reads the secret segment, and there isn't one.
    return violations;
  }

  const secret = key.slice(API_KEY_PREFIX.length);
  if (secret.length !== API_KEY_SECRET_LENGTH) violations.push('api_key_secret_length');
  if (!SECRET_PATTERN.test(secret)) violations.push('api_key_secret_alphabet');
  return violations;
}

export function isWellFormedApiKey(key: string): boolean {
  return apiKeyViolations(key).length === 0;
}

/**
 * The part of a key that may be shown again.
 *
 * Derived from the key rather than stored beside it, so a fingerprint cannot drift from the key
 * it names. A malformed key has no fingerprint — returning a truncation of whatever arrived
 * would put attacker-controlled text into an operator's list.
 */
export function apiKeyFingerprint(key: string): string | null {
  if (!isWellFormedApiKey(key)) return null;
  const secret = key.slice(API_KEY_PREFIX.length);
  return `${API_KEY_PREFIX}${secret.slice(0, API_KEY_FINGERPRINT_CHARS)}`;
}

export function labelViolations(label: string): ApiKeyViolation[] {
  const trimmed = label.trim();
  return trimmed.length < 1 || trimmed.length > API_KEY_LABEL_MAX_LENGTH
    ? ['api_key_label_length']
    : [];
}

/**
 * Requirements 17.3, 17.4, 17.9 — whether this record may authenticate a request.
 *
 * Revocation is a timestamp compared against *now* rather than a boolean, so a key revoked at
 * 12:00 does not authenticate a request the store happens to replay from 11:59. It is also why
 * `revokedAtMs` is never unset: un-revoking would make a key that has been published usable
 * again, and the fix for a leaked key is a new key.
 */
export function isUsableApiKey(record: ApiKeyRecord, nowMs: number): boolean {
  return record.revokedAtMs === null || nowMs < record.revokedAtMs;
}

/** What an account sees in a key listing. The plaintext is not among the fields. */
export interface ApiKeySummary {
  readonly keyId: string;
  readonly fingerprint: string;
  readonly label: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
}

export function summariseApiKey(record: ApiKeyRecord): ApiKeySummary {
  return {
    keyId: record.keyId,
    fingerprint: record.fingerprint,
    label: record.label,
    createdAtMs: record.createdAtMs,
    revokedAtMs: record.revokedAtMs,
  };
}
