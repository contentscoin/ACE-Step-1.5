/**
 * Which Woosh deployment serves which product tier (design §3.6).
 *
 * The product half of this distinction lives in `domain/sfx/model-tier.ts`: that a tier is
 * distilled, and what sampling-step window it admits, are facts about Requirement 22. Which
 * `engineId` and which checkpoint name serve it are facts about a deployment, and they live
 * here — so a rename of a Woosh checkpoint touches this file and nothing above it.
 *
 * §3.6: `고속=DFlow(증류), 고품질=Flow`.
 */

import {
  WOOSH_DFLOW_ENGINE_ID,
  WOOSH_FLOW_ENGINE_ID,
} from '../registry/default-engines';

import type { SfxModelTier } from '../../domain/sfx/model-tier';

export const WOOSH_ENGINE_ID_BY_TIER: Readonly<Record<SfxModelTier, string>> = {
  fast: WOOSH_DFLOW_ENGINE_ID,
  high_quality: WOOSH_FLOW_ENGINE_ID,
};

/**
 * The engine that serves a tier.
 *
 * Used by the SFX_Service to name an engine explicitly (Requirement 20.3) rather than let
 * routing pick the Asset_Kind default, because the default for `sfx` is one engine and the
 * tier the user chose may be the other.
 */
export function wooshEngineIdFor(tier: SfxModelTier): string {
  return WOOSH_ENGINE_ID_BY_TIER[tier];
}

/** The tier a Woosh engine identifier serves, or `null` if it is not a Woosh engine. */
export function tierOfWooshEngine(engineId: string): SfxModelTier | null {
  if (engineId === WOOSH_DFLOW_ENGINE_ID) return 'fast';
  if (engineId === WOOSH_FLOW_ENGINE_ID) return 'high_quality';
  return null;
}

/**
 * Checkpoint name sent on the wire.
 *
 * **Unverified**: the real checkpoint identifiers a Woosh deployment expects. These are the
 * names design §3.6 uses; see the note in `transport.ts`.
 */
export const WOOSH_MODEL_NAME_BY_TIER: Readonly<Record<SfxModelTier, string>> = {
  fast: 'woosh-dflow',
  high_quality: 'woosh-flow',
};
