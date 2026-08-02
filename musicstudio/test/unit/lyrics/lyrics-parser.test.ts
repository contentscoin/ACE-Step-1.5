import { describe, expect, it } from 'vitest';

import {
  countPlainTextLyricLines,
  isValidLyricsDocument,
  lyricsLineCount,
} from '../../../domain/lyrics/document';
import {
  UNRECOGNISED_SECTION_TAG,
  parseLyrics,
} from '../../../domain/lyrics/lyrics-parser';
import {
  RECOGNISED_LYRICS_SECTIONS,
  sectionLabelOf,
} from '../../../domain/lyrics/section-type';

/**
 * `Lyrics_Parser` worked examples (Requirements 9.1–9.4, 9.8).
 *
 * The properties in `test/property/lyrics-round-trip.test.ts` cover the universal
 * claims; these pin the specific readings the requirements leave to the
 * implementation — which seven names count, what "empty" means, and where the
 * boundary between a tag line and a lyric line falls.
 */

/** The label each section prints with, in order: the compact form of a document. */
function outlineOf(text: string): readonly (string | null)[] {
  return parseLyrics(text).document.sections.map((section) => sectionLabelOf(section.type));
}

describe('Requirement 9.1 — tagged plain text becomes an order-preserving document', () => {
  it('keeps section order and assigns each line to its own section', () => {
    const { document } = parseLyrics(
      ['[Intro]', 'ah ah', '[Verse 1]', 'first line', 'second line', '[Chorus]', 'hook'].join('\n'),
    );

    expect(document.sections).toEqual([
      { type: { kind: 'recognised', name: 'Intro' }, lines: ['ah ah'] },
      { type: { kind: 'recognised', name: 'Verse', ordinal: 1 }, lines: ['first line', 'second line'] },
      { type: { kind: 'recognised', name: 'Chorus' }, lines: ['hook'] },
    ]);
  });

  it('does not merge two sections that share a kind', () => {
    // A Verse appearing twice is two sections, in the order written — merging them
    // would silently reorder the song.
    expect(outlineOf('[Verse]\na\n[Chorus]\nb\n[Verse]\nc')).toEqual(['Verse', 'Chorus', 'Verse']);
  });

  it('keeps a tag that has no lines under it', () => {
    // `[Instrumental]` normally has nothing beneath it; dropping the empty section
    // would delete the instruction.
    const { document } = parseLyrics('[Verse]\na\n[Instrumental]\n[Outro]\nbye');
    expect(outlineOf('[Verse]\na\n[Instrumental]\n[Outro]\nbye')).toEqual([
      'Verse',
      'Instrumental',
      'Outro',
    ]);
    expect(document.sections[1]?.lines).toEqual([]);
  });

  it('parses \\r\\n and bare \\r the same as \\n', () => {
    const expected = outlineOf('[Verse]\na\n[Chorus]\nb');
    expect(outlineOf('[Verse]\r\na\r\n[Chorus]\r\nb')).toEqual(expected);
    expect(outlineOf('[Verse]\ra\r[Chorus]\rb')).toEqual(expected);
  });
});

describe('Requirement 9.2 — the seven section kinds are recognised', () => {
  it('recognises each of the seven names', () => {
    for (const name of RECOGNISED_LYRICS_SECTIONS) {
      const { document, warnings } = parseLyrics(`[${name}]\nline`);
      expect(document.sections[0]?.type).toEqual({ kind: 'recognised', name });
      // Recognised means recognised: no Requirement 9.4 warning.
      expect(warnings).toEqual([]);
    }
  });

  it('names exactly the seven the requirement lists', () => {
    expect([...RECOGNISED_LYRICS_SECTIONS].sort()).toEqual([
      'Bridge',
      'Chorus',
      'Instrumental',
      'Intro',
      'Outro',
      'Pre-Chorus',
      'Verse',
    ]);
  });

  it('recognises them case-insensitively and canonicalises the spelling', () => {
    for (const written of ['[verse]', '[VERSE]', '[Verse]', '[vErSe]']) {
      expect(outlineOf(`${written}\nline`)).toEqual(['Verse']);
    }
  });

  it('treats Pre-Chorus, Pre Chorus and PreChorus as the same kind', () => {
    for (const written of ['[Pre-Chorus]', '[Pre Chorus]', '[PreChorus]', '[pre_chorus]']) {
      expect(outlineOf(`${written}\nline`)).toEqual(['Pre-Chorus']);
    }
  });

  it('reads an ordinal without losing the kind', () => {
    const { document, warnings } = parseLyrics('[Verse 2]\nline');
    expect(document.sections[0]?.type).toEqual({ kind: 'recognised', name: 'Verse', ordinal: 2 });
    expect(warnings).toEqual([]);
  });

  it('keeps a padded ordinal as a custom label rather than renumbering it', () => {
    // `[Verse 01]` cannot be reprinted as `01`, so calling it Verse #1 would lose the
    // padding on the next round trip. It stays exactly as written.
    const { document } = parseLyrics('[Verse 01]\nline');
    expect(document.sections[0]?.type).toEqual({ kind: 'custom', label: 'Verse 01' });
  });
});

