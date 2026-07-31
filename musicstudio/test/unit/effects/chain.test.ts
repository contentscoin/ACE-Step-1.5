import { describe, expect, it } from 'vitest';

import {
  chainMayExtendTail,
  chainViolations,
  isValidChain,
  toChain,
} from '../../../domain/effects/chain';
import {
  parseChainDocument,
  parseChainValue,
} from '../../../domain/effects/chain-parser';
import { chainToDocument, printChain } from '../../../domain/effects/chain-printer';
import { effectChainsEquivalent } from '../../../domain/effects/equivalence';

/**
 * `Effect_Chain` validation, parsing, printing and the equivalence relation.
 *
 * **Validates: Requirements 29.9, 29.10, 29.11, 29.12, 29.13, 29.24, 29.25, 29.26, 29.27,
 * 29.30, 29.32, 29.33**
 *
 * The round-trip and idempotence *properties* (29.26, 29.27) are Properties 8 and 9 and live
 * in `test/property/effect-chain-round-trip.test.ts`. What is here is the example-based half:
 * the specific refusals each clause names, and the edge cases a generator is unlikely to hit
 * on its own (a `NaN` parameter, a chain of exactly 16, a `-0`).
 */

const GAIN = { kind: 'gain', parameters: { gain_db: -3 } };
const REVERB = {
  kind: 'reverb',
  parameters: { room_size: 0.5, damping: 0.5, wet_level: 0.3, dry_level: 0.7, width: 1 },
};

describe('Requirement 29.13 — item count', () => {
  it('accepts a single item', () => {
    expect(isValidChain([GAIN])).toBe(true);
  });

  it('accepts exactly sixteen items', () => {
    expect(isValidChain(Array.from({ length: 16 }, () => GAIN))).toBe(true);
  });

  it('refuses an empty chain and reports the permitted range', () => {
    const [first] = chainViolations([]);
    expect(first?.violation).toBe('chain_too_few_items');
    expect(first?.permittedRange).toBe('1..16');
  });

  it('refuses seventeen items and reports the count and the range', () => {
    const violations = chainViolations(Array.from({ length: 17 }, () => GAIN));
    const tooMany = violations.find((v) => v.violation === 'chain_too_many_items');
    expect(tooMany?.actual).toBe('17');
    expect(tooMany?.permittedRange).toBe('1..16');
  });

  it('refuses a value that is not an array at all', () => {
    expect(chainViolations({ kind: 'gain' })[0]?.violation).toBe('chain_not_array');
    expect(chainViolations(null)[0]?.violation).toBe('chain_not_array');
    expect(chainViolations('[]')[0]?.violation).toBe('chain_not_array');
  });
});

describe('Requirement 29.9 — unregistered names come back', () => {
  it('refuses an unknown effect kind and returns the name', () => {
    const [first] = chainViolations([{ kind: 'bitcrusher', parameters: {} }]);
    expect(first?.violation).toBe('unknown_effect_kind');
    expect(first?.name).toBe('bitcrusher');
    // The permitted vocabulary travels too, so a client can render a picker from the error.
    expect(first?.permittedRange).toContain('pitch_shift');
  });

  it('refuses an unknown parameter name and returns the name', () => {
    const violations = chainViolations([
      { kind: 'gain', parameters: { gain_db: 0, makeup: 1 } },
    ]);
    const unknown = violations.find((v) => v.violation === 'unknown_parameter_name');
    expect(unknown?.name).toBe('makeup');
    expect(unknown?.index).toBe(0);
  });

  it('reports the index of the offending item, not just the fault', () => {
    const violations = chainViolations([GAIN, GAIN, { kind: 'nope', parameters: {} }]);
    expect(violations[0]?.index).toBe(2);
  });

  it('treats a misspelling as an unknown name rather than a missing one', () => {
    // `gain_dB` is not `gain_db`. Reporting only "missing gain_db" would send the caller
    // looking for an absent field instead of at the typo in front of them.
    const violations = chainViolations([{ kind: 'gain', parameters: { gain_dB: 0 } }]);
    expect(violations.map((v) => v.violation)).toContain('unknown_parameter_name');
    expect(violations.map((v) => v.violation)).toContain('missing_parameter');
  });
});

