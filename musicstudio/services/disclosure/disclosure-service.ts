/**
 * Disclosure_Service — Requirements 16.5, 16.6, 16.13, 13.7, 33.14.
 *
 * The implementation `services/moderation/disclosure-port.ts` has been declaring since task
 * 6.1. Almost all of it is the pure mapping in `domain/disclosure/ai-disclosure.ts`; what is
 * here is the two things that are not a function of the asset's kind.
 *
 * ### `apply` verifies rather than marks
 *
 * The obvious reading of "discharge the obligations" is that this function adds the
 * watermark. It does not, and the reason is Requirement 16.6's own wording: 오디오가
 * 저장되면 — the mark belongs to the act of storing, and `normalise_for_storage` in the DSP
 * worker is that act. Marking here would mean a second place audio can be marked, and
 * therefore an asset stored by the other path and never marked at all.
 *
 * So this reads the mark back. That is worth more than it sounds: it is the only check in the
 * system that the audio in the object store carries what the provenance row claims it
 * carries. Everything else — the label, the tag, the provenance field — is a record *about*
 * the audio, and records agree with each other whether or not they agree with the file.
 *
 * ### Why the port is required
 *
 * Every other optional port in this codebase degrades to something harmless. This one does
 * not: a disclosure service without a way to read the audio is a function that returns
 * `undefined` and a requirement that is satisfied on paper. Composition without it is a
 * compile error rather than a quiet no-op.
 */

import type { AssetKind } from '../../domain/asset-kind';
import {
  AI_GENERATED_TAG_FIELD,
  AI_GENERATED_TAG_VALUE,
  disclosureLabel,
  disclosuresFor,
  visibleDisclosuresFor,
  watermarkId,
  watermarkVersionOf,
  type DisclosureObligation,
} from '../../domain/disclosure/ai-disclosure';
import type { DisclosureTarget } from '../moderation/disclosure-port';
import { disclosureWatermarkMissing } from './errors';
import type { WatermarkPort } from './ports';

export interface DisclosureServiceOptions {
  readonly watermark: WatermarkPort;
}

/** What a screen needs to satisfy Requirements 16.5 and 16.13: labels, in order. */
export interface DisclosurePresentation {
  readonly obligations: readonly DisclosureObligation[];
  readonly labels: readonly string[];
}

/** Requirement 33.14's pair, written together because the clause requires them together. */
export interface DisclosureProvenanceFields {
  readonly aiGenerated: true;
  readonly watermarkId: string;
}

export function createDisclosureService(options: DisclosureServiceOptions) {
  const { watermark } = options;

  return {
    /** Requirements 16.5, 16.6, 16.13 — every obligation, including the inaudible one. */
    obligationsFor(target: DisclosureTarget): readonly DisclosureObligation[] {
      return disclosuresFor(target.assetKind);
    },

    /**
     * Requirements 16.5, 16.13 — what the detail screen and the public page render.
     *
     * The watermark obligation is filtered out here rather than at each screen, because a
     * screen that decided for itself which obligations are visible is a screen that can
     * decide a different subset from the other one.
     */
    presentationFor(assetKind: AssetKind): DisclosurePresentation {
      const obligations = visibleDisclosuresFor(assetKind);
      return { obligations, labels: obligations.map(disclosureLabel) };
    },

    /** Requirement 13.7 — the metadata tag every downloaded file carries. */
    downloadTags(): Readonly<Record<string, string>> {
      return { [AI_GENERATED_TAG_FIELD]: AI_GENERATED_TAG_VALUE };
    },

    /**
     * Requirement 33.14 — the provenance pair, from what the worker reported.
     *
     * Takes the version the storage path returned rather than reading a constant, so an
     * asset stored while a scheme change is rolling out records the scheme that actually
     * marked it.
     */
    provenanceFieldsFor(watermarkVersion: number): DisclosureProvenanceFields {
      return { aiGenerated: true, watermarkId: watermarkId(watermarkVersion) };
    },

    /**
     * Requirement 16.6 — confirm the stored audio carries the mark.
     *
     * `expectedWatermarkId` is the provenance row's. Passing it makes this an agreement
     * check between the record and the file rather than a mere presence check: an asset whose
     * provenance claims version 1 and whose audio carries version 2 is a bookkeeping failure,
     * and it is invisible to a test that only asks "is there a mark".
     */
    async verify(
      target: DisclosureTarget & { readonly objectKey: string },
      expectedWatermarkId?: string,
    ): Promise<void> {
      const detection = await watermark.detect(target.objectKey);
      const expectedVersion =
        expectedWatermarkId === undefined ? null : watermarkVersionOf(expectedWatermarkId);

      const agrees =
        detection.detected &&
        (expectedVersion === null || detection.version === expectedVersion);

      if (!agrees) {
        throw disclosureWatermarkMissing({
          assetId: target.assetId,
          objectKey: target.objectKey,
          statistic: detection.statistic,
        });
      }
    },

    /** `DisclosurePort.apply`. See the module header for why it verifies. */
    async apply(target: DisclosureTarget & { readonly objectKey: string }): Promise<void> {
      await this.verify(target);
    },
  };
}

export type DisclosureService = ReturnType<typeof createDisclosureService>;
