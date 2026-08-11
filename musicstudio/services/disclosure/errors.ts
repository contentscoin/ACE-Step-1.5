/**
 * The disclosure service's one rejection.
 *
 * Requirement 16.6 is about what the *stored* audio contains, so the only thing that can go
 * wrong is that it does not contain it. A 500 rather than a 4xx: nothing the caller did
 * produced this, and nothing the caller can change will fix it.
 */

import { GenerationError } from '../generation/errors';

export function disclosureWatermarkMissing(details: {
  readonly assetId: string;
  readonly objectKey: string;
  readonly statistic: number;
}): GenerationError {
  return new GenerationError(
    500,
    'disclosure_watermark_missing',
    'The stored audio does not carry the AI-generation watermark.',
    details,
  );
}
