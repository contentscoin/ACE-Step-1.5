import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_ALTERNATIVE_ENGINES,
  ruleOnCommercialUse,
  type CommercialGateFacts,
} from '../../domain/licensing/commercial-gate';
import { USAGE_PURPOSES, toUsagePurpose } from '../../domain/licensing/usage-purpose';

/**
 * Requirement 33.22 — the fixed policy, checked as a property rather than as an example.
 *
 * **Validates: Requirements 33.11, 33.19, 33.22**
 *
 * > THE MusicStudio SHALL 사용 목적 `commercial` 요청에 대한 상업적 사용 허용 여부 검사를 계정
 * > 요금제, 계정 등급, 운영자 설정, API 키 권한 중 어느 것으로도 우회할 수 없는 고정 정책으로
 * > 적용한다(불변식)
 *
 * ### Why a property test and not "try a privileged caller and check it is refused"
 *
 * An example test with an admin account proves that *one* caller was refused. The clause is an
 * invariant over every account attribute there could ever be — including the ones a later phase
 * adds. So the property asserted here is a **functional dependency**: the ruling is determined by
 * the usage purpose and the asset's stored flag, and by nothing else.
 *
 * That is checked two ways, and both are needed:
 *
 * 1. *Behaviourally* — over generated facts, the ruling equals the two-input formula. If someone
 *    later added a `callerIsOperator` field and read it, this fails.
 * 2. *Structurally* — the fact type's own keys are enumerated and none of them names an account
 *    attribute. This catches the field being **added** before anything reads it, which is the
 *    moment the bypass becomes possible rather than the moment it is used.
 *
 * The second is the one that would be easy to leave out and is the one that fails first.
 */

const arbFacts: fc.Arbitrary<CommercialGateFacts> = fc.record({
  usagePurpose: fc.constantFrom(...USAGE_PURPOSES),
  assetCommercialUseAllowed: fc.boolean(),
  decidingLicenseIds: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 4 }),
  alternativeEngineIds: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 30 }),
});

/** Every account attribute Requirement 33.22 names, plus the shapes they usually arrive as. */
const BYPASS_SHAPED_KEYS = [
  'plan',
  'planid',
  'tier',
  'accounttier',
  'role',
  'roles',
  'apikey',
  'apikeyid',
  'apikeyscopes',
  'scopes',
  'permissions',
  'operatoroverride',
  'override',
  'isadmin',
  'isoperator',
  'featureflag',
  'entitlement',
  'entitled',
];

describe('Requirement 33.22 — the ruling depends on exactly two facts', () => {
  it('equals the two-input formula over any facts', () => {
    fc.assert(
      fc.property(arbFacts, (facts) => {
        const ruling = ruleOnCommercialUse(facts);
        const expected = facts.usagePurpose !== 'commercial' || facts.assetCommercialUseAllowed;
        expect(ruling.allowed).toBe(expected);
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it('is unchanged by anything else in the request object', () => {
    fc.assert(
      fc.property(
        arbFacts,
        // Whatever a caller might smuggle alongside: a plan, a role, an operator flag.
        fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.oneof(fc.boolean(), fc.string())),
        (facts, extra) => {
          const withExtra = { ...extra, ...facts } as CommercialGateFacts;
          expect(ruleOnCommercialUse(withExtra).allowed).toBe(ruleOnCommercialUse(facts).allowed);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('has no fact named after an account attribute', () => {
    // The structural half. `CommercialGateFacts` is an interface and has no runtime form, so the
    // keys of a constructed value stand in for it — a new field would have to be added here to
    // typecheck, and then this assertion is what fails.
    const facts: CommercialGateFacts = {
      usagePurpose: 'commercial',
      assetCommercialUseAllowed: false,
      decidingLicenseIds: [],
      alternativeEngineIds: [],
    };

    for (const key of Object.keys(facts)) {
      const normalised = key.toLowerCase();
      for (const banned of BYPASS_SHAPED_KEYS) {
        expect(normalised, `${key} looks like an account attribute`).not.toContain(banned);
      }
    }
    // And exactly the four the clause allows, so a fifth has to be argued for here.
    expect(Object.keys(facts).sort()).toEqual([
      'alternativeEngineIds',
      'assetCommercialUseAllowed',
      'decidingLicenseIds',
      'usagePurpose',
    ]);
  });

  it('never returns more than ten alternatives (Req 33.11)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 0, maxLength: 40 }),
        (engineIds) => {
          const ruling = ruleOnCommercialUse({
            usagePurpose: 'commercial',
            assetCommercialUseAllowed: false,
            decidingLicenseIds: ['cc-by-nc-4.0'],
            alternativeEngineIds: engineIds,
          });
          expect(ruling.allowed).toBe(false);
          if (!ruling.allowed) {
            expect(ruling.alternativeEngineIds.length).toBeLessThanOrEqual(
              MAX_ALTERNATIVE_ENGINES,
            );
            // A truncation, not a sample: the first ten of what the caller ordered.
            expect(ruling.alternativeEngineIds).toEqual(
              engineIds.slice(0, MAX_ALTERNATIVE_ENGINES),
            );
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Requirement 33.19 — the purpose is always exactly one of two', () => {
  it('maps anything unrecognised to non_commercial', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const purpose = toUsagePurpose(value);
        expect(USAGE_PURPOSES).toContain(purpose);
        // The asymmetry that matters: only the exact string opens the gate.
        if (purpose === 'commercial') expect(value).toBe('commercial');
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('does not accept a case variant or a padded value', () => {
    for (const near of ['Commercial', 'COMMERCIAL', ' commercial', 'commercial ', 'comercial']) {
      expect(toUsagePurpose(near)).toBe('non_commercial');
    }
  });
});
