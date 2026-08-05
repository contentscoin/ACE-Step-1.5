import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  API_KEY_FINGERPRINT_CHARS,
  API_KEY_LABEL_MAX_LENGTH,
  API_KEY_PREFIX,
} from '../../../domain/public-api/api-key';
import { DEFAULT_REQUESTS_PER_MINUTE } from '../../../domain/public-api/rate-limit';
import { WEBHOOK_URL_MAX_LENGTH } from '../../../domain/public-api/webhook';

/**
 * `0018_public_api.sql` restates values that live in `domain/public-api/`. Restating is fine;
 * drifting is not, and nothing else in the build would notice — a CHECK permitting a
 * four-character fingerprint would simply accept what the validator rejects.
 *
 * Same arrangement, and same reason, as `test/unit/sharing/schema-parity.test.ts`.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ddl = readFileSync(join(ROOT, 'db/migrations/0018_public_api.sql'), 'utf8');

describe('0018_public_api.sql mirrors domain/public-api', () => {
  it('shapes the fingerprint with the domain prefix and character count', () => {
    expect(ddl).toContain(
      `fingerprint ~ '^${API_KEY_PREFIX}[A-Za-z0-9_-]{${String(API_KEY_FINGERPRINT_CHARS)}}$'`,
    );
  });

  it('bounds the label at the domain maximum', () => {
    expect(ddl).toContain(`char_length(btrim(label)) BETWEEN 1 AND ${String(API_KEY_LABEL_MAX_LENGTH)}`);
  });

  it('defaults the per-key rate limit to the domain default', () => {
    expect(ddl).toContain(`requests_per_minute integer NOT NULL DEFAULT ${String(DEFAULT_REQUESTS_PER_MINUTE)}`);
  });

  it('bounds the webhook URL at the domain maximum', () => {
    expect(ddl).toContain(`char_length(url) BETWEEN 1 AND ${String(WEBHOOK_URL_MAX_LENGTH)}`);
  });

  it('accepts only https webhook URLs', () => {
    expect(ddl).toContain("url LIKE 'https://%'");
  });
});

describe('there is nowhere to put a plaintext key (Req 17.2)', () => {
  it('stores a hash and nothing that could hold the key', () => {
    // Asserted rather than trusted to review. The failure this catches is a column added later
    // for a debugging session and never removed, which turns a database dump into a set of
    // live credentials.
    const apiKeyTable = ddl.slice(ddl.indexOf('CREATE TABLE api_key'), ddl.indexOf('CREATE INDEX'));
    const columns = [...apiKeyTable.matchAll(/^\s{4}([a-z_]+) /gm)].map((match) => match[1]);

    expect(columns).toEqual([
      'id',
      'account_id',
      'key_hash',
      'fingerprint',
      'label',
      'created_at',
      'revoked_at',
      'requests_per_minute',
    ]);
  });

  it('constrains the hash to the shape of a SHA-256 digest', () => {
    // A row whose `key_hash` is the key itself would authenticate — the lookup is by hash, and
    // a plaintext "hash" is a hash of nothing. The CHECK is what stops that reaching the table.
    expect(ddl).toContain("key_hash ~ '^[0-9a-f]{64}$'");
  });

  it('makes the hash unique, so one credential cannot have two identities', () => {
    expect(ddl).toMatch(/key_hash text NOT NULL UNIQUE/);
  });
});
