/**
 * Requirement 24.1's request, Requirement 24.20's rejection, and 24.4/24.5's length rule.
 *
 * Three things, one module, because all three are pure predicates over a pack request or a
 * single cue and splitting them would leave three files of twenty lines that are always
 * read together.
 *
 * ### The request (24.1, 24.20)
 *
 * 24.1 fixes a pack name of 1–60 characters and a sonic-character description of 1–200.
 * 24.20 says what happens when either is outside its range: reject, and return **the
 * violated field name, the input length and the permitted range** — three facts, so the
 * violation is data rather than a message. `domain/song/violation.ts`'s vocabulary is reused
 * rather than a parallel one invented, which is what lets `services/sound/sound-pack-errors.ts`
 * render it through the same `describeViolation` every other request rejection uses.
 *
 * 24.20 also requires that existing Sound_Pack assets be left unchanged, which is why
 * validation happens *before* anything is submitted or charged: there is nothing to leave
 * unchanged if nothing has started. Stated here because the ordering is the whole content of
 * that half of the clause, and it is invisible in the service unless someone says so.
 *
 * ### The lengths (24.4, 24.5)
 *
 * The range depends on exactly one thing — whether the cue is a loop — and that is read from
 * the taxonomy rather than from the caller (see `isLoopCue`), so a caller cannot judge a
 * one-shot against the loop range by passing the wrong flag. Both ranges are inclusive.
 *
 * A cue's length is measured from its audio, so the verdict carries the measured
 * milliseconds: Requirement 24.17 re-validates a regenerated cue against the same rule, and
 * a report saying only "too long" would not say by how much.
 */

import { lengthViolation, type SongFieldViolation } from '../song/violation';

import {
  PACK_DESCRIPTION_MAX_LENGTH,
  PACK_DESCRIPTION_MIN_LENGTH,
  PACK_NAME_MAX_LENGTH,
  PACK_NAME_MIN_LENGTH,
  cueLengthRangeSeconds,
  isPackDescription,
  isPackName,
} from './bounds';
import { isLoopCue } from './taxonomy';

/** Requirement 24.1's two fields, as the user sends them. */
export interface SoundPackRequest {
  readonly name: string;
  /** 24.1's 음향 성격 설명. */
  readonly description: string;
}

/** A fully determined request. Requirement 24 gives neither field a default. */
export interface SoundPackParameters {
  readonly name: string;
  readonly description: string;
}

/**
 * Requirement 24.20's "입력 길이", per violated field.
 *
 * A companion to the violation rather than a field on it, because `SongFieldViolation` is
 * shared with Requirements 3.5/4.6 and carries `received` (the value) rather than its
 * length. A client could compute the length from `received`, but 24.20 asks for it
 * explicitly, and a string that was truncated for logging would give the wrong answer.
 */
export interface SoundPackFieldLength {
  readonly field: string;
  readonly actualLength: number;
}

export type SoundPackValidation =
  | { readonly kind: 'valid'; readonly parameters: SoundPackParameters }
  | {
      readonly kind: 'invalid';
      readonly violations: readonly SongFieldViolation[];
      /** Requirement 24.20's input lengths, one per violated field, in field order. */
      readonly lengths: readonly SoundPackFieldLength[];
    };

/** Requirements 24.1, 24.20. */
export function validateSoundPackRequest(request: SoundPackRequest): SoundPackValidation {
  const violations: SongFieldViolation[] = [];
  const lengths: SoundPackFieldLength[] = [];

  if (!isPackName(request.name)) {
    violations.push(
      lengthViolation('name', request.name, PACK_NAME_MIN_LENGTH, PACK_NAME_MAX_LENGTH),
    );
    lengths.push({ field: 'name', actualLength: lengthOf(request.name) });
  }

  if (!isPackDescription(request.description)) {
    violations.push(
      lengthViolation(
        'description',
        request.description,
        PACK_DESCRIPTION_MIN_LENGTH,
        PACK_DESCRIPTION_MAX_LENGTH,
      ),
    );
    lengths.push({ field: 'description', actualLength: lengthOf(request.description) });
  }

  if (violations.length > 0) return { kind: 'invalid', violations, lengths };

  return {
    kind: 'valid',
    parameters: { name: request.name, description: request.description },
  };
}

/**
 * `undefined` and a non-string both report length 0.
 *
 * 24.20 asks for "입력 길이", and a missing field has an input length of nothing. Reporting
 * `undefined` would make the response's type wider for a case the range already covers: 0 is
 * outside 1–60, so the violation is correct and complete.
 */
function lengthOf(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

/** Requirements 24.4, 24.5: where a cue's length sits relative to its range. */
export const CUE_LENGTH_PLACEMENTS = ['within', 'too_short', 'too_long'] as const;

export type CueLengthPlacement = (typeof CUE_LENGTH_PLACEMENTS)[number];

export interface CueLengthVerdict {
  readonly cueName: string;
  readonly loop: boolean;
  readonly durationMs: number;
  readonly placement: CueLengthPlacement;
  readonly satisfied: boolean;
  /** The range applied, in milliseconds, so a failure says what was expected. */
  readonly minMs: number;
  readonly maxMs: number;
}

/**
 * Requirement 24.4 for a one-shot, Requirement 24.5 for a loop.
 *
 * The kind is taken from the taxonomy by cue name, not from a parameter, so the two ranges
 * cannot be mixed up. A name the taxonomy does not know is judged as a one-shot — 72 of the
 * 78 are — but such a name cannot reach here from a complete pack, because Requirement 24.2's
 * name-set check runs first.
 */
export function judgeCueLength(cueName: string, durationMs: number): CueLengthVerdict {
  const loop = isLoopCue(cueName);
  const range = cueLengthRangeSeconds(loop);
  const minMs = range.min * 1000;
  const maxMs = range.max * 1000;
  const placement: CueLengthPlacement = Number.isNaN(durationMs)
    ? 'too_short'
    : durationMs < minMs
      ? 'too_short'
      : durationMs > maxMs
        ? 'too_long'
        : 'within';

  return {
    cueName,
    loop,
    durationMs,
    placement,
    satisfied: placement === 'within',
    minMs,
    maxMs,
  };
}

/** The cues whose length is outside their range, in cue order. */
export function lengthOffenders(
  verdicts: readonly CueLengthVerdict[],
): readonly CueLengthVerdict[] {
  return verdicts.filter((verdict) => !verdict.satisfied);
}
