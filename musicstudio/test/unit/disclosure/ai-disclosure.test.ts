import { describe, expect, it } from 'vitest';

import { ASSET_KINDS, type AssetKind } from '../../../domain/asset-kind';
import {
  AI_GENERATED_TAG_FIELD,
  AI_GENERATED_TAG_VALUE,
  DISCLOSURE_LABELS,
  DISCLOSURE_OBLIGATIONS,
  disclosureLabel,
  disclosuresFor,
  visibleDisclosuresFor,
  watermarkId,
  watermarkVersionOf,
} from '../../../domain/disclosure/ai-disclosure';
import { validateProvenance, type AssetProvenance } from '../../../domain/provenance';

/**
 * The AI-generation disclosure mapping.
 *
 * **Validates: Requirements 16.5, 16.6, 16.13, 13.7, 33.14**
 *
 * Four clauses that are the same statement made in four places, so what is checked is mostly
 * that they cannot come apart: every kind is disclosed, `dialogue` says the extra thing, the
 * label of an obligation exists, and provenance cannot be written without the watermark half
 * of 33.14's pair.
 */

describe('what each asset kind must disclose', () => {
  it.each(ASSET_KINDS)('%s carries the AI label and the watermark (Reqs 16.5, 16.6)', (kind) => {
    // Neither clause has an exception for a kind, so this is `each` rather than a sample.
    expect(disclosuresFor(kind)).toContain('ai_generated_label');
    expect(disclosuresFor(kind)).toContain('inaudible_watermark');
  });

  it('adds the synthetic-voice notice to dialogue and to nothing else (Req 16.13)', () => {
    const withNotice = ASSET_KINDS.filter((kind) =>
      disclosuresFor(kind).includes('synthetic_voice_label'),
    );

    expect(withNotice).toEqual(['dialogue']);
  });

  it('orders the obligations the same way for every kind', () => {
    // Two screens render this list; an order that depended on the kind would put the labels
    // in a different sequence on the detail page than on the public page for `dialogue`.
    for (const kind of ASSET_KINDS) {
      expect(disclosuresFor(kind)[0]).toBe('ai_generated_label');
    }
  });
});

describe('what the screens show', () => {
  it('shows the labels and not the watermark', () => {
    // The mark is a property of the audio; there is nothing on a screen for it to be.
    expect(visibleDisclosuresFor('song')).toEqual(['ai_generated_label']);
    expect(visibleDisclosuresFor('dialogue')).toEqual([
      'ai_generated_label',
      'synthetic_voice_label',
    ]);
  });

  it('has wording for every obligation', () => {
    for (const obligation of DISCLOSURE_OBLIGATIONS) {
      expect(disclosureLabel(obligation).length).toBeGreaterThan(0);
    }
    expect(Object.keys(DISCLOSURE_LABELS).sort()).toEqual([...DISCLOSURE_OBLIGATIONS].sort());
  });

  it('says 합성 음성 for the dialogue notice', () => {
    // The acceptance criterion names the words, so the words are asserted.
    expect(disclosureLabel('synthetic_voice_label')).toBe('합성 음성');
  });
});

describe('the download tag (Req 13.7)', () => {
  it('rides in a field every download format carries', () => {
    // `dsp/.../formats.py` measured which fields survive: comment and title do, software
    // does not. This is the agreement between the two sides.
    expect(AI_GENERATED_TAG_FIELD).toBe('comment');
  });

  it('is readable rather than a machine token', () => {
    // A listener who opens the file in a player is who the clause protects.
    expect(AI_GENERATED_TAG_VALUE).toMatch(/AI/);
    expect(AI_GENERATED_TAG_VALUE.length).toBeGreaterThan(20);
  });
});

describe('the watermark identifier (Req 33.14)', () => {
  it('round-trips a version', () => {
    expect(watermarkVersionOf(watermarkId(3))).toBe(3);
  });

  it.each([
    ['', 'empty'],
    ['ms-wm-v', 'no digits'],
    ['ms-wm-v0', 'zero is not a version'],
    ['ms-wm-v1.5', 'not an integer'],
    ['ms-wm-v 1', 'padded'],
    ['ms-wm-v1e3', 'an expression, not a version'],
    ['other-v1', 'another scheme'],
  ])('rejects %s (%s)', (id) => {
    expect(watermarkVersionOf(id)).toBeNull();
  });

  it('refuses to mint an identifier for a version that is not one', () => {
    expect(() => watermarkId(0)).toThrow(RangeError);
    expect(() => watermarkId(1.5)).toThrow(RangeError);
  });
});

describe('provenance keeps both halves of the pair (Req 33.14)', () => {
  const base: AssetProvenance = {
    engineId: 'ace-step-v1',
    weightLicenseId: 'apache-2.0',
    attributionText: 'MusicStudio',
    commercialUseAllowed: true,
    nonCommercialLicenseListVersion: 1,
    recordedAtMs: 1_800_000_000_000,
    aiGenerated: true,
    watermarkId: watermarkId(1),
  };

  it('accepts a record naming a real scheme', () => {
    expect(validateProvenance(base)).toEqual([]);
  });

  it('rejects a watermark identifier that names no scheme', () => {
    // The type makes the field required; this is what stops an empty string satisfying it.
    expect(validateProvenance({ ...base, watermarkId: '' })).toContain(
      'watermark_id_unrecognised',
    );
    expect(validateProvenance({ ...base, watermarkId: 'yes' })).toContain(
      'watermark_id_unrecognised',
    );
  });

  it('keeps the AI marking as a literal true rather than a boolean', () => {
    // `aiGenerated: false` does not typecheck, which is the invariant expressed as a type.
    const kinds: readonly AssetKind[] = ASSET_KINDS;
    expect(kinds.length).toBeGreaterThan(0);
    expect(base.aiGenerated).toBe(true);
  });
});