describe('Requirement 29.10 — out-of-range values come back with the range', () => {
  it('refuses a gain above the maximum', () => {
    const violations = chainViolations([{ kind: 'gain', parameters: { gain_db: 41 } }]);
    const fault = violations.find((v) => v.violation === 'parameter_out_of_range');
    expect(fault?.name).toBe('gain_db');
    expect(fault?.actual).toBe('41');
    expect(fault?.permittedRange).toBe('-40..40');
  });

  it('accepts both endpoints, since the ranges are inclusive', () => {
    expect(isValidChain([{ kind: 'gain', parameters: { gain_db: -40 } }])).toBe(true);
    expect(isValidChain([{ kind: 'gain', parameters: { gain_db: 40 } }])).toBe(true);
    expect(isValidChain([{ kind: 'pitch_shift', parameters: { semitones: -12 } }])).toBe(true);
    expect(isValidChain([{ kind: 'pitch_shift', parameters: { semitones: 12 } }])).toBe(true);
  });

  it('refuses NaN and the infinities rather than letting them through a range test', () => {
    // A bare `min <= v <= max` accepts NaN, because NaN fails every comparison. A NaN
    // reaching pedalboard poisons every subsequent sample, so this is not pedantry.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const violations = chainViolations([{ kind: 'gain', parameters: { gain_db: value } }]);
      expect(violations[0]?.violation).toBe('parameter_not_finite_number');
    }
  });

  it('refuses a string that looks like a number', () => {
    const violations = chainViolations([{ kind: 'gain', parameters: { gain_db: '0' } }]);
    expect(violations[0]?.violation).toBe('parameter_not_finite_number');
  });

  it('accepts -0, which is a legitimate zero', () => {
    expect(isValidChain([{ kind: 'gain', parameters: { gain_db: -0 } }])).toBe(true);
  });

  it('refuses a missing parameter rather than defaulting it', () => {
    // Requirement 29.12 applies an effect with a complete parameter set; silently
    // defaulting would make the stored chain an incomplete record of what was heard.
    const violations = chainViolations([{ kind: 'delay', parameters: { delay_seconds: 0.5 } }]);
    const missing = violations.filter((v) => v.violation === 'missing_parameter');
    expect(missing.map((v) => v.name).sort()).toEqual(['feedback', 'mix']);
  });

  it('reports every fault in a chain, not only the first', () => {
    const violations = chainViolations([
      { kind: 'gain', parameters: { gain_db: 99 } },
      { kind: 'pitch_shift', parameters: { semitones: 99 } },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.index)).toEqual([0, 1]);
  });

  it('applies the filters\u2019 different ranges to the same parameter name', () => {
    // Requirement 29.7: 20..8000 for the high-pass, 200..20000 for the low-pass.
    expect(isValidChain([{ kind: 'highpass', parameters: { cutoff_frequency_hz: 20 } }])).toBe(
      true,
    );
    expect(isValidChain([{ kind: 'lowpass', parameters: { cutoff_frequency_hz: 20 } }])).toBe(
      false,
    );
    expect(isValidChain([{ kind: 'highpass', parameters: { cutoff_frequency_hz: 20000 } }])).toBe(
      false,
    );
    expect(isValidChain([{ kind: 'lowpass', parameters: { cutoff_frequency_hz: 20000 } }])).toBe(
      true,
    );
  });
});

describe('Requirements 29.11, 29.12 — order is preserved and meaningful', () => {
  it('keeps item order through the printer', () => {
    const chain = toChain([GAIN, REVERB]);
    expect(chainToDocument(chain).map((item) => item.kind)).toEqual(['gain', 'reverb']);
  });

  it('does not consider two orderings of the same items equivalent', () => {
    // A compressor before a gain is a different sound from a gain before a compressor,
    // so the equivalence relation must be order-sensitive.
    const forward = toChain([GAIN, REVERB]);
    const backward = toChain([REVERB, GAIN]);
    expect(effectChainsEquivalent(forward, backward).equivalent).toBe(false);
  });

  it('permits the same kind twice, which is a legitimate request', () => {
    expect(isValidChain([GAIN, { kind: 'lowpass', parameters: { cutoff_frequency_hz: 8000 } }, GAIN])).toBe(
      true,
    );
  });
});

