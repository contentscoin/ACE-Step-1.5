/**
 * `Effect_Chain` — the ordered list of effect items (Requirements 29.9–29.13).
 *
 * A chain is an **array**, not a set or a map, because Requirements 29.11 and 29.12
 * both turn on order: it is stored as an order-preserving JSON array and applied in
 * array order. That is not a serialisation detail — a compressor before a gain is a
 * different sound from a gain before a compressor — so the type is an array and the
 * printer never sorts.
 *
 * Duplicates are permitted. Two `gain` items in one chain is a legitimate request
 * (stage gain either side of a filter), and nothing in Requirement 29 excludes it, so
 * the item list is not keyed by kind.
 *
 * ### Validation reports every fault, in index order
 *
 * `chainViolations` returns the complete list rather than the first, matching the
 * house style of `domain/sfx/validation.ts`: a chain of sixteen items can be wrong in
 * several places and a caller told about one at a time makes several round trips to
 * learn what it could have sent. Requirement 29.33 constrains the *parser* to report
 * the first violation's index, which is a narrower promise; `chain-parser.ts` takes the
 * first element of this list to keep that promise, so the two never disagree about
 * *which* fault is first.
 */

import {
  CHAIN_ITEM_COUNT_MAX,
  CHAIN_ITEM_COUNT_MIN,
  EFFECT_REGISTRY,
  chainExtendsTail,
  describeRange,
  isEffectKind,
  isParameterInRange,
  parameterNames,
  parameterRange,
  type EffectKind,
} from './registry';

/** One position in a chain: a kind plus a complete parameter map. */
export interface EffectItem {
  readonly kind: EffectKind;
  readonly parameters: Readonly<Record<string, number>>;
}

export interface EffectChain {
  readonly items: readonly EffectItem[];
}

/**
 * A rejected chain, in the shape Requirements 29.9 and 29.10 ask for.
 *
 * `index` locates the item; `name` is the offending kind or parameter name that 29.9
 * requires be *returned*; `permittedRange` carries what 29.10 requires alongside it.
 * A single violation type rather than one per clause, because a caller rendering an
 * error message branches on `violation` and would otherwise need to know which clause
 * produced its input.
 */
export interface ChainViolation {
  readonly index: number;
  readonly violation:
    | 'chain_not_array'
    | 'chain_too_few_items'
    | 'chain_too_many_items'
    | 'item_not_object'
    | 'unknown_effect_kind'
    | 'unknown_parameter_name'
    | 'missing_parameter'
    | 'parameter_not_finite_number'
    | 'parameter_out_of_range';
  readonly name?: string;
  readonly actual?: string;
  readonly permittedRange?: string;
}

function violation(
  index: number,
  code: ChainViolation['violation'],
  rest: Omit<ChainViolation, 'index' | 'violation'> = {},
): ChainViolation {
  return { index, violation: code, ...rest };
}

/**
 * Every way `value` fails to be a valid chain (Requirements 29.9, 29.10, 29.13).
 *
 * Takes `unknown` rather than `EffectChain` on purpose. The chain arrives from a JSON
 * document (29.33) and from a stored `jsonb` column, so the type system has not
 * established anything about it; a function typed to accept only valid input could not
 * be the thing that decides validity.
 *
 * The count check runs first and, when it fails, still reports the per-item faults
 * below it. A caller who sent seventeen items with a typo in item three should learn
 * both, not be sent back for a second attempt.
 */
export function chainViolations(value: unknown): ChainViolation[] {
  if (!Array.isArray(value)) return [violation(0, 'chain_not_array', { actual: typeof value })];

  const violations: ChainViolation[] = [];

  if (value.length < CHAIN_ITEM_COUNT_MIN) {
    violations.push(
      violation(0, 'chain_too_few_items', {
        actual: String(value.length),
        permittedRange: `${String(CHAIN_ITEM_COUNT_MIN)}..${String(CHAIN_ITEM_COUNT_MAX)}`,
      }),
    );
  }
  if (value.length > CHAIN_ITEM_COUNT_MAX) {
    violations.push(
      violation(CHAIN_ITEM_COUNT_MAX, 'chain_too_many_items', {
        actual: String(value.length),
        permittedRange: `${String(CHAIN_ITEM_COUNT_MIN)}..${String(CHAIN_ITEM_COUNT_MAX)}`,
      }),
    );
  }

  for (const [index, rawItem] of value.entries()) {
    violations.push(...itemViolations(index, rawItem));
  }

  return violations;
}

