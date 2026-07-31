import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DUCKING_ATTACK_DEFAULT_MS,
  DUCKING_ATTACK_MS,
  DUCKING_DEPTH_DB,
  DUCKING_DEPTH_DEFAULT_DB,
  DUCKING_RELEASE_DEFAULT_MS,
  DUCKING_RELEASE_MS,
  LOUDNESS_TARGET_DEFAULT_LUFS,
  LOUDNESS_TARGET_LUFS,
  isOnLoudnessTargetStep,
  isWithin,
} from '../../../domain/mastering/bounds';
import {
  duckingRequestViolations,
  loudnessRequestViolations,
  resolveDuckingParameters,
  resolveLoudnessParameters,
} from '../../../domain/mastering/validation';
import { ASSET_ID, ORIGINAL_VERSION_ID } from '../../support/mastering-harness';

/**
 * Mastering request validation.
 *
 * **Validates: Requirements 30.5, 30.13, 30.14, 30.15, 30.26**
 *
 * The tests that matter are the ones about *which* violations come back and *how many*:
 * Requirement 30.26 asks for the violated parameter names plural, and a validator that
 * stopped at the first one would satisfy every single-fault test while making a caller with
 * three bad values learn about them one round trip at a time.
 */

const SUBJECT = { assetId: ASSET_ID, versionId: ORIGINAL_VERSION_ID };

describe('the loudness target (Requirements 30.5, 30.26)', () => {
  it('accepts a value on the 0.1 step inside the range', () => {
    for (const targetLufs of [-30.0, -23.4, -14.0, -6.1, -6.0]) {
      expect(loudnessRequestViolations({ subject: SUBJECT, targetLufs })).toEqual([]);
    }
  });

  it('accepts both ends of the range inclusively', () => {
    // "이상 … 이하" — both bounds are members.
    expect(loudnessRequestViolations({ subject: SUBJECT, targetLufs: -30.0 })).toEqual([]);
    expect(loudnessRequestViolations({ subject: SUBJECT, targetLufs: -6.0 })).toEqual([]);
  });

  it('refuses a value outside the range and reports the range', () => {
    const violations = loudnessRequestViolations({ subject: SUBJECT, targetLufs: -31 });

    expect(violations).toEqual([
      {
        field: 'targetLufs',
        received: -31,
        allowed: { kind: 'range', min: -30.0, max: -6.0, integer: false },
      },
    ]);
  });

  it('refuses a value off the 0.1 step rather than snapping it', () => {
    // Snapping would make the value the user asked for and the value recorded on the
    // version differ with nothing in the response saying so.
    expect(loudnessRequestViolations({ subject: SUBJECT, targetLufs: -14.05 })).toHaveLength(1);
    expect(loudnessRequestViolations({ subject: SUBJECT, targetLufs: -14.03 })).toHaveLength(1);
  });

  it('refuses a non-finite value', () => {
    for (const targetLufs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(loudnessRequestViolations({ subject: SUBJECT, targetLufs })).toHaveLength(1);
    }
  });

  it('has nothing to say about an omitted target', () => {
    // Requirement 30.5 lets it be omitted; the default is applied afterwards.
    expect(loudnessRequestViolations({ subject: SUBJECT })).toEqual([]);
  });
});

describe('the step test accepts exactly the values Requirement 30.5 permits', () => {
  it('accepts every tenth without tripping over IEEE-754', () => {
    // `-14.1 % 0.1` is 0.09999999999999964, so a modulo test would reject every odd tenth.
    // Checked across the whole permitted range rather than on a couple of examples.
    for (let tenths = -300; tenths <= -60; tenths += 1) {
      const value = tenths / 10;
      expect(isOnLoudnessTargetStep(value), String(value)).toBe(true);
      expect(loudnessRequestViolations({ subject: SUBJECT, targetLufs: value })).toEqual([]);
    }
  });

  it('rejects a value strictly between two tenths', () => {
    expect(isOnLoudnessTargetStep(-14.05)).toBe(false);
    expect(isOnLoudnessTargetStep(-14.123)).toBe(false);
  });
});

