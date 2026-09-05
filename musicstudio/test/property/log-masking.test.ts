import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildJobLog,
  isEmittableJobLog,
  toWireFields,
  JOB_LOG_STATUSES,
  type JobLogRecord,
} from '../../domain/observability/job-log';
import { FULLY_MASKED, MASKED_API_KEY_PREFIX } from '../../domain/audit-log/masking';

/**
 * Requirement 18.8 — no raw email or API key reaches a log line.
 *
 * **Validates: Requirements 18.5, 18.8**
 *
 * > THE MusicStudio SHALL 로그와 경보 메시지에 기록되는 사용자 이메일과 API 키를 마스킹된 형태로
 * > 기록한다
 *
 * ### Why the assertion is over the *whole serialised record*
 *
 * Checking `record.actorEmailMasked` proves that one field was masked. The clause is about the
 * log line, and a log line is what gets serialised — so the property asserted here is that the
 * raw local part and the raw key **do not appear anywhere** in `JSON.stringify(record)`.
 *
 * That is what catches the realistic regression: a field added to the record that happens to
 * carry the address, a message string interpolating it, a `context` bag someone spread a request
 * into. None of those is caught by asserting on the field that was already right.
 */

const arbEmail = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9._-]{2,20}$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{1,10}\.[a-z]{2,4}$/),
  )
  .map(([local, domain]) => `${local}@${domain}`);

const arbApiKey = fc.stringMatching(/^sk-(live|test)-[A-Za-z0-9]{8,24}$/);

const arbInput = fc.record({
  requestId: fc.string({ minLength: 1, maxLength: 20 }),
  userId: fc.string({ minLength: 1, maxLength: 20 }),
  engineId: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
  engineJobId: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
  modelName: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
  durationMs: fc.integer({ min: -5_000, max: 600_000 }),
  assetKind: fc.constantFrom('song', 'bgm', 'sfx', 'dialogue', 'stem', 'mix'),
  status: fc.constantFrom(...JOB_LOG_STATUSES),
  timestampMs: fc.integer({ min: 1, max: 2 ** 42 }),
});

/**
 * The serialised line for `input` with **no** secret on it.
 *
 * The properties below assert that a secret is absent from the whole line, and "absent" is only
 * a claim about masking when the secret was not already there for another reason. A generated
 * local part can be a substring of its own domain (`e--@e--0.aa` — the masked value keeps the
 * domain, so the line legitimately contains `e--`), or of a request id. Those cases say nothing
 * about the masker, so they are excluded with `fc.pre` against this baseline rather than by
 * weakening the assertion: the line is still checked whole, exactly as the header argues.
 */
function lineWithoutSecrets(input: Parameters<typeof buildJobLog>[0]): string {
  const bare = buildJobLog(input);
  return JSON.stringify(bare) + JSON.stringify(toWireFields(bare));
}