describe('Requirement 9.3 — lines before the first tag become an untyped leading section', () => {
  it('collects them into a section with no kind', () => {
    const { document } = parseLyrics('floating one\nfloating two\n[Chorus]\nhook');
    expect(document.sections[0]).toEqual({
      type: { kind: 'leading' },
      lines: ['floating one', 'floating two'],
    });
    expect(sectionLabelOf({ kind: 'leading' })).toBeNull();
  });

  it('creates no leading section when the text opens with a tag', () => {
    expect(outlineOf('[Verse]\na')).toEqual(['Verse']);
  });

  it('creates no leading section for blank lines before the first tag', () => {
    // Blank lines carry no lyric, so there is nothing to preserve.
    expect(outlineOf('\n  \n\t\n[Verse]\na')).toEqual(['Verse']);
  });
});

describe('Requirement 9.4 — an unrecognised tag is preserved and warned about', () => {
  it('keeps the label verbatim as a custom section', () => {
    const { document } = parseLyrics('[Hook]\nsing it');
    expect(document.sections[0]).toEqual({
      type: { kind: 'custom', label: 'Hook' },
      lines: ['sing it'],
    });
  });

  it('returns a warning naming the line and the tag', () => {
    const { warnings } = parseLyrics('[Verse]\na\n[Breakdown]\nb');
    expect(warnings).toEqual([
      {
        line: 3,
        code: UNRECOGNISED_SECTION_TAG,
        message: 'Unrecognised section tag "Breakdown" preserved as a custom section.',
        actual: '[Breakdown]',
      },
    ]);
  });

  it('warns once per unrecognised tag, not once per document', () => {
    const { warnings } = parseLyrics('[Hook]\na\n[Refrain]\nb\n[Chorus]\nc');
    expect(warnings.map((warning) => warning.line)).toEqual([1, 3]);
  });

  it('trims the label but keeps its internal spacing', () => {
    const { document } = parseLyrics('[  Guitar  solo  ]\nwail');
    expect(document.sections[0]?.type).toEqual({ kind: 'custom', label: 'Guitar  solo' });
  });
});

describe('the tag/lyric boundary', () => {
  it('treats a bracket tag with trailing text as a lyric line', () => {
    // The only total classification: `[Verse] oh oh` is content. Widening the tag rule
    // would turn this line into an empty Verse section and lose "oh oh".
    const { document } = parseLyrics('[Verse]\n[Chorus] oh oh');
    expect(document.sections).toEqual([
      { type: { kind: 'recognised', name: 'Verse' }, lines: ['[Chorus] oh oh'] },
    ]);
  });

  it('treats a line with a bracket in the middle as a lyric line', () => {
    expect(lyricsLineCount(parseLyrics('sing [loudly] now').document)).toBe(1);
  });

  it('treats a bracket line containing a nested bracket as a lyric line', () => {
    expect(lyricsLineCount(parseLyrics('[a[b]c]').document)).toBe(1);
  });

  it('treats an empty bracket as a tag with an empty custom label', () => {
    const { document } = parseLyrics('[]\nline');
    expect(document.sections[0]?.type).toEqual({ kind: 'custom', label: '' });
  });
});

describe('Requirement 9.8 — the line count invariant, and what "empty" means', () => {
  it('counts a whitespace-only line as empty', () => {
    const text = ['a', '', '   ', '\t', ' \t ', 'b'].join('\n');
    expect(countPlainTextLyricLines(text)).toBe(2);
    expect(lyricsLineCount(parseLyrics(text).document)).toBe(2);
  });

  it('excludes tag lines from the count', () => {
    const text = '[Verse]\na\n[Chorus]\nb\n[Outro]';
    expect(countPlainTextLyricLines(text)).toBe(2);
    expect(lyricsLineCount(parseLyrics(text).document)).toBe(2);
  });

  it('preserves a line that is only whitespace-padded content', () => {
    // The padding is the user's; it is content, not emptiness.
    const { document } = parseLyrics('[Verse]\n   indented   ');
    expect(document.sections[0]?.lines).toEqual(['   indented   ']);
  });

  it('counts nothing for empty and whitespace-only input', () => {
    for (const text of ['', '\n', '   \n\t\n']) {
      expect(lyricsLineCount(parseLyrics(text).document)).toBe(0);
      expect(countPlainTextLyricLines(text)).toBe(0);
    }
  });
});

describe('the parser only ever produces a valid document', () => {
  it('holds for the awkward inputs, which is what makes Requirement 9.7 follow from 9.6', () => {
    for (const text of [
      '',
      '\n\n\n',
      '[]',
      '[Verse]',
      '  [Chorus]  ',
      'lead\n[Verse 3]\na\n[wild tag]\nb',
      '[Verse]\r\n[Chorus]\r',
    ]) {
      expect(isValidLyricsDocument(parseLyrics(text).document)).toBe(true);
    }
  });
});
