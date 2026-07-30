/**
 * Audit log PII masking (design §4.4, §11.2; Requirement 18 logging rules).
 *
 * Emails become `***@domain.com` and API keys `sk-***last4`. Both functions are
 * total: a malformed input degrades to a fully masked value rather than throwing,
 * because a throw at a logging call site is the one failure mode that could push
 * a caller into logging the raw value instead.
 */

/** Value stored when no domain can be recovered from the input. */
export const FULLY_MASKED = '***';

/** Prefix every masked API key carries, so the format is checkable in SQL. */
export const MASKED_API_KEY_PREFIX = 'sk-***';

/** Number of trailing key characters kept for support triage. */
export const API_KEY_VISIBLE_SUFFIX_LENGTH = 4;

export const MASKED_EMAIL_PATTERN = /^\*\*\*@[^@\s]+$/;
export const MASKED_API_KEY_PATTERN = /^sk-\*\*\*[A-Za-z0-9_-]{0,4}$/;

/** `alice@example.com` → `***@example.com`. */
export function maskEmail(email: string): string {
  const separator = email.lastIndexOf('@');
  if (separator < 0) return FULLY_MASKED;

  const domain = email.slice(separator + 1).trim();
  if (domain.length === 0 || domain.includes('@') || /\s/.test(domain)) return FULLY_MASKED;

  return `${FULLY_MASKED}@${domain}`;
}

/** `sk-live-8f2a91c4` → `sk-***91c4`. */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= API_KEY_VISIBLE_SUFFIX_LENGTH) return MASKED_API_KEY_PREFIX;

  const suffix = trimmed.slice(-API_KEY_VISIBLE_SUFFIX_LENGTH);
  if (!/^[A-Za-z0-9_-]+$/.test(suffix)) return MASKED_API_KEY_PREFIX;

  return `${MASKED_API_KEY_PREFIX}${suffix}`;
}

export function isMaskedEmail(value: string): boolean {
  return value === FULLY_MASKED || MASKED_EMAIL_PATTERN.test(value);
}

export function isMaskedApiKey(value: string): boolean {
  return MASKED_API_KEY_PATTERN.test(value);
}