describe('Requirement 18.8 — a job log never carries raw PII', () => {
  it('keeps the raw local part out of the serialised record', () => {
    fc.assert(
      fc.property(arbInput, arbEmail, (input, email) => {
        const localPart = email.slice(0, email.indexOf('@'));
        const domain = email.slice(email.indexOf('@') + 1);
        fc.pre(!domain.includes(localPart) && !lineWithoutSecrets(input).includes(localPart));

        const record = buildJobLog({ ...input, actorEmail: email });
        const serialised = JSON.stringify(record) + JSON.stringify(toWireFields(record));

        // The whole line, not just the field — see the module header.
        expect(serialised).not.toContain(localPart);
        expect(serialised).not.toContain(email);
        // The domain survives, which is what makes the masked value useful for triage.
        expect(record.actorEmailMasked).toBe(`${FULLY_MASKED}@${domain}`);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it('keeps all but the last four characters of a key out', () => {
    fc.assert(
      fc.property(arbInput, arbApiKey, (input, apiKey) => {
        const secretPrefix = apiKey.slice(0, apiKey.length - 4);
        fc.pre(!lineWithoutSecrets(input).includes(secretPrefix));

        const record = buildJobLog({ ...input, apiKey });
        const serialised = JSON.stringify(record) + JSON.stringify(toWireFields(record));

        expect(serialised).not.toContain(apiKey);
        // The prefix that identifies the key's environment is secret too.
        expect(serialised).not.toContain(secretPrefix);
        expect(record.apiKeyMasked).toBe(`${MASKED_API_KEY_PREFIX}${apiKey.slice(-4)}`);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it('produces an emittable record from any input', () => {
    fc.assert(
      fc.property(
        arbInput,
        fc.option(arbEmail, { nil: undefined }),
        fc.option(arbApiKey, { nil: undefined }),
        (input, email, apiKey) => {
          const record = buildJobLog({
            ...input,
            ...(email === undefined ? {} : { actorEmail: email }),
            ...(apiKey === undefined ? {} : { apiKey }),
          });
          // The builder and the gate agree, so a correctly built record is never dropped.
          expect(isEmittableJobLog(record)).toBe(true);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('does not throw on a malformed address or key', () => {
    fc.assert(
      fc.property(arbInput, fc.string(), fc.string(), (input, email, apiKey) => {
        // A throw at a logging call site is the one failure that pushes a caller into logging
        // the raw value instead, so the builder is total.
        const record = buildJobLog({ ...input, actorEmail: email, apiKey });
        expect(isEmittableJobLog(record)).toBe(true);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it('never records a negative duration', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        // A clock going backwards is not a fast job, and a negative value in a percentile is
        // worse than a zero.
        expect(buildJobLog(input).durationMs).toBeGreaterThanOrEqual(0);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

describe('the emittability gate (Req 18.8)', () => {
  it('rejects a record that did not come through the builder', () => {
    // The gate is defence in depth: `buildJobLog` cannot produce an unmaskable record, so this
    // path is only reachable by a deserialised record or a literal from a call site that has
    // not been written yet. Requirement 18.8 is a property of what is *written*, so the check
    // is at the write — and this is the test that keeps it from being dead code.
    const base = buildJobLog({
      requestId: 'r',
      userId: 'u',
      durationMs: 1,
      assetKind: 'song',
      status: 'failed',
      timestampMs: 1,
    });

    expect(isEmittableJobLog({ ...base, actorEmailMasked: 'alice@example.com' })).toBe(false);
    expect(isEmittableJobLog({ ...base, apiKeyMasked: 'sk-live-8f2a91c4' })).toBe(false);
    expect(isEmittableJobLog({ ...base, actorEmailMasked: '***@example.com' })).toBe(true);
    expect(isEmittableJobLog({ ...base, apiKeyMasked: 'sk-***91c4' })).toBe(true);
    // A record with neither is emittable: the fields are optional, not required-and-masked.
    expect(isEmittableJobLog(base)).toBe(true);
  });
});

describe('the record is closed', () => {
  it('has exactly design §11.2’s fields and no open bag', () => {
    const record: JobLogRecord = buildJobLog({
      requestId: 'r',
      userId: 'u',
      durationMs: 1,
      assetKind: 'song',
      status: 'succeeded',
      timestampMs: 1,
      actorEmail: 'a@b.com',
      apiKey: 'sk-live-abcd1234',
    });

    // A `context` or `metadata` member is the hole 18.8 is really about — someone spreads a
    // request object into it a year from now. Adding one has to change this list first.
    expect(Object.keys(record).sort()).toEqual([
      'actorEmailMasked',
      'apiKeyMasked',
      'assetKind',
      'durationMs',
      'engineId',
      'engineJobId',
      'modelName',
      'requestId',
      'status',
      'timestampMs',
      'userId',
    ]);
  });

  it('emits design §11.2’s snake_case field names', () => {
    const wire = toWireFields(
      buildJobLog({
        requestId: 'r',
        userId: 'u',
        engineId: 'e',
        engineJobId: 'ej',
        modelName: 'm',
        durationMs: 1_234,
        assetKind: 'song',
        status: 'succeeded',
        timestampMs: 1_700_000_000_000,
      }),
    );

    expect(Object.keys(wire).sort()).toEqual([
      'asset_kind',
      'duration_ms',
      'engine_id',
      'engine_job_id',
      'model_name',
      'request_id',
      'status',
      'timestamp',
      'user_id',
    ]);
  });
});