describe('the ducking parameters (Requirements 30.13, 30.14, 30.15, 30.26)', () => {
  it('accepts the defaults and both ends of every range', () => {
    expect(
      duckingRequestViolations({
        dialogueSubject: SUBJECT,
        musicSubject: SUBJECT,
        depthDb: DUCKING_DEPTH_DEFAULT_DB,
        attackMs: DUCKING_ATTACK_DEFAULT_MS,
        releaseMs: DUCKING_RELEASE_DEFAULT_MS,
      }),
    ).toEqual([]);

    const extremes: readonly [number, number, number][] = [
      [DUCKING_DEPTH_DB.min, DUCKING_ATTACK_MS.min, DUCKING_RELEASE_MS.min],
      [DUCKING_DEPTH_DB.max, DUCKING_ATTACK_MS.max, DUCKING_RELEASE_MS.max],
    ];
    for (const [depthDb, attackMs, releaseMs] of extremes) {
      expect(
        duckingRequestViolations({
          dialogueSubject: SUBJECT,
          musicSubject: SUBJECT,
          depthDb,
          attackMs,
          releaseMs,
        }),
      ).toEqual([]);
    }
  });

  it('reports every violated parameter, not just the first (Requirement 30.26)', () => {
    const violations = duckingRequestViolations({
      dialogueSubject: SUBJECT,
      musicSubject: SUBJECT,
      depthDb: -40,
      attackMs: 5,
      releaseMs: 9_000,
    });

    expect(violations.map((violation) => violation.field)).toEqual([
      'depthDb',
      'attackMs',
      'releaseMs',
    ]);
  });

  it('reports each parameter\u2019s own range', () => {
    const violations = duckingRequestViolations({
      dialogueSubject: SUBJECT,
      musicSubject: SUBJECT,
      depthDb: -40,
      attackMs: 5,
      releaseMs: 9_000,
    });

    expect(violations.map((violation) => violation.allowed)).toEqual([
      { kind: 'range', min: -24, max: -3, integer: false },
      { kind: 'range', min: 10, max: 500, integer: false },
      { kind: 'range', min: 50, max: 2000, integer: false },
    ]);
  });

  it('refuses a positive depth, which would be a boost rather than a duck', () => {
    expect(
      duckingRequestViolations({
        dialogueSubject: SUBJECT,
        musicSubject: SUBJECT,
        depthDb: 6,
      }),
    ).toHaveLength(1);
  });

  it('has nothing to say about omitted parameters', () => {
    expect(
      duckingRequestViolations({ dialogueSubject: SUBJECT, musicSubject: SUBJECT }),
    ).toEqual([]);
  });
});

describe('defaults (Requirements 30.5, 30.13, 30.14, 30.15)', () => {
  it('applies -14.0 LUFS and says it did', () => {
    expect(resolveLoudnessParameters({ subject: SUBJECT })).toEqual({
      targetLufs: LOUDNESS_TARGET_DEFAULT_LUFS,
      appliedDefaults: ['targetLufs'],
    });
  });

  it('leaves a supplied target alone and reports no default', () => {
    expect(resolveLoudnessParameters({ subject: SUBJECT, targetLufs: -20 })).toEqual({
      targetLufs: -20,
      appliedDefaults: [],
    });
  });

  it('applies all three ducking defaults and names them', () => {
    expect(
      resolveDuckingParameters({ dialogueSubject: SUBJECT, musicSubject: SUBJECT }),
    ).toEqual({
      depthDb: -12,
      attackMs: 50,
      releaseMs: 300,
      appliedDefaults: ['depthDb', 'attackMs', 'releaseMs'],
    });
  });

  it('fills only the omitted ones', () => {
    expect(
      resolveDuckingParameters({
        dialogueSubject: SUBJECT,
        musicSubject: SUBJECT,
        attackMs: 120,
      }),
    ).toEqual({
      depthDb: -12,
      attackMs: 120,
      releaseMs: 300,
      appliedDefaults: ['depthDb', 'releaseMs'],
    });
  });
});

describe('the resolved parameters are always admissible', () => {
  it('is true for every request the validator accepted', () => {
    // An unnumbered property test. Design §10 numbers Properties 1–24 and this is not one of
    // them; it is labelled so task 9.2's audit does not miscount it.
    //
    // The invariant matters because the resolvers are total by *precondition* — they never
    // clamp — so a resolver that filled in a default outside its own range would produce
    // parameters no validator had ever seen.
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: -240, max: -30 }), { nil: undefined }),
        fc.option(fc.integer({ min: 10, max: 500 }), { nil: undefined }),
        fc.option(fc.integer({ min: 50, max: 2_000 }), { nil: undefined }),
        (depthTenths, attackMs, releaseMs) => {
          const depthDb = depthTenths === undefined ? undefined : depthTenths / 10;
          const request = {
            dialogueSubject: SUBJECT,
            musicSubject: SUBJECT,
            ...(depthDb === undefined ? {} : { depthDb }),
            ...(attackMs === undefined ? {} : { attackMs }),
            ...(releaseMs === undefined ? {} : { releaseMs }),
          };
          if (duckingRequestViolations(request).length > 0) return true;

          const resolved = resolveDuckingParameters(request);
          return (
            isWithin(DUCKING_DEPTH_DB, resolved.depthDb) &&
            isWithin(DUCKING_ATTACK_MS, resolved.attackMs) &&
            isWithin(DUCKING_RELEASE_MS, resolved.releaseMs)
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is true for every accepted loudness target', () => {
    fc.assert(
      fc.property(fc.integer({ min: -400, max: 0 }), (tenths) => {
        const targetLufs = tenths / 10;
        const request = { subject: SUBJECT, targetLufs };
        if (loudnessRequestViolations(request).length > 0) return true;

        const resolved = resolveLoudnessParameters(request);
        return (
          isWithin(LOUDNESS_TARGET_LUFS, resolved.targetLufs) &&
          isOnLoudnessTargetStep(resolved.targetLufs)
        );
      }),
      { numRuns: 200 },
    );
  });
});