describe('canonical parameter order (Requirement 29.27)', () => {
  it('reorders parameters into registry order on entry', () => {
    // This is what makes the byte-identical reprint of 29.27 structural rather than
    // hopeful: two documents listing the same parameters differently converge here.
    const scrambled = toChain([
      {
        kind: 'reverb',
        parameters: { width: 1, dry_level: 0.7, room_size: 0.5, wet_level: 0.3, damping: 0.5 },
      },
    ]);
    expect(Object.keys(scrambled.items[0]?.parameters ?? {})).toEqual([
      'room_size',
      'damping',
      'wet_level',
      'dry_level',
      'width',
    ]);
  });

  it('prints two differently-ordered documents to the same bytes', () => {
    const a = printChain(toChain([{ kind: 'delay', parameters: { mix: 0.3, feedback: 0.2, delay_seconds: 0.1 } }]));
    const b = printChain(toChain([{ kind: 'delay', parameters: { delay_seconds: 0.1, feedback: 0.2, mix: 0.3 } }]));
    expect(a).toBe(b);
  });

  it('emits kind before parameters', () => {
    expect(printChain(toChain([GAIN])).startsWith('[{"kind":')).toBe(true);
  });

  it('does not append a trailing newline', () => {
    // Unlike a .lrc file (Requirement 10.8), a chain is a jsonb value and an embedded
    // payload, so a trailing byte would be a second thing to keep identical.
    expect(printChain(toChain([GAIN])).endsWith('\n')).toBe(false);
  });
});

describe('Requirements 29.25, 29.33 — the Chain_Parser', () => {
  it('parses a printed document back to an equivalent chain', () => {
    const chain = toChain([GAIN, REVERB]);
    const result = parseChainDocument(printChain(chain));
    expect(result.ok).toBe(true);
    if (result.ok) expect(effectChainsEquivalent(chain, result.value).equivalent).toBe(true);
  });

  it('reports exactly one error, as 29.33\u2019s "첫 위반 항목" requires', () => {
    const result = parseChainValue([
      { kind: 'gain', parameters: { gain_db: 99 } },
      { kind: 'gain', parameters: { gain_db: 99 } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.index).toBe(0);
    }
  });

  it('names the first violation, agreeing with chainViolations\u2019 ordering', () => {
    const value = [GAIN, { kind: 'gain', parameters: { gain_db: 99 } }];
    const result = parseChainValue(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.index).toBe(chainViolations(value)[0]?.index);
  });

  it('distinguishes malformed JSON from a valid JSON value of the wrong shape', () => {
    const malformed = parseChainDocument('[{"kind":');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.errors[0]?.violation).toBe('chain_json_malformed');

    const wrongShape = parseChainDocument('{"kind":"gain"}');
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) expect(wrongShape.errors[0]?.violation).toBe('chain_not_array');
  });

  it('carries the offending field name and the permitted range into the ParseError', () => {
    const result = parseChainValue([{ kind: 'gain', parameters: { gain_db: 99 } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('gain_db');
      expect(result.errors[0]?.expected).toBe('-40..40');
    }
  });

  it('produces no chain at all on failure, as 29.33 requires', () => {
    const result = parseChainValue([{ kind: 'gain', parameters: { gain_db: 99 } }]);
    expect('value' in result).toBe(false);
  });

  it('sets no line number, since a JSON fault has no meaningful line', () => {
    const result = parseChainValue([{ kind: 'nope', parameters: {} }]);
    if (!result.ok) expect(result.errors[0]?.line).toBeUndefined();
  });
});

describe('Requirements 29.30, 29.32 — which chains can lengthen audio', () => {
  it('flags a chain containing reverb', () => {
    expect(chainMayExtendTail(toChain([GAIN, REVERB]))).toBe(true);
  });

  it('flags a chain containing delay', () => {
    expect(
      chainMayExtendTail(
        toChain([{ kind: 'delay', parameters: { delay_seconds: 0.1, feedback: 0, mix: 0.5 } }]),
      ),
    ).toBe(true);
  });

  it('does not flag a chain of the other six kinds', () => {
    expect(
      chainMayExtendTail(
        toChain([
          GAIN,
          { kind: 'highpass', parameters: { cutoff_frequency_hz: 100 } },
          { kind: 'lowpass', parameters: { cutoff_frequency_hz: 8000 } },
          { kind: 'pitch_shift', parameters: { semitones: 1 } },
          {
            kind: 'compressor',
            parameters: { threshold_db: -20, ratio: 4, attack_ms: 1, release_ms: 100 },
          },
          {
            kind: 'chorus',
            parameters: { rate_hz: 1, depth: 0.2, feedback: 0, centre_delay_ms: 7, mix: 0.5 },
          },
        ]),
      ),
    ).toBe(false);
  });
});

describe('toChain', () => {
  it('throws for an invalid chain, since its callers have already validated', () => {
    expect(() => toChain([{ kind: 'nope', parameters: {} }])).toThrow(/not a valid Effect_Chain/);
  });
});
