import { createInMemoryAccountPlanStore } from '../../services/credit/account-plan-store';
import { createRedisCreditBalanceStore } from '../../services/credit/adapters/redis-balance-store';
import type { CreditBalanceStore } from '../../services/credit/balance-store';
import { createCreditService, type CreditService } from '../../services/credit/credit-service';
import { createInMemoryCreditLedger, type CreditLedgerStore } from '../../services/credit/ledger';
import type { AccountPlanStore } from '../../services/credit/account-plan-store';
import type { PricingTable } from '../../domain/credit/pricing';

import { createFakeCreditRedis, type FakeCreditRedis } from './fake-credit-redis';
import { createMutableClock, type MutableClock } from './mutable-clock';
import { createRecordingAuditSink, type RecordingAuditSink } from './registry-harness';

/**
 * Credit_Service wired the way production wires it, with only Redis faked.
 *
 * The real `createRedisCreditBalanceStore` adapter is under test here — the
 * substitution happens one level lower, at the Redis command surface — so a bug in
 * key layout or reply decoding surfaces in these suites rather than in staging.
 *
 * `RecordingAuditSink` is reused from the registry harness: `CreditAuditSink` and
 * `AuditSinkPort` are structurally identical on purpose, so one recording double
 * serves both and the audit assertions read the same way in both layers.
 */
export interface CreditHarness {
  readonly service: CreditService;
  readonly balances: CreditBalanceStore;
  readonly ledger: CreditLedgerStore;
  readonly accountPlans: AccountPlanStore;
  readonly redis: FakeCreditRedis;
  readonly clock: MutableClock;
  readonly audit: RecordingAuditSink;
}

export interface CreditHarnessOptions {
  readonly startAt?: Date;
  readonly pricing?: PricingTable;
}

export function createCreditHarness(options: CreditHarnessOptions = {}): CreditHarness {
  const clock = createMutableClock(options.startAt ?? new Date('2025-03-01T09:00:00.000Z'));
  const redis = createFakeCreditRedis();
  const balances = createRedisCreditBalanceStore({ commands: redis });
  const ledger = createInMemoryCreditLedger();
  const accountPlans = createInMemoryAccountPlanStore();
  const audit = createRecordingAuditSink();

  let entrySequence = 0;

  const service = createCreditService({
    balances,
    ledger,
    accountPlans,
    clock,
    auditSink: audit,
    // Deterministic ids keep the audit assertions readable.
    generateEntryId: () => {
      entrySequence += 1;
      return `00000000-0000-4000-8000-${String(entrySequence).padStart(12, '0')}`;
    },
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }),
  });

  return { service, balances, ledger, accountPlans, redis, clock, audit };
}
