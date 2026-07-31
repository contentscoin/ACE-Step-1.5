/**
 * E-mail address normalisation.
 *
 * Requirement 1.2 compares a signup address against "이미 등록된 계정"; the
 * comparison must not depend on casing or surrounding whitespace, so every
 * lookup and every stored address passes through this single function.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Masks an address for logs and alerts (design §11.2: `***@domain.com`).
 * Kept here so the account layer never emits a raw address into a log record.
 */
export function maskEmail(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0) {
    return '***';
  }
  return `***${email.slice(atIndex)}`;
}
