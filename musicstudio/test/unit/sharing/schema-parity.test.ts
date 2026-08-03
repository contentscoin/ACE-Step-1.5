import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PERSONA_STATUSES } from '../../../domain/persona/persona';
import {
  PERSONA_NAME_MAX_LENGTH,
  PERSONA_NAME_MIN_LENGTH,
  PERSONA_REFERENCE_MAX,
} from '../../../domain/persona/training-request';
import {
  ASSET_GENRE_COUNT_MAX,
  ASSET_GENRE_MAX_LENGTH,
  ASSET_GENRE_MIN_LENGTH,
  SHARE_TOKEN_LENGTH,
} from '../../../domain/sharing/bounds';

/**
 * `0017_sharing.sql` restates values that live in `domain/sharing/` and `domain/persona/`.
 * Restating is fine; drifting is not, and nothing else in the build would notice — a CHECK
 * permitting a 20-character token would simply accept what the validator rejects.
 *
 * Same arrangement, and same reason, as `test/unit/library/schema-parity.test.ts`.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ddl = readFileSync(join(ROOT, 'db/migrations/0017_sharing.sql'), 'utf8');

describe('0017_sharing.sql mirrors domain/sharing/bounds.ts', () => {
  it('bounds both share tokens at the domain length', () => {
    const matches = ddl.match(/char_length\(share_token\) = (\d+)/g) ?? [];
    // Two tables carry a token: `asset_share` and `sound_pack_share`.
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match).toBe(`char_length(share_token) = ${String(SHARE_TOKEN_LENGTH)}`);
    }
  });

  it('constrains the token alphabet to base64url on both tables', () => {
    const matches = ddl.match(/share_token ~ '\^\[A-Za-z0-9_-\]\+\$'/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it('bounds a genre at the domain values', () => {
    expect(ddl).toContain(
      `char_length(genre) BETWEEN ${String(ASSET_GENRE_MIN_LENGTH)} AND ${String(ASSET_GENRE_MAX_LENGTH)}`,
    );
  });

  it('caps the genres per asset at the domain value', () => {
    expect(ddl).toContain(`v_count > ${String(ASSET_GENRE_COUNT_MAX)}`);
  });

  it('stores genres normalised, as the domain does', () => {
    expect(ddl).toContain('genre = lower(btrim(genre))');
  });

  it('keys a like by the pair, which is what makes Property 20 true of the data', () => {
    expect(ddl).toContain('PRIMARY KEY (asset_id, account_id)');
  });

  it('keys a publication by the asset, so an asset has at most one live link', () => {
    expect(ddl).toContain('asset_id uuid PRIMARY KEY REFERENCES audio_asset (id)');
    expect(ddl).toContain('share_token text NOT NULL UNIQUE');
  });
});

describe('0017_sharing.sql mirrors domain/persona/', () => {
  it('declares the same status vocabulary, in the same order', () => {
    const rendered = PERSONA_STATUSES.map((status) => `'${status}'`).join(', ');
    expect(ddl).toContain(`CREATE TYPE persona_status AS ENUM (${rendered})`);
  });

  it('bounds the persona name at the domain values', () => {
    expect(ddl).toContain(
      `char_length(name) BETWEEN ${String(PERSONA_NAME_MIN_LENGTH)} AND ${String(PERSONA_NAME_MAX_LENGTH)}`,
    );
  });

  it('bounds the reference positions by the domain ceiling', () => {
    expect(ddl).toContain(`position BETWEEN 0 AND ${String(PERSONA_REFERENCE_MAX - 1)}`);
  });

  it('ties the ready state to having an adapter, and deletion to not having one', () => {
    // Requirements 15.4, 15.5, 15.7: the state and the artefact cannot disagree.
    expect(ddl).toContain("status <> 'ready' OR adapter_ref IS NOT NULL");
    expect(ddl).toContain("status <> 'deleted' OR adapter_ref IS NULL");
  });

  it('stores the consent record Requirement 15.8 asks for', () => {
    expect(ddl).toContain('rights_confirmed_at timestamptz NOT NULL');
  });

  it('keeps one row per (persona, reference), matching distinctReferences', () => {
    expect(ddl).toContain('PRIMARY KEY (persona_id, asset_id)');
  });
});
