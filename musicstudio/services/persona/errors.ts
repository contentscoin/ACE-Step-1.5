/**
 * The Persona_Service's rejections.
 *
 * Requirement 15.2 and Requirement 15.6 each fix part of a response, and both are honoured
 * literally:
 *
 * - **15.2** — "요청을 거부하고 **최소 필요 개수를 반환**한다". The number is in the payload,
 *   not in the message, so a client shows "8 required, 5 given" without parsing English.
 * - **15.6** — "HTTP **403**". Stated outright, unlike Requirement 12.6's private asset. A
 *   persona id is not a guessable URL a stranger stumbles onto; it is named by an
 *   authenticated caller in their own generation request, so 403 leaks nothing they could
 *   not already infer.
 */

import { PERSONA_REFERENCE_MIN, type PersonaRequestViolation } from '../../domain/persona/training-request';
import type { PersonaStatus } from '../../domain/persona/persona';
import { GenerationError } from '../generation/errors';

/** Requirements 15.2, 15.8. Carries every violation, and 15.2's minimum unconditionally. */
export function personaRequestInvalid(
  violations: readonly PersonaRequestViolation[],
): GenerationError {
  return new GenerationError(400, 'persona_request_invalid', 'The persona request is not valid.', {
    violations,
    minimumReferenceCount: PERSONA_REFERENCE_MIN,
  });
}

export function personaNotFound(personaId: string): GenerationError {
  return new GenerationError(404, 'persona_not_found', 'No such persona.', { personaId });
}

/** Requirement 15.6, which names the status code. */
export function personaForbidden(personaId: string): GenerationError {
  return new GenerationError(403, 'persona_forbidden', 'This persona belongs to another account.', {
    personaId,
  });
}

/** Requirement 15.5: an adapter can only be applied once there is one. */
export function personaNotReady(personaId: string, status: PersonaStatus): GenerationError {
  return new GenerationError(409, 'persona_not_ready', 'This persona has not finished training.', {
    personaId,
    status,
  });
}

/** Requirement 15.1: a reference song that is missing, or not the requester's. */
export function personaReferenceInvalid(assetIds: readonly string[]): GenerationError {
  return new GenerationError(
    400,
    'persona_reference_invalid',
    'Every reference song must exist and belong to the requester.',
    { assetIds },
  );
}
