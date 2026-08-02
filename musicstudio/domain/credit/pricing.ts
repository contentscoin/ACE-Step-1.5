/**
 * Credit unit-price table (Requirements 2.9–2.13, design §2.4, §3.6).
 *
 * Pricing is keyed by `Asset_Kind × Engine_Descriptor` — the same key the
 * Provider_Registry already asks about through `EnginePricingPort`
 * (`adapters/registry/ports.ts`), spelled `"<assetKind>:<engineId>"`. Requirement
 * 2.11 returns that string as the "unregistered combination identifier", so the
 * key format is part of the contract rather than an internal detail.
 *
 * The cost formula is integer-only:
 *
 *     cost = outputCount × (baseCredits + ceil(durationMs × creditsPerSecond / 1000))
 *
 * Integer arithmetic matters twice over: `account.credit_balance` is an
 * `integer` column (`db/migrations/0002_account.sql`), and a float cost would
 * make the atomic Redis deduction non-reproducible across processes. Rounding is
 * *up* so a request never costs less than its duration implies.
 *
 * The concrete rates live in `services/credit/pricing-table.ts`, which is the
 * layer allowed to name engine ids; this module only states the rules.
 */

import { ASSET_KINDS, type AssetKind } from '../asset-kind';

/** Cue count of a complete Sound_Pack (Requirement 2.13, 24.x taxonomy). */
export const SOUND_PACK_CUE_COUNT = 78;

export interface PriceEntry {
  readonly assetKind: AssetKind;
  readonly engineId: string;
  /** Charged once per produced output, independent of length. */
  readonly baseCredits: number;
  /** Charged per second of requested/rendered audio, per output. */
  readonly creditsPerSecond: number;
}

/** `"<assetKind>:<engineId>"` — the identifier Requirement 2.11 returns. */
export type PricingKey = string;

export function pricingKey(assetKind: AssetKind, engineId: string): PricingKey {
  return `${assetKind}:${engineId}`;
}

export interface ChargeableAmount {
  readonly durationMs: number;
  /** `batch_size` for generation (2.2), 78 for a Sound_Pack (2.13), 1 for a mixdown (2.12). */
  readonly outputCount: number;
}

/** Cost of one output before the count multiplier. */
export function costPerOutput(entry: PriceEntry, durationMs: number): number {
  return entry.baseCredits + Math.ceil((durationMs * entry.creditsPerSecond) / 1_000);
}

/** Requirements 2.2, 2.10: duration and output count both reflected. */
export function costOf(entry: PriceEntry, amount: ChargeableAmount): number {
  return amount.outputCount * costPerOutput(entry, amount.durationMs);
}

export type PriceEntryViolation =
  | 'base_credits_negative'
  | 'credits_per_second_negative'
  | 'engine_id_required'
  | 'price_not_positive';

/**
 * A priced combination must cost something: a zero-cost entry would let a caller
 * consume GPU time for free, which is the whole point of Requirement 2.
 */
export function validatePriceEntry(entry: PriceEntry): PriceEntryViolation[] {
  const violations: PriceEntryViolation[] = [];

  if (!Number.isInteger(entry.baseCredits) || entry.baseCredits < 0) {
    violations.push('base_credits_negative');
  }
  if (!Number.isInteger(entry.creditsPerSecond) || entry.creditsPerSecond < 0) {
    violations.push('credits_per_second_negative');
  }
  if (entry.engineId.trim().length === 0) violations.push('engine_id_required');
  if (entry.baseCredits + entry.creditsPerSecond <= 0) violations.push('price_not_positive');

  return violations;
}

export interface PricingTable {
  /** `undefined` is the Requirement 2.11 case. */
  entryFor(assetKind: AssetKind, engineId: string): PriceEntry | undefined;
  /** Requirement 20.16/20.17: which of these kinds this engine has no price for. */
  missingKeys(engineId: string, assetKinds: readonly AssetKind[]): readonly PricingKey[];
  /** Asset_Kinds with no priced engine at all (Requirement 2.9 coverage check). */
  unpricedAssetKinds(): readonly AssetKind[];
  keys(): readonly PricingKey[];
  entries(): readonly PriceEntry[];
}

export function createPricingTable(entries: readonly PriceEntry[]): PricingTable {
  const byKey = new Map<PricingKey, PriceEntry>();

  for (const entry of entries) {
    const violations = validatePriceEntry(entry);
    if (violations.length > 0) {
      throw new Error(
        `invalid price entry ${pricingKey(entry.assetKind, entry.engineId)}: ${violations.join(', ')}`,
      );
    }
    byKey.set(pricingKey(entry.assetKind, entry.engineId), entry);
  }

  return {
    entryFor: (assetKind, engineId) => byKey.get(pricingKey(assetKind, engineId)),
    missingKeys: (engineId, assetKinds) =>
      assetKinds
        .map((assetKind) => pricingKey(assetKind, engineId))
        .filter((key) => !byKey.has(key)),
    unpricedAssetKinds: () =>
      ASSET_KINDS.filter(
        (assetKind) => ![...byKey.values()].some((entry) => entry.assetKind === assetKind),
      ),
    keys: () => [...byKey.keys()].sort(),
    entries: () => [...byKey.values()],
  };
}
