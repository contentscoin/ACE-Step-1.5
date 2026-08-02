/**
 * The atomic operations Credit_Service needs from Redis (design §2.4: "Redis:
 * … 크레딧 잔액 원자 연산").
 *
 * ## Why the port is shaped like this
 *
 * Every method that makes a *decision* returns the decision together with the
 * resulting counter. There is deliberately no `setBalance`, and no operation
 * that reads a value for the caller to modify: a read-then-write deduction is
 * exactly the race Requirement 2.3 must not lose. Two concurrent requests that
 * each read a balance of 10 and each subtract 10 would both succeed and leave
 * −10, which the `account.credit_balance >= 0` constraint calls impossible.
 *
 * So the contract is:
 *
 * > `tryDebit` and `tryAcquireJobSlot` MUST evaluate their guard and apply their
 * > mutation as one indivisible step.
 *
 * The Redis adapter satisfies this with a Lua script per operation
 * (`adapters/atomic-scripts.ts`): Redis executes a script to completion before
 * serving another client, so the guard and the mutation cannot interleave. The
 * in-memory test double satisfies it by keeping its critical section free of
 * `await`.
 *
 * `balanceOf` and `jobsInFlight` exist for the Requirement 2.7 usage query only.
 * No decision may be taken from their result.
 */

export interface DebitOutcome {
  /** `false` means the guard rejected the debit; nothing was written. */
  readonly applied: boolean;
  /** Balance after the operation — unchanged when `applied` is `false`. */
  readonly balance: number;
}

export interface JobSlotOutcome {
  readonly acquired: boolean;
  /** In-flight count after the operation; Requirement 2.6 returns this value. */
  readonly jobsInFlight: number;
}

export interface CreditBalanceStore {
  /**
   * Sets the opening balance if this account has none yet (Requirement 2.1).
   * Idempotent: a second call reports `applied: false` and leaves the balance.
   */
  initialise(accountId: string, credits: number): Promise<DebitOutcome>;

  balanceOf(accountId: string): Promise<number>;

  /** Unconditional increase: renewal (2.8) and refund (2.4). */
  credit(accountId: string, amount: number): Promise<number>;

  /** Requirements 2.2, 2.3 — atomic guard-and-decrement. */
  tryDebit(accountId: string, amount: number): Promise<DebitOutcome>;

  /** Requirements 2.5, 2.6 — atomic guard-and-increment against the plan cap. */
  tryAcquireJobSlot(accountId: string, concurrentJobLimit: number): Promise<JobSlotOutcome>;

  /** Settles one in-flight job. Never goes below zero. */
  releaseJobSlot(accountId: string): Promise<number>;

  jobsInFlight(accountId: string): Promise<number>;
}