function itemViolations(index: number, rawItem: unknown): ChainViolation[] {
  if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
    return [violation(index, 'item_not_object', { actual: describeType(rawItem) })];
  }

  const item = rawItem as { kind?: unknown; parameters?: unknown };

  if (!isEffectKind(item.kind)) {
    // Requirement 29.9: the unregistered *name* is what comes back.
    return [
      violation(index, 'unknown_effect_kind', {
        ...(typeof item.kind === 'string' ? { name: item.kind } : {}),
        actual: describeType(item.kind),
        permittedRange: Object.keys(EFFECT_REGISTRY).join('|'),
      }),
    ];
  }

  const kind: EffectKind = item.kind;
  const parameters = item.parameters;

  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    return [
      violation(index, 'item_not_object', { name: 'parameters', actual: describeType(parameters) }),
    ];
  }

  const supplied = parameters as Record<string, unknown>;
  const violations: ChainViolation[] = [];

  // Requirement 29.9's second half: a name the kind does not define is refused, and
  // the name is returned. Checked before the range pass so that a misspelling is
  // reported as a misspelling rather than as a missing parameter.
  for (const name of Object.keys(supplied)) {
    if (parameterRange(kind, name) === undefined) {
      violations.push(
        violation(index, 'unknown_parameter_name', {
          name,
          permittedRange: parameterNames(kind).join('|'),
        }),
      );
    }
  }

  for (const name of parameterNames(kind)) {
    if (!Object.hasOwn(supplied, name)) {
      // Not a clause of its own, but implied by 29.12: an effect is applied with a
      // complete parameter set, and silently defaulting a missing one would make the
      // stored chain an incomplete record of what was heard.
      violations.push(violation(index, 'missing_parameter', { name }));
      continue;
    }

    const supp: unknown = supplied[name];
    if (typeof supp !== 'number' || !Number.isFinite(supp)) {
      violations.push(
        violation(index, 'parameter_not_finite_number', { name, actual: describeType(supp) }),
      );
      continue;
    }

    if (!isParameterInRange(kind, name, supp)) {
      const range = parameterRange(kind, name);
      violations.push(
        violation(index, 'parameter_out_of_range', {
          name,
          actual: String(supp),
          // Requirement 29.10: the permitted range travels with the rejection.
          ...(range === undefined ? {} : { permittedRange: describeRange(range) }),
        }),
      );
    }
  }

  return violations;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return typeof value;
}

export function isValidChain(value: unknown): boolean {
  return chainViolations(value).length === 0;
}

/**
 * Narrow an already-validated array to `EffectChain`.
 *
 * Throws rather than returning a result, because reaching it with an invalid value is
 * a programming error: the callers are the parser and the service, both of which have
 * just run `chainViolations`.
 */
export function toChain(value: unknown): EffectChain {
  const violations = chainViolations(value);
  if (violations.length > 0) {
    throw new Error(`not a valid Effect_Chain: ${violations[0]?.violation ?? 'unknown'}`);
  }
  return { items: (value as EffectItem[]).map(normaliseItem) };
}

/**
 * Rebuild one item with its parameters in **registry order**.
 *
 * This is what makes Requirement 29.27's byte-identical reprint achievable. Object key
 * order survives `JSON.stringify`, so a chain parsed from a document that listed
 * `mix` before `rate_hz` would otherwise reprint in that order, and a second parse of
 * a reordered document would print differently again. Fixing the order at the moment a
 * chain enters the domain means the printer needs no sorting logic and the two
 * documents of 29.27 are equal for a structural reason rather than a hopeful one.
 */
function normaliseItem(item: EffectItem): EffectItem {
  const ordered: Record<string, number> = {};
  for (const name of parameterNames(item.kind)) {
    ordered[name] = item.parameters[name] as number;
  }
  return { kind: item.kind, parameters: ordered };
}

export function chainKinds(chain: EffectChain): readonly EffectKind[] {
  return chain.items.map((item) => item.kind);
}

/** Requirements 29.30, 29.32: whether this chain may lengthen the audio. */
export function chainMayExtendTail(chain: EffectChain): boolean {
  return chainExtendsTail(chainKinds(chain));
}
