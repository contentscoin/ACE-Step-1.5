import { describe, expect, it } from 'vitest';

import {
  substituteArtistNames,
  type ArtistSubstitutionResult,
} from '../../../domain/moderation/artist-substitution';
import {
  CURATED_PUBLIC_FIGURES,
  figureNames,
  substitutableFigures,
  type PublicFigureEntry,
} from '../../../domain/moderation/public-figures';

/**
 * Requirement 16.3 — a real artist's name used to specify style is replaced with a
 * style description, and the replacement is reported.
 */

const table: readonly PublicFigureEntry[] = [
  { canonicalName: 'Adele', aliases: ['아델'], styleDescription: 'soul piano ballad' },
  { canonicalName: 'IU', aliases: ['아이유'], styleDescription: 'clear-toned Korean pop' },
  {
    canonicalName: 'Taylor Swift',
    aliases: [],
    styleDescription: 'confessional pop songwriting',
  },
  // Impersonation-only entry: no agreed style wording, so nothing to substitute with.
  { canonicalName: 'Jane Roe', aliases: [] },
];

describe('artist name substitution (Requirement 16.3)', () => {
  it('replaces a curated name with its style description', () => {
    const result = substituteArtistNames('a ballad in the style of Adele', table);

    expect(result.text).toBe('a ballad in the style of soul piano ballad');
    expect(result.substitutions).toEqual([
      {
        matchedText: 'Adele',
        canonicalName: 'Adele',
        styleDescription: 'soul piano ballad',
        startIndex: 25,
      },
    ]);
  });

  it('matches case-insensitively and keeps the original casing in the notice', () => {
    const result = substituteArtistNames('like ADELE but slower', table);

    expect(result.text).toBe('like soul piano ballad but slower');
    expect(result.substitutions[0]?.matchedText).toBe('ADELE');
    expect(result.substitutions[0]?.canonicalName).toBe('Adele');
  });

  it('substitutes an alias and reports the canonical name', () => {
    const result = substituteArtistNames('아이유 같은 감성으로', table);

    expect(result.text).toBe('clear-toned Korean pop 같은 감성으로');
    expect(result.substitutions[0]?.canonicalName).toBe('IU');
  });

  it('matches a Korean name followed by an attached particle', () => {
    // A word boundary that rejected any adjacent letter would miss this entirely:
    // Korean particles attach directly to the noun.
    const result = substituteArtistNames('아델의 목소리처럼', table);

    expect(result.text).toBe('soul piano ballad의 목소리처럼');
  });

  it('does not match a name embedded in a longer Latin word', () => {
    const result = substituteArtistNames('Adeleine sings about IUs', table);

    expect(result.text).toBe('Adeleine sings about IUs');
    expect(result.substitutions).toEqual([]);
  });

  it('leaves text with no curated name untouched, and returns the same string', () => {
    const input = 'warm lo-fi piano with vinyl crackle';
    const result = substituteArtistNames(input, table);

    expect(result.text).toBe(input);
    expect(result.substitutions).toEqual([]);
  });

  it('replaces every occurrence, reporting them in ascending position', () => {
    const result = substituteArtistNames('Adele verse, then Adele chorus', table);

    expect(result.text).toBe('soul piano ballad verse, then soul piano ballad chorus');
    expect(result.substitutions.map((entry) => entry.startIndex)).toEqual([0, 18]);
  });

  it('handles two different artists in one caption', () => {
    const result = substituteArtistNames('Adele meets 아이유', table);

    expect(result.text).toBe('soul piano ballad meets clear-toned Korean pop');
    expect(result.substitutions.map((entry) => entry.canonicalName)).toEqual(['Adele', 'IU']);
  });

  it('tolerates extra whitespace inside a multi-word name', () => {
    const result = substituteArtistNames('sounds like Taylor   Swift', table);

    expect(result.text).toBe('sounds like confessional pop songwriting');
  });

  it('leaves an entry with no style description in place', () => {
    // The name is still curated — Requirement 16.11 uses it — but 16.3 has nothing
    // to substitute it with, so the text is unchanged.
    const result = substituteArtistNames('a song about Jane Roe', table);

    expect(result.text).toBe('a song about Jane Roe');
    expect(result.substitutions).toEqual([]);
  });

  it('is deterministic and idempotent over a fixed corpus', () => {
    const corpus = [
      'Adele',
      'like 아이유 and Adele together',
      'Taylor Swift chorus, 아델 bridge',
      'no artist here at all',
      'ADELE ADELE ADELE',
      'Jane Roe narrates while Adele sings',
    ];

    for (const input of corpus) {
      const first = substituteArtistNames(input, table);
      // Deterministic: the same input yields an identical result object.
      expect(substituteArtistNames(input, table)).toEqual<ArtistSubstitutionResult>(first);
      // Idempotent: the sanitized text contains no curated name left to replace.
      expect(substituteArtistNames(first.text, table).text).toBe(first.text);
    }
  });
});

describe('the curated table (data invariants)', () => {
  it('gives every substitutable entry a non-empty style description', () => {
    for (const entry of substitutableFigures()) {
      expect(entry.styleDescription?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('never uses a curated name inside a style description', () => {
    // Otherwise substitution would stop being idempotent: the replacement text
    // would itself be substitutable on a second pass.
    const allNames = CURATED_PUBLIC_FIGURES.flatMap(figureNames);

    for (const entry of substitutableFigures()) {
      const description = entry.styleDescription ?? '';
      const rewritten = substituteArtistNames(description);
      expect(rewritten.text, `"${description}" contains a curated name`).toBe(description);
      expect(allNames.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate name across entries', () => {
    const names = CURATED_PUBLIC_FIGURES.flatMap(figureNames).map((name) => name.toLowerCase());

    expect(new Set(names).size).toBe(names.length);
  });
});
