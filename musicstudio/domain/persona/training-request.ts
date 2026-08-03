/**
 * What a persona training request must carry (Requirements 15.1, 15.2, 15.8).
 *
 * Requirement 15.2 is the only numeric rule — 8 reference songs, or the request is refused
 * *with the minimum stated back*, so a client can show the number rather than the word
 * "too few". Everything else here is the consequence of two other criteria:
 *
 * - **15.8** requires a stored consent record confirming the uploader holds rights to the
 *   reference songs. It is a field of the request rather than a later step, because a
 *   training run that started before the confirmation existed would be a run whose consent
 *   record is a formality written afterwards.
 * - **15.1** says 참조 곡, and a song the requester does not own is not theirs to train on.
 *   Ownership is checked against the store by the service; what this module fixes is that
 *   the *count* is counted over distinct assets, so eight copies of one song is one song.
 */

export const PERSONA_REFERENCE_MIN = 8;

/**
 * A ceiling, which no criterion states.
 *
 * A product decision recorded here rather than left to whatever the engine tolerates: the
 * reference set is uploaded, stored and preprocessed per persona, and an unbounded set is
 * an unbounded cost with no stated benefit. 100 is far past the 8 the requirement asks for
 * and short of a library dump.
 */
export const PERSONA_REFERENCE_MAX = 100;

export const PERSONA_NAME_MIN_LENGTH = 1;
export const PERSONA_NAME_MAX_LENGTH = 60;

export type PersonaRequestViolationCode =
  | 'reference_count_below_minimum'
  | 'reference_count_above_maximum'
  | 'name_length_invalid'
  | 'rights_consent_missing';

export interface PersonaRequestViolation {
  readonly field: string;
  readonly violation: PersonaRequestViolationCode;
  /** Requirement 15.2: the minimum, stated back to the caller. */
  readonly expected?: string;
  readonly actual?: string;
}

/** Requirement 15.8's consent record, as submitted. */
export interface PersonaRightsConsent {
  /** The requester confirms they hold the rights to every reference song. */
  readonly rightsConfirmed: boolean;
  readonly confirmedAtMs: number;
}

export interface PersonaTrainingRequestInput {
  readonly ownerId: string;
  readonly name: string;
  readonly referenceAssetIds: readonly string[];
  readonly consent?: PersonaRightsConsent;
}

/** Distinct references, first-seen order. Eight copies of one song is one song. */
export function distinctReferences(assetIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const assetId of assetIds) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    result.push(assetId);
  }
  return result;
}

export function personaRequestViolations(
  input: PersonaTrainingRequestInput,
): PersonaRequestViolation[] {
  const violations: PersonaRequestViolation[] = [];
  const references = distinctReferences(input.referenceAssetIds);

  if (references.length < PERSONA_REFERENCE_MIN) {
    violations.push({
      field: 'referenceAssetIds',
      violation: 'reference_count_below_minimum',
      expected: String(PERSONA_REFERENCE_MIN),
      actual: String(references.length),
    });
  } else if (references.length > PERSONA_REFERENCE_MAX) {
    violations.push({
      field: 'referenceAssetIds',
      violation: 'reference_count_above_maximum',
      expected: String(PERSONA_REFERENCE_MAX),
      actual: String(references.length),
    });
  }

  const name = input.name.trim();
  if (name.length < PERSONA_NAME_MIN_LENGTH || name.length > PERSONA_NAME_MAX_LENGTH) {
    violations.push({
      field: 'name',
      violation: 'name_length_invalid',
      expected: `${String(PERSONA_NAME_MIN_LENGTH)}..${String(PERSONA_NAME_MAX_LENGTH)}`,
      actual: String(name.length),
    });
  }

  // Requirement 15.8. An absent record and a record saying "no" are the same refusal: both
  // mean nothing on file says the requester may use these songs.
  if (input.consent === undefined || !input.consent.rightsConfirmed) {
    violations.push({ field: 'consent', violation: 'rights_consent_missing' });
  }

  return violations;
}

export function isValidPersonaRequest(input: PersonaTrainingRequestInput): boolean {
  return personaRequestViolations(input).length === 0;
}
