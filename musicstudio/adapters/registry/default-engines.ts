/**
 * Engine ↔ Asset_Kind mapping (design §3.6).
 *
 * `defaultEngineId` is the Requirement 20.2 assignment: exactly one per
 * Asset_Kind. `fallbackEngineId` is the Requirement 20.10 `WHERE` guard — the
 * clause only applies to kinds that actually have an alternative, which per
 * §3.6 is `sfx` and `dialogue`.
 *
 * The identifiers are the canonical ones concrete adapters must use (task 2.1+);
 * the registry never assumes an engine in this table is registered.
 */

import type { AssetKind } from '../../domain/asset-kind';

export const ACE_STEP_ENGINE_ID = 'ace-step-1.5';
/** §3.6: 고품질 등급 — the non-distilled model of Requirement 22.11. */
export const WOOSH_FLOW_ENGINE_ID = 'woosh-flow';
/**
 * §3.6: 고속 등급 — the distilled model of Requirement 22.10.
 *
 * A second engine identifier rather than a parameter on `woosh-flow`, because
 * Requirement 22.10 and 22.11 name *different models* and Requirement 20.1 makes the
 * Engine_Descriptor per-engine: the two tiers have different sampling-step windows and
 * are separately health-checked and separately quota-limited, all of which the registry
 * tracks per `engineId`. Design §3.6 lists both under `sfx` for the same reason.
 */
export const WOOSH_DFLOW_ENGINE_ID = 'woosh-dflow';
export const TTS_PRIMARY_ENGINE_ID = 'tts-engine-a';
export const TTS_SECONDARY_ENGINE_ID = 'tts-engine-b';
/** §3.6: `mix` is produced in-process by Mixdown_Renderer, not by an engine. */
export const MIXDOWN_RENDERER_ENGINE_ID = 'mixdown-renderer';

export interface EngineAssignment {
  readonly defaultEngineId: string;
  readonly fallbackEngineId?: string;
}

export const ENGINE_ASSIGNMENTS: Readonly<Record<AssetKind, EngineAssignment>> = {
  song: { defaultEngineId: ACE_STEP_ENGINE_ID },
  bgm: { defaultEngineId: ACE_STEP_ENGINE_ID },
  sfx: { defaultEngineId: WOOSH_FLOW_ENGINE_ID, fallbackEngineId: ACE_STEP_ENGINE_ID },
  dialogue: { defaultEngineId: TTS_PRIMARY_ENGINE_ID, fallbackEngineId: TTS_SECONDARY_ENGINE_ID },
  stem: { defaultEngineId: ACE_STEP_ENGINE_ID },
  mix: { defaultEngineId: MIXDOWN_RENDERER_ENGINE_ID },
};

/** Mutable assignment table; seeded from §3.6 and changed via 20.20-audited ops. */
export type EngineAssignmentTable = Map<AssetKind, EngineAssignment>;

export function createEngineAssignmentTable(
  seed: Readonly<Record<AssetKind, EngineAssignment>> = ENGINE_ASSIGNMENTS,
): EngineAssignmentTable {
  return new Map(Object.entries(seed) as [AssetKind, EngineAssignment][]);
}
