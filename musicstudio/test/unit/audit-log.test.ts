import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FULLY_MASKED,
  isMaskedApiKey,
  isMaskedEmail,
  maskApiKey,
  maskEmail,
} from '../../domain/audit-log/masking';
import {
  AUDIT_LOG_MIN_RETENTION_DAYS,
  containsInstant,
  isPrunable,
  partitionFor,
  partitionsFrom,
  prunablePartitions,
} from '../../domain/audit-log/partition';
import { buildAuditLogEntry, isPiiMasked } from '../../domain/audit-log/entry';

describe('audit log PII masking (design §4.4, §11.2)', () => {
  it('keeps the domain and drops the local part', () => {
    expect(maskEmail('alice.smith@example.com')).toBe('***@example.com');
  });

  it('masks fully when there is no usable domain', () => {
    expect(maskEmail('not-an-email')).toBe(FULLY_MASKED);
    expect(maskEmail('trailing@')).toBe(FULLY_MASKED);
  });

  it('keeps only the last four characters of an API key', () => {
    expect(maskApiKey('sk-live-8f2a91c4')).toBe('sk-***91c4');
    expect(maskApiKey('abc')).toBe('sk-***');
  });

  it('never leaks the local part, for any address', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,12}$/),
        fc.stringMatching(/^[a-z]{3,8}\.[a-z]{2,4}$/),
        (localPart, domain) => {
          const masked = maskEmail(`${localPart}@${domain}`);

          expect(masked).toBe(`***@${domain}`);
          expect(masked.includes(localPart)).toBe(domain.includes(localPart));
          expect(isMaskedEmail(masked)).toBe(true);
          // Masking is idempotent, so re-logging a masked value is harmless.
          expect(maskEmail(masked)).toBe(masked);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never leaks more than the last four key characters', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{5,40}$/), (apiKey) => {
        const masked = maskApiKey(apiKey);

        expect(isMaskedApiKey(masked)).toBe(true);
        expect(masked).toBe(`sk-***${apiKey.slice(-4)}`);
        expect(masked.includes(apiKey)).toBe(false);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('masks at entry construction so raw values cannot be stored', () => {
    const entry = buildAuditLogEntry(
      {
        eventType: 'api_key_issued',
        actorEmail: 'owner@studio.example',
        apiKey: 'sk-test-deadbeef',
        afterValue: { scope: 'generate' },
      },
      new Date('2026-03-04T05:06:07.008Z'),
    );

    expect(entry.actorEmailMasked).toBe('***@studio.example');
    expect(entry.apiKeyMasked).toBe('sk-***beef');
    expect(isPiiMasked(entry)).toBe(true);
    expect(entry.eventTime.toISOString()).toBe('2026-03-04T05:06:07.008Z');
  });
});

describe('audit log monthly partitions (design §4.4)', () => {
  it('names partitions after the UTC month', () => {
    expect(partitionFor(new Date('2026-01-31T23:59:59.999Z'))).toEqual({
      name: 'audit_log_2026_01',
      fromInclusive: '2026-01-01',
      toExclusive: '2026-02-01',
    });
  });

  it('rolls the year over at December', () => {
    expect(partitionFor(new Date('2026-12-15T00:00:00.000Z')).toExclusive).toBe('2027-01-01');
  });

  it('produces consecutive, non-overlapping partitions', () => {
    const partitions = partitionsFrom(new Date('2026-11-20T00:00:00.000Z'), 4);

    expect(partitions.map((partition) => partition.name)).toEqual([
      'audit_log_2026_11',
      'audit_log_2026_12',
      'audit_log_2027_01',
      'audit_log_2027_02',
    ]);
    for (let index = 1; index < partitions.length; index += 1) {
      expect(partitions[index]?.fromInclusive).toBe(partitions[index - 1]?.toExclusive);
    }
  });

  it('places every instant in exactly one partition', () => {
    fc.assert(
      fc.property(
        // `noInvalidDate` is required: `fc.date` admits `Invalid Date` even
        // inside a min/max range, and an Invalid Date is not an instant, so it
        // lies outside the property's input space.
        fc.date({
          min: new Date('2000-01-01T00:00:00.000Z'),
          max: new Date('2100-01-01T00:00:00.000Z'),
          noInvalidDate: true,
        }),
        (instant) => {
          const partition = partitionFor(instant);

          expect(containsInstant(partition, instant)).toBe(true);
          expect(partition.name).toMatch(/^audit_log_\d{4}_\d{2}$/);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses a retention window shorter than 365 days', () => {
    const partition = partitionFor(new Date('2020-01-15T00:00:00.000Z'));

    expect(() => isPrunable(partition, new Date('2026-01-01T00:00:00.000Z'), 364)).toThrow(
      /at least 365 days/,
    );
  });

  it('never prunes a partition inside the retention window', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2015-01-01T00:00:00.000Z'),
          max: new Date('2035-01-01T00:00:00.000Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: AUDIT_LOG_MIN_RETENTION_DAYS, max: 3650 }),
        (now, retainDays) => {
          const partitions = partitionsFrom(new Date('2015-01-01T00:00:00.000Z'), 300);
          const cutoff = now.getTime() - retainDays * 86_400_000;

          for (const partition of prunablePartitions(partitions, now, retainDays)) {
            expect(Date.parse(`${partition.toExclusive}T00:00:00.000Z`)).toBeLessThanOrEqual(
              cutoff,
            );
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
