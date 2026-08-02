/**
 * Credit_Service public surface (Requirement 2, design §2.4).
 *
 * The API gateway and Job_Orchestrator (task 1.5) import from here; the module
 * layout inside `services/credit/` stays free to change.
 */

export { createCreditService } from './credit-service';
export type {
  ChargeRecord,
  CreditService,
  CreditServiceDependencies,
  GenerationChargeRequest,
  GrantResult,
  MixdownChargeRequest,
  PlanScopedRequest,
  Quote,
  QuoteRequest,
  RefundResult,
  SoundPackChargeRequest,
} from './credit-service';

export type { CreditBalanceStore, DebitOutcome, JobSlotOutcome } from './balance-store';
export { createInMemoryCreditLedger } from './ledger';
export type { AppendOutcome, CreditLedgerStore } from './ledger';
export { createInMemoryAccountPlanStore } from './account-plan-store';
export type { AccountPlanStore } from './account-plan-store';

export { creditAuditDraft, noopCreditAuditSink } from './audit';
export type { CreditAuditSink } from './audit';

export { CreditError, isCreditError } from './errors';
export type { CreditErrorCode } from './errors';

export {
  createDefaultPricingTable,
  DEFAULT_PRICE_ENTRIES,
  MIXDOWN_ENGINE_ID,
} from './pricing-table';

export { createRedisCreditBalanceStore } from './adapters/redis-balance-store';
export type { RedisCreditBalanceStoreOptions } from './adapters/redis-balance-store';
export { ATOMIC_SCRIPTS } from './adapters/atomic-scripts';
export type { AtomicScriptName } from './adapters/atomic-scripts';
export type { CreditRedisCommands } from './adapters/redis-credit-commands';
export { balanceKey, CREDIT_KEY_PREFIX, inFlightKey } from './adapters/redis-credit-commands';

export {
  costOf,
  costPerOutput,
  createPricingTable,
  pricingKey,
  SOUND_PACK_CUE_COUNT,
} from '../../domain/credit/pricing';
export type { PriceEntry, PricingTable } from '../../domain/credit/pricing';
export {
  CREATOR_PLAN_ID,
  DEFAULT_PLAN,
  FREE_PLAN_ID,
  findPlan,
  monthlyAssetCap,
  PLANS,
  STUDIO_PLAN_ID,
} from '../../domain/credit/plan';
export type { PlanDefinition } from '../../domain/credit/plan';
export { balanceOf, CREDIT_ENTRY_TYPES } from '../../domain/credit/ledger-entry';
export type { ChargeKind, CreditEntryType, CreditLedgerEntry } from '../../domain/credit/ledger-entry';
export { buildUsageSnapshot, checkPlanQuotas, summariseUsage } from '../../domain/credit/usage';
export type { MonthlyUsage, UsageSnapshot } from '../../domain/credit/usage';
