import { describe, expect, it } from 'vitest';

import { watermarkId } from '../../../domain/disclosure/ai-disclosure';
import {
  createDisclosureService,
  type WatermarkDetection,
} from '../../../services/disclosure';
import { GenerationError } from '../../../services/generation/errors';

/**
 * Disclosure_Service.
 *
 * **Validates: Requirements 16.5, 16.6, 16.13, 13.7, 33.14**
 *
 * The mapping is tested in `ai-disclosure.test.ts`. What is tested here is the part that is
 * not a function of the asset's kind: reading the mark back out of the stored audio, and
 * whether it agrees with what the provenance row claims. The second half is the one worth
 * having — a presence check passes for an asset whose record says one scheme and whose audio
 * carries another, and that disagreement is exactly the bookkeeping failure 33.14 exists to
 * prevent.
 */

const TARGET = { assetId: 'asset-1', assetKind: 'song', objectKey: 'audio/asset-1' } as const;

function build(detection: WatermarkDetection) {
  const asked: string[] = [];
  const service = createDisclosureService({
    watermark: {
      detect: async (objectKey) => {
        asked.push(objectKey);
        return detection;
      },
    },
  });
  return { service, asked };
}

const FOUND: WatermarkDetection = { detected: true, statistic: 12.4, version: 1 };
const ABSENT: WatermarkDetection = { detected: false, statistic: 1.2, version: null };

describe('verifying the stored audio (Req 16.6)', () => {
  it('accepts audio that carries the mark', async () => {
    const { service, asked } = build(FOUND);

    await expect(service.verify(TARGET)).resolves.toBeUndefined();
    expect(asked).toEqual(['audio/asset-1']);
  });

  it('refuses audio that does not, and says how weak the evidence was', async () => {
    const { service } = build(ABSENT);

    const error = await service.verify(TARGET).catch((thrown: unknown) => thrown as GenerationError);

    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).code).toBe('disclosure_watermark_missing');
    expect((error as GenerationError).statusCode).toBe(500);
    // The statistic, so an operator reading the log can tell "nothing there" from "nearly".
    expect((error as GenerationError).details.statistic).toBe(1.2);
  });

  it('refuses when the audio carries a different scheme from the one recorded', async () => {
    // A presence-only check passes here. This is the case that makes the argument worth
    // taking: the file is marked, and the record still does not describe it.
    const { service } = build({ detected: true, statistic: 30, version: 2 });

    await expect(service.verify(TARGET, watermarkId(1))).rejects.toThrow(GenerationError);
  });

  it('accepts when the recorded scheme is the one found', async () => {
    const { service } = build(FOUND);

    await expect(service.verify(TARGET, watermarkId(1))).resolves.toBeUndefined();
  });

  it('checks presence alone when nothing was recorded to compare against', async () => {
    const { service } = build({ detected: true, statistic: 9, version: 7 });

    await expect(service.verify(TARGET)).resolves.toBeUndefined();
  });

  it('apply is the verification (Req 16.6)', async () => {
    // The service does not add the mark — `normalise_for_storage` does, because 16.6 attaches
    // the mark to the act of storing. See the module header.
    const { service } = build(ABSENT);

    await expect(service.apply(TARGET)).rejects.toThrow(GenerationError);
  });
});

describe('what the service tells the rest of the product', () => {
  it('reports every obligation, screen or not', () => {
    const { service } = build(FOUND);

    expect(service.obligationsFor({ assetId: 'a', assetKind: 'dialogue' })).toEqual([
      'ai_generated_label',
      'inaudible_watermark',
      'synthetic_voice_label',
    ]);
  });

  it('presents only the labels a screen can show (Reqs 16.5, 16.13)', () => {
    const { service } = build(FOUND);

    expect(service.presentationFor('dialogue')).toEqual({
      obligations: ['ai_generated_label', 'synthetic_voice_label'],
      labels: ['AI 생성', '합성 음성'],
    });
    expect(service.presentationFor('song').labels).toEqual(['AI 생성']);
  });

  it('gives the download its tag (Req 13.7)', () => {
    const { service } = build(FOUND);

    expect(Object.keys(service.downloadTags())).toEqual(['comment']);
  });

  it('writes the provenance pair from the version that marked the audio (Req 33.14)', () => {
    const { service } = build(FOUND);

    // From the worker's report rather than a constant, so an asset stored during a scheme
    // rollout records the scheme that actually marked it.
    expect(service.provenanceFieldsFor(2)).toEqual({
      aiGenerated: true,
      watermarkId: 'ms-wm-v2',
    });
  });
});
