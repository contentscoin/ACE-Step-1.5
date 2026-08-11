/**
 * AI-generation disclosure seam.
 *
 * Requirements 16.5 (AI-generation label on the detail and public pages), 16.6
 * (watermark identifying AI generation, applied when the audio is saved) and 16.13
 * (an additional "synthetic voice" label on `dialogue` assets) are owned by
 * **task 8.3**. When task 6.1 declared this seam it named the three obligations here
 * and stopped, because the mapping and the wording were 8.3's to write.
 *
 * 8.3 has written them, in `domain/disclosure/ai-disclosure.ts`. The names are now
 * **re-exported from there** rather than declared twice: two spellings of the same
 * three obligations is how the public page comes to disclose something the download
 * does not.
 *
 * ### Why the seam is declared from Moderation at all
 *
 * The three criteria sit at the far end of the same safety story this service
 * starts — a request that passes inspection produces an asset that must then be
 * disclosed. Naming the obligation here means the implementation has an agreed
 * vocabulary rather than inventing one, and it keeps the boundary visible in
 * review: nothing in `services/moderation/` calls this port.
 *
 * The implementation is `services/disclosure/disclosure-service.ts`.
 */

import type { AssetKind } from '../../domain/asset-kind';

export {
  DISCLOSURE_OBLIGATIONS,
  type DisclosureObligation,
} from '../../domain/disclosure/ai-disclosure';

import type { DisclosureObligation } from '../../domain/disclosure/ai-disclosure';

export interface DisclosureTarget {
  readonly assetId: string;
  readonly assetKind: AssetKind;
}

/** Implemented by `services/disclosure`. */
export interface DisclosurePort {
  /** Which obligations apply to this asset. */
  obligationsFor(target: DisclosureTarget): readonly DisclosureObligation[];
  /** Discharge them: watermark on save, labels on the presented views. */
  apply(target: DisclosureTarget): Promise<void>;
}
