/**
 * How a refused edit reports itself (Requirements 7.4, 7.9, 7.11).
 *
 * All three criteria ask for the same two things: which constraint was violated,
 * and what the allowed value is. So the allowance is data rather than prose, and a
 * message is rendered from it.
 *
 * The allowance kinds are Requirement 7's own, not Requirement 3/4's — `bytes` for
 * the 50 MB ceiling, `ordering` for 7.4's start-before-end rule, `models` for 7.9's
 * "here are the models that do support it". `domain/song/violation.ts` deliberately
 * stays untouched: sharing one allowance type would force it to carry three kinds
 * no song field can produce.
 */

export type EditFieldAllowance =
  | { readonly kind: 'range'; readonly min: number; readonly max: number; readonly integer: boolean }
  | { readonly kind: 'enum'; readonly values: readonly (string | number)[] }
  /** Requirement 7.11's size constraint, stated in bytes so it needs no unit parse. */
  | { readonly kind: 'bytes'; readonly maxBytes: number }
  /** Requirement 7.4: the start must come strictly before the end. */
  | { readonly kind: 'ordering'; readonly before: string; readonly after: string }
  /** Requirement 7.9: the models that do support the requested Edit_Task. */
  | { readonly kind: 'models'; readonly supportedBy: readonly string[] }
  | { readonly kind: 'required' };

export interface EditFieldViolation {
  /** Field name as the caller spelled it, so a client can highlight its input. */
  readonly field: string;
  readonly received: unknown;
  readonly allowed: EditFieldAllowance;
}

export function editRangeViolation(
  field: string,
  received: unknown,
  min: number,
  max: number,
  integer = false,
): EditFieldViolation {
  return { field, received, allowed: { kind: 'range', min, max, integer } };
}

export function editEnumViolation(
  field: string,
  received: unknown,
  values: readonly (string | number)[],
): EditFieldViolation {
  return { field, received, allowed: { kind: 'enum', values } };
}

export function editSizeViolation(
  field: string,
  received: unknown,
  maxBytes: number,
): EditFieldViolation {
  return { field, received, allowed: { kind: 'bytes', maxBytes } };
}

export function editOrderingViolation(
  field: string,
  received: unknown,
  before: string,
  after: string,
): EditFieldViolation {
  return { field, received, allowed: { kind: 'ordering', before, after } };
}

export function editUnsupportedByModelViolation(
  field: string,
  received: unknown,
  supportedBy: readonly string[],
): EditFieldViolation {
  return { field, received, allowed: { kind: 'models', supportedBy } };
}

export function editRequiredViolation(field: string): EditFieldViolation {
  return { field, received: undefined, allowed: { kind: 'required' } };
}

/** One line per violation, naming the constraint and its allowed value. */
export function describeEditViolation(violation: EditFieldViolation): string {
  const { allowed } = violation;
  switch (allowed.kind) {
    case 'range':
      return `${violation.field} must be ${allowed.integer ? 'an integer' : 'a number'} between ${String(allowed.min)} and ${String(allowed.max)}`;
    case 'enum':
      return `${violation.field} must be one of: ${allowed.values.join(', ')}`;
    case 'bytes':
      return `${violation.field} must be at most ${String(allowed.maxBytes)} bytes`;
    case 'ordering':
      return `${violation.field} requires ${allowed.before} to be strictly less than ${allowed.after}`;
    case 'models':
      return allowed.supportedBy.length === 0
        ? `${violation.field} is not supported by any available model`
        : `${violation.field} is supported by: ${allowed.supportedBy.join(', ')}`;
    case 'required':
      return `${violation.field} is required`;
  }
}
