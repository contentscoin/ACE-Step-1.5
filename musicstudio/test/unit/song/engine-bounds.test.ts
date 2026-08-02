import { describe, expect, it } from 'vitest';

import {
  SONG_BPM_MAX,
  SONG_BPM_MIN,
  SONG_DURATION_SECONDS_MAX,
  SONG_DURATION_SECONDS_MIN,
  SONG_TIME_SIGNATURES,
} from '../../../domain/song/engine-bounds';
import {
  KEY_SCALE_ACCIDENTALS,
  KEY_SCALE_MODES,
  KEY_SCALE_NOTES,
  VALID_KEY_SCALES,
  isKeyScale,
} from '../../../domain/song/key-scale';
import {
  ACCEPTED_VOCAL_LANGUAGES,
  VOCAL_LANGUAGE_AUTO,
  VOCAL_LANGUAGE_CODES,
  isVocalLanguage,
} from '../../../domain/song/vocal-language';

/**
 * Parity with `acestep/constants.py`.
 *
 * The engine's bounds are mirrored rather than imported, because the product layer
 * may not import `acestep/` (design §1.4.4). A mirror can drift, so the counts the
 * requirements quote are pinned here: if someone edits the note, accidental or mode
 * lists, or the language list, the count changes and this fails — which is the point
 * at which the mirror is compared against the engine again.
 */

describe('Requirement 4.5 — 70 key/scale combinations', () => {
  it('derives exactly 70, as 7 notes x 5 accidentals x 2 modes', () => {
    expect(KEY_SCALE_NOTES).toHaveLength(7);
    expect(KEY_SCALE_ACCIDENTALS).toHaveLength(5);
    expect(KEY_SCALE_MODES).toHaveLength(2);
    expect(VALID_KEY_SCALES).toHaveLength(70);
  });

  it('contains no duplicates', () => {
    expect(new Set(VALID_KEY_SCALES).size).toBe(70);
  });

  it('spells each combination as "<note><accidental> <mode>"', () => {
    expect(VALID_KEY_SCALES).toContain('C major');
    expect(VALID_KEY_SCALES).toContain('F# minor');
    expect(VALID_KEY_SCALES).toContain('B\u266D major');
    expect(VALID_KEY_SCALES).toContain('Eb minor');
  });

  it('matches exactly, because the engine compares the string against its own set', () => {
    expect(isKeyScale('C major')).toBe(true);
    expect(isKeyScale('c major')).toBe(false);
    expect(isKeyScale('C Major')).toBe(false);
    expect(isKeyScale('C  major')).toBe(false);
    expect(isKeyScale('H major')).toBe(false);
    expect(isKeyScale('C dorian')).toBe(false);
  });
});

describe('Requirement 3.7 — 50 vocal language codes', () => {
  it('holds exactly 50 codes', () => {
    expect(VOCAL_LANGUAGE_CODES).toHaveLength(50);
    expect(new Set(VOCAL_LANGUAGE_CODES).size).toBe(50);
  });

  it('keeps the engine sentinel out of the 50 but still accepts it', () => {
    // `VALID_LANGUAGES` in the engine has 51 entries: the 50 codes plus 'unknown',
    // which the engine's UI labels "Instrumental / auto" rather than a language.
    expect(VOCAL_LANGUAGE_CODES).not.toContain(VOCAL_LANGUAGE_AUTO);
    expect(ACCEPTED_VOCAL_LANGUAGES).toHaveLength(51);
    expect(isVocalLanguage(VOCAL_LANGUAGE_AUTO)).toBe(true);
  });

  it('accepts a code from the list and refuses one that is not on it', () => {
    expect(isVocalLanguage('ko')).toBe(true);
    expect(isVocalLanguage('yue')).toBe(true);
    expect(isVocalLanguage('kr')).toBe(false);
    expect(isVocalLanguage('EN')).toBe(false);
  });
});

describe('Requirements 4.2–4.4 — numeric bounds', () => {
  it('mirrors DURATION_MIN/DURATION_MAX, BPM_MIN/BPM_MAX and VALID_TIME_SIGNATURES', () => {
    expect([SONG_DURATION_SECONDS_MIN, SONG_DURATION_SECONDS_MAX]).toEqual([10, 600]);
    expect([SONG_BPM_MIN, SONG_BPM_MAX]).toEqual([30, 300]);
    expect(SONG_TIME_SIGNATURES).toEqual([2, 3, 4, 6]);
  });
});
