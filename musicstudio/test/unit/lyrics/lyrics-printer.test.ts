import { describe, expect, it } from 'vitest';

import { EMPTY_LYRICS_DOCUMENT, lyricsDocumentDefects } from '../../../domain/lyrics/document';
import { parseLyrics } from '../../../domain/lyrics/lyrics-parser';
import { printLyrics } from '../../../domain/lyrics/lyrics-printer';
import { LEADING_SECTION } from '../../../domain/lyrics/section-type';

/**
 * `Lyrics_Printer` worked examples (Requirement 9.5).
 *
 * What the round-trip property cannot state: the *shape* of the text a user reads and
 * pastes into a generation request. Round-trip equivalence would be satisfied by an
 * output nobody would want to look at.
 */

describe('Requirement 9.5 — a document becomes tagged plain text', () => {
  it('emits one tag line per section, followed by its lines', () => {
    const text = printLyrics({
      sections: [
        { type: { kind: 'recognised', name: 'Verse', ordinal: 1 }, lines: ['first', 'second'] },
        { type: { kind: 'recognised', name: 'Chorus' }, lines: ['hook'] },
      ],
    });

    expect(text).toBe('[Verse 1]\nfirst\nsecond\n\n[Chorus]\nhook');
  });

  it('emits the leading section with no tag at all', () => {
    // Requirement 9.3's section has no kind, so it has no label to print. Inventing
    // one would make the next parse read it as a custom section.
    const text = printLyrics({
      sections: [
        { type: LEADING_SECTION, lines: ['floating'] },
        { type: { kind: 'recognised', name: 'Verse' }, lines: ['verse line'] },
      ],
    });

    expect(text).toBe('floating\n\n[Verse]\nverse line');
  });

  it('emits a custom label verbatim', () => {
    expect(printLyrics({ sections: [{ type: { kind: 'custom', label: 'Hook' }, lines: ['a'] }] })).toBe(
      '[Hook]\na',
    );
  });

  it('emits a bare tag for a section with no lines', () => {
    expect(
      printLyrics({
        sections: [
          { type: { kind: 'recognised', name: 'Instrumental' }, lines: [] },
          { type: { kind: 'recognised', name: 'Outro' }, lines: ['bye'] },
        ],
      }),
    ).toBe('[Instrumental]\n\n[Outro]\nbye');
  });

  it('prints an empty document as an empty string', () => {
    expect(printLyrics(EMPTY_LYRICS_DOCUMENT)).toBe('');
  });
});

describe('canonical tag spelling', () => {
  it('normalises casing and Pre-Chorus spacing on the way out', () => {
    const { document } = parseLyrics(
      ['[intro]', 'a', '[PRE CHORUS]', 'b', '[prechorus]', 'c'].join('\n'),
    );

    expect(printLyrics(document)).toBe('[Intro]\na\n\n[Pre-Chorus]\nb\n\n[Pre-Chorus]\nc');
  });

  it('trims a padded tag label', () => {
    expect(printLyrics(parseLyrics('[  Chorus  ]\nhook').document)).toBe('[Chorus]\nhook');
  });
});

describe('printed text is a fixed point of print-after-parse', () => {
  it('normalises blank-line runs once and then stops changing', () => {
    const messy = '[Verse]\n\n\na\n\n\n\n[Chorus]\nb\n\n';
    const once = printLyrics(parseLyrics(messy).document);

    expect(once).toBe('[Verse]\na\n\n[Chorus]\nb');
    expect(printLyrics(parseLyrics(once).document)).toBe(once);
  });
});

describe('document validity states exactly what the printer can round-trip', () => {
  it('rejects a leading section that is not first', () => {
    expect(
      lyricsDocumentDefects({
        sections: [
          { type: { kind: 'recognised', name: 'Verse' }, lines: ['a'] },
          { type: LEADING_SECTION, lines: ['b'] },
        ],
      }),
    ).toEqual([{ kind: 'leading_section_out_of_position', sectionIndex: 1 }]);
  });

  it('rejects an empty leading section, which prints as nothing', () => {
    expect(lyricsDocumentDefects({ sections: [{ type: LEADING_SECTION, lines: [] }] })).toEqual([
      { kind: 'empty_leading_section' },
    ]);
  });

  it('rejects a custom label that would reparse as a recognised kind', () => {
    const defects = lyricsDocumentDefects({
      sections: [{ type: { kind: 'custom', label: 'verse' }, lines: ['a'] }],
    });
    expect(defects).toEqual([
      { kind: 'unprintable_custom_label', sectionIndex: 0, label: 'verse' },
    ]);
  });

  it('rejects a custom label containing a bracket, which would stop being a tag line', () => {
    expect(
      lyricsDocumentDefects({
        sections: [{ type: { kind: 'custom', label: 'a]b' }, lines: ['x'] }],
      }),
    ).toEqual([{ kind: 'unprintable_custom_label', sectionIndex: 0, label: 'a]b' }]);
  });

  it('rejects a blank line, a tag-shaped line and an embedded newline', () => {
    const defects = lyricsDocumentDefects({
      sections: [
        {
          type: { kind: 'recognised', name: 'Verse' },
          lines: ['   ', '[Chorus]', 'a\nb', 'fine'],
        },
      ],
    });

    expect(defects.map((defect) => 'lineIndex' in defect ? defect.lineIndex : null)).toEqual([
      0, 1, 2,
    ]);
  });
});
