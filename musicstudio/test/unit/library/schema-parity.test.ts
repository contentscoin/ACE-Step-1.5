import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSET_CAPTION_MAX_LENGTH,
  ASSET_TAG_COUNT_MAX,
  ASSET_TAG_MAX_LENGTH,
  ASSET_TAG_MIN_LENGTH,
  PLAYLIST_NAME_MAX_LENGTH,
  PLAYLIST_NAME_MIN_LENGTH,
} from '../../../domain/library/bounds';
import {
  COMMON_DOWNLOAD_FORMATS,
  LOSSLESS_FORMATS,
  SFX_DOWNLOAD_FORMATS,
} from '../../../domain/library/download';

/**
 * The bounds in `0016_library.sql` and the format sets in `formats.py` are restatements of
 * values that live in `domain/library/`. Restating is fine; drifting is not, and nothing
 * else in the build would notice — a CHECK that permitted 40-character tags would simply
 * accept what the validator rejects, silently, until a row arrived from another writer.
 *
 * Same arrangement, and same reason, as `test/unit/sound-pack/schema-parity.test.ts`.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

describe('0016_library.sql mirrors domain/library/bounds.ts', () => {
  const ddl = read('db/migrations/0016_library.sql');

  it('bounds the caption at the domain value', () => {
    expect(ddl).toContain(`char_length(caption) <= ${String(ASSET_CAPTION_MAX_LENGTH)}`);
  });

  it('bounds a tag at the domain values', () => {
    expect(ddl).toContain(
      `char_length(tag) BETWEEN ${String(ASSET_TAG_MIN_LENGTH)} AND ${String(ASSET_TAG_MAX_LENGTH)}`,
    );
  });

  it('caps the tags per asset at the domain value', () => {
    expect(ddl).toContain(`v_count > ${String(ASSET_TAG_COUNT_MAX)}`);
  });

  it('bounds a playlist name at the domain values', () => {
    expect(ddl).toContain(
      `char_length(name) BETWEEN ${String(PLAYLIST_NAME_MIN_LENGTH)} AND ` +
        `${String(PLAYLIST_NAME_MAX_LENGTH)}`,
    );
  });

  it('stores tags already normalised, which is what lets search skip case folding', () => {
    expect(ddl).toContain('tag = lower(btrim(tag))');
  });

  it('keeps a playlist s order in the primary key rather than in a query', () => {
    expect(ddl).toContain('PRIMARY KEY (playlist_id, position)');
  });
});

describe('download formats mirror dsp/src/musicstudio_dsp/formats.py', () => {
  const python = read('dsp/src/musicstudio_dsp/formats.py');

  function tupleAfter(name: string): string[] {
    const match = new RegExp(`${name}[^=]*= *\\(([^)]*)\\)`).exec(python);
    const body = match?.[1];
    if (body === undefined) throw new Error(`no ${name} in formats.py`);
    return [...body.matchAll(/"([a-z0-9]+)"/g)].map((entry) => entry[1] ?? '');
  }

  it('agrees on the formats every kind offers (Requirement 13.2)', () => {
    expect(tupleAfter('DOWNLOAD_FORMATS')).toEqual([...COMMON_DOWNLOAD_FORMATS]);
  });

  it('agrees on the sfx set (Requirement 13.9)', () => {
    expect(tupleAfter('SFX_DOWNLOAD_FORMATS')).toEqual([...SFX_DOWNLOAD_FORMATS]);
  });

  it('agrees on which formats are lossless (Requirement 13.4)', () => {
    const match = /LOSSLESS_FORMATS[^=]*= *frozenset\(\{([^}]*)\}\)/.exec(python);
    const formats = [...(match?.[1] ?? '').matchAll(/"([a-z0-9]+)"/g)].map((entry) => entry[1]);
    expect(formats.sort()).toEqual([...LOSSLESS_FORMATS].sort());
  });
});
