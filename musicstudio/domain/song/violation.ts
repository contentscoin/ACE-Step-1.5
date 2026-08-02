/**
 * How a rejected song field reports itself (Requirements 3.5, 3.8, 4.6).
 *
 * All three criteria demand the same two things back: which field was wrong and
 * what would have been accepted. So the allowance is data — a range, a length
 * window or an explicit member list — rather than prose, and the message a client
 * sees is rendered from it. Requirement 3.8 in particular asks for the *whole*
 * supported language list, which an `enum` allowance carries verbatim.
 */

export type SongFieldAllowance =
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly integer: boolean }
  | { readonly kind: 'length'; readonly minLength: number; readonly maxLength: number }
  | { readonly kind: 'enum'; readonly values: readonly (string | number)[] };

export interface SongFieldViolation {
  /** Field name as the caller spelled it, so the client can highlight its input. */
  readonly field: string;
  readonly received: unknown;
  readonly allowed: SongFieldAllowance;
}

export function rangeViolation(
  field: string,
  received: unknown,
  min: number,
  max: number,
  integer = true,
): SongFieldViolation {
  return { field, received, allowed: { kind: 'range', min, max, integer } };
}

export function lengthViolation(
  field: string,
  received: unknown,
  minLength: number,
  maxLength: number,
): SongFieldViolation {
  return { field, received, allowed: { kind: 'length', minLength, maxLength } };
}

export function enumViolation(
  field: string,
  received: unknown,
  values: readonly (string | number)[],
): SongFieldViolation {
  return { field, received, allowed: { kind: 'enum', values } };
}

/** One line per violation, naming the field and the allowance (3.5, 3.8, 4.6). */
export function describeViolation(violation: SongFieldViolation): string {
  const { allowed } = violation;
  switch (allowed.kind) {
    case 'range':
      return `${violation.field} must be ${allowed.integer ? 'an integer' : 'a number'} between ${String(allowed.min)} and ${String(allowed.max)}`;
    case 'length':
      return `${violation.field} must be between ${String(allowed.minLength)} and ${String(allowed.maxLength)} characters`;
    case 'enum':
      return `${violation.field} must be one of ${allowed.values.length} accepted values`;
  }
}
