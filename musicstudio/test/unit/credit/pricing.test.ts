import { describe, expect, it } from 'vitest';

import { ASSET_KINDS } from '../../../domain/asset-kind';
import {
  costOf,
  costPerOutput,
  createPricingTable,
  pricingKey,
  SOUND_PACK_CUE_COUNT,
  validatePriceEntry,
  type PriceEntry,
} from '../../../domain/credit/pricing';
import {
  CREATOR_PLAN_ID,
  FREE_PLAN_ID,
  findPlan,
  monthlyAssetCap,
  PLANS,
  validatePlan,
} from '../../../domain/credit/plan';
import {
  createDefaultPricingTable,
  DEFAULT_PRICE_ENTRIES,
  MIXDOWN_ENGINE_ID,
} from '../../../services/credit/pricing-table';

/**
 * Unit-price table and plan definitions: Requirements 2.5, 2.9, 2.10, 2.11,
 * 2.12, 2.13, 2.14.
 */

const entry: PriceEntry = {
  assetKind: 'song',
  engineId: 'engine-x',
  baseCredits: 8,
  creditsPerSecond: 1,
};

describe('cost formula (Requirements 2.2, 2.10)', () => {
  it('reflects both requested duration and output count', () => {
    // 8 base + 30s x 1 = 38 per output, x 4 outputs.
    expect(costOf(entry, { durationMs: 30_000, outputCount: 4 })).toBe(152);
  });

  it('is linear in the output count', () => {
    const one = costOf(entry, { durationMs: 45_000, outputCount: 1 });

    for (const outputCount of [1, 2, 3, 8]) {
      expect(costOf(entry, { durationMs: 45_000, outputCount })).toBe(one * outputCount);
    }
  });

  it('rounds a partial second up, so length is never charged short', () => {
    expect(costPerOutput({ ...entry, baseCredits: 0 }, 1)).toBe(1);
    expect(costPerOutput({ ...entry, baseCredits: 0 }, 1_001)).toBe(2);
  });

  it('produces integers only, because a balance is an integer column', () => {
    const priced = { ...entry, baseCredits: 3, creditsPerSecond: 7 };

    for (const durationMs of [1, 999, 1_500, 123_456]) {
      expect(Number.isInteger(costOf(priced, { durationMs, outputCount: 3 }))).toBe(true);
    }
  });

  it('charges at least the base price for a zero-length request', () => {
    expect(costOf(entry, { durationMs: 0, outputCount: 1 })).toBe(8);
  });
});

describe('registered pricing table (Requirement 2.9)', () => {
  const table = createDefaultPricingTable();

  it('prices every Asset_Kind', () => {
    expect(table.unpricedAssetKinds()).toEqual([]);
    expect(new Set(DEFAULT_PRICE_ENTRIES.map((priced) => priced.assetKind))).toEqual(
      new Set(ASSET_KINDS),
    );
  });

  it('keys entries by Asset_Kind and engine', () => {
    expect(table.keys()).toContain(pricingKey('song', 'ace-step-1.5'));
    expect(table.entryFor('song', 'ace-step-1.5')).toMatchObject({ baseCredits: 8 });
  });

  it('prices the same Asset_Kind differently per engine', () => {
    // §3.6 gives `sfx` a default and a fallback engine; they are separate entries.
    expect(table.entryFor('sfx', 'woosh-flow')).not.toEqual(table.entryFor('sfx', 'ace-step-1.5'));
  });

  it('has a mixdown entry charged by render duration (Requirement 2.12)', () => {
    const mix = table.entryFor('mix', MIXDOWN_ENGINE_ID);

    expect(mix).toBeDefined();
    expect(mix?.creditsPerSecond).toBeGreaterThan(0);
  });

  it('reports an unregistered combination rather than substituting one (Requirement 2.11)', () => {
    expect(table.entryFor('song', 'unregistered-engine')).toBeUndefined();
    expect(table.missingKeys('unregistered-engine', ['song', 'bgm'])).toEqual([
      'song:unregistered-engine',
      'bgm:unregistered-engine',
    ]);
    expect(table.missingKeys('ace-step-1.5', ['song', 'bgm'])).toEqual([]);
  });

  it('never registers a free combination', () => {
    for (const priced of DEFAULT_PRICE_ENTRIES) {
      expect(validatePriceEntry(priced)).toEqual([]);
      expect(costOf(priced, { durationMs: 0, outputCount: 1 })).toBeGreaterThan(0);
    }
  });

  it('refuses to build a table containing a zero-cost entry', () => {
    expect(() =>
      createPricingTable([{ assetKind: 'song', engineId: 'freebie', baseCredits: 0, creditsPerSecond: 0 }]),
    ).toThrow(/price_not_positive/);
  });
});

describe('Sound_Pack pricing (Requirement 2.13)', () => {
  it('charges all 78 cues as one amount', () => {
    const sfx = createDefaultPricingTable().entryFor('sfx', 'woosh-flow');
    if (sfx === undefined) throw new Error('sfx price entry missing');

    const perCue = costPerOutput(sfx, 1_500);

    expect(SOUND_PACK_CUE_COUNT).toBe(78);
    expect(costOf(sfx, { durationMs: 1_500, outputCount: SOUND_PACK_CUE_COUNT })).toBe(perCue * 78);
  });
});

describe('plan definitions (Requirements 2.1, 2.5, 2.8, 2.14)', () => {
  it('defines every limit for every plan', () => {
    for (const plan of PLANS) {
      expect(validatePlan(plan)).toEqual([]);
      for (const assetKind of ASSET_KINDS) {
        expect(monthlyAssetCap(plan, assetKind)).toBeGreaterThan(0);
      }
    }
  });

  it('grants the free plan opening credits (Requirement 2.1)', () => {
    expect(findPlan(FREE_PLAN_ID)?.initialCredits).toBeGreaterThan(0);
  });

  it('gives a paid plan strictly more headroom than the free plan', () => {
    const free = findPlan(FREE_PLAN_ID);
    const creator = findPlan(CREATOR_PLAN_ID);
    if (free === undefined || creator === undefined) throw new Error('plan missing');

    expect(creator.monthlyCredits).toBeGreaterThan(free.monthlyCredits);
    expect(creator.maxJobsPerMonth).toBeGreaterThan(free.maxJobsPerMonth);
    expect(creator.maxConcurrentJobs).toBeGreaterThan(free.maxConcurrentJobs);
  });

  it('does not know an unregistered plan', () => {
    expect(findPlan('enterprise')).toBeUndefined();
  });
});
