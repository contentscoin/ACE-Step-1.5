/**
 * AI-generation disclosure seam — **interface only, no implementation here**.
 *
 * Requirements 16.5 (AI-generation label on the detail and public pages), 16.6
 * (watermark identifying AI generation, applied when the audio is saved) and 16.13
 * (an additional "synthetic voice" label on `dialogue` assets) are owned by
 * **task 8.3**. tasks.md states that each acceptance criterion has exactly one
 * implementing owner, so this file declares the shape of the seam and stops there:
 * no label mapping, no watermark, no rendering.
 *
 * ### Why the seam is declared from Moderation at all
 *
 * The three criteria sit at the far end of the same safety story this service
 * starts — a request that passes inspection produces an asset that must then be
 * disclosed. Naming the obligation here means 8.3 has an agreed vocabulary to
 * implement against rather than inventing one, and it makes the boundary visible in
 * review: nothing in `services/moderation/` calls this port.
 *
 * ### Integration point for task 8.3
 *
 * 8.3 implements `DisclosurePort` and calls it from the asset-save path (16.6) and
 * the detail/public presenters (16.5, 16.13). 8.3 also owns the mapping from
 * Asset_Kind to obligations — in particular that `dialogue` adds
 * `synthetic_voice_label`. That mapping is intentionally *not* written here.
 */

import type { AssetKind } from '../../domain/asset-kind';

/** Names of the three obligations Requirements 16.5, 16.6 and 16.13 impose. */
export const DISCLOSURE_OBLIGATIONS = [
  /** Requirement 16.5 — visible AI-generation label. */
  'ai_generated_label',
  /** Requirement 16.6 — inaudible watermark carried by the stored audio. */
  'inaudible_watermark',
  /** Requirement 16.13 — additional synthetic-voice notice. */
  'synthetic_voice_label',
] as const;

export type DisclosureObligation = (typeof DISCLOSURE_OBLIGATIONS)[number];

export interface DisclosureTarget {
  readonly assetId: string;
  readonly assetKind: AssetKind;
}

/** Implemented by task 8.3. Deliberately unimplemented and uncalled in 6.1. */
export interface DisclosurePort {
  /** Which obligations apply to this asset. The mapping is task 8.3's. */
  obligationsFor(target: DisclosureTarget): readonly DisclosureObligation[];
  /** Discharge them: watermark on save, labels on the presented views. */
  apply(target: DisclosureTarget): Promise<void>;
}
