/**
 * Account model (design §4.1). Authentication behaviour belongs to task 1.2;
 * this module only fixes the stored shape and its constraints.
 */

export const CREDIT_BALANCE_MIN = 0;

export interface Account {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly planId: string;
  readonly creditBalance: number;
  readonly createdAtMs: number;
}

export type AccountViolation =
  | 'email_format'
  | 'password_hash_required'
  | 'plan_id_required'
  | 'credit_balance_negative';

/**
 * Shape check only. Email equality is case-insensitive, matching the unique
 * index on `lower(email)` in `db/migrations/0002_account.sql`.
 */
export function validateAccount(account: Account): AccountViolation[] {
  const violations: AccountViolation[] = [];

  if (!isPlausibleEmail(account.email)) violations.push('email_format');
  if (account.passwordHash.trim().length === 0) violations.push('password_hash_required');
  if (account.planId.trim().length === 0) violations.push('plan_id_required');
  if (!Number.isInteger(account.creditBalance) || account.creditBalance < CREDIT_BALANCE_MIN) {
    violations.push('credit_balance_negative');
  }

  return violations;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isPlausibleEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email.trim());
}
