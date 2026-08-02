/**
 * Which plan an account is on.
 *
 * `account.plan_id` (design §4.1) is the durable answer, but Credit_Service must
 * not reach into the Account_Service repository to read one column — that would
 * couple two services that Requirement 1 and Requirement 2 keep separate. This
 * one-method port is the seam instead; the PostgreSQL implementation is a single
 * `SELECT plan_id`, and the in-memory one below serves tests and single-process
 * development.
 */

export interface AccountPlanStore {
  /** `undefined` when the account has no recorded plan yet. */
  planIdFor(accountId: string): Promise<string | undefined>;
  assign(accountId: string, planId: string): Promise<void>;
}

export function createInMemoryAccountPlanStore(): AccountPlanStore {
  const planByAccount = new Map<string, string>();

  return {
    async planIdFor(accountId) {
      return planByAccount.get(accountId);
    },
    async assign(accountId, planId) {
      planByAccount.set(accountId, planId);
    },
  };
}
