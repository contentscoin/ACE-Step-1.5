/**
 * Registered credit prices (Requirement 2.9).
 *
 * One entry per `Asset_Kind × Engine_Descriptor` combination the engine mapping
 * of design §3.6 can actually route to: each Asset_Kind's default engine, plus
 * the fallback engines §3.6 defines for `sfx` and `dialogue`. Requirement 2.11
 * then has real teeth — an engine that is registered but unpriced is rejected
 * with its combination identifier instead of being silently charged at some
 * other engine's rate.
 *
 * This module, not `domain/credit/pricing.ts`, is where engine identifiers
 * appear: the domain layer states the pricing *rules* and stays free of the
 * adapter layer, while the concrete rate card belongs with the service that
 * charges from it.
 *
 * Rates are product decisions (the requirements fix no credit amounts). They are
 * ordered so that longer output and more outputs always cost more, and so that
 * the cheapest possible request still costs at least one credit.
 */

import {
  ACE_STEP_ENGINE_ID,
  MIXDOWN_RENDERER_ENGINE_ID,
  TTS_PRIMARY_ENGINE_ID,
  TTS_SECONDARY_ENGINE_ID,
  WOOSH_FLOW_ENGINE_ID,
} from '../../adapters/registry/default-engines';
import { createPricingTable, type PriceEntry, type PricingTable } from '../../domain/credit/pricing';

export const DEFAULT_PRICE_ENTRIES: readonly PriceEntry[] = [
  { assetKind: 'song', engineId: ACE_STEP_ENGINE_ID, baseCredits: 8, creditsPerSecond: 1 },
  { assetKind: 'bgm', engineId: ACE_STEP_ENGINE_ID, baseCredits: 4, creditsPerSecond: 1 },
  { assetKind: 'sfx', engineId: WOOSH_FLOW_ENGINE_ID, baseCredits: 2, creditsPerSecond: 2 },
  // §3.6 fallback for `sfx`; priced higher because the song engine is the
  // costlier way to produce a two-second effect.
  { assetKind: 'sfx', engineId: ACE_STEP_ENGINE_ID, baseCredits: 3, creditsPerSecond: 2 },
  { assetKind: 'dialogue', engineId: TTS_PRIMARY_ENGINE_ID, baseCredits: 1, creditsPerSecond: 1 },
  { assetKind: 'dialogue', engineId: TTS_SECONDARY_ENGINE_ID, baseCredits: 1, creditsPerSecond: 1 },
  { assetKind: 'stem', engineId: ACE_STEP_ENGINE_ID, baseCredits: 6, creditsPerSecond: 1 },
  // Requirement 2.12: the mixdown price is charged by render duration.
  { assetKind: 'mix', engineId: MIXDOWN_RENDERER_ENGINE_ID, baseCredits: 2, creditsPerSecond: 1 },
];

export function createDefaultPricingTable(): PricingTable {
  return createPricingTable(DEFAULT_PRICE_ENTRIES);
}

/** The engine that renders a mixdown; Requirement 2.12 charges against it. */
export const MIXDOWN_ENGINE_ID = MIXDOWN_RENDERER_ENGINE_ID;
