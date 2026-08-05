/**
 * Disclosure_Service (task 8.3) — Requirements 16.5, 16.6, 16.13, 13.7, 33.14.
 *
 * The mapping and the wording are in `domain/disclosure/ai-disclosure.ts`; this layer adds
 * the one impure part, reading the mark back out of stored audio.
 */

export {
  createDisclosureService,
  type DisclosurePresentation,
  type DisclosureProvenanceFields,
  type DisclosureService,
  type DisclosureServiceOptions,
} from './disclosure-service';
export { disclosureWatermarkMissing } from './errors';
export type { WatermarkDetection, WatermarkPort } from './ports';
