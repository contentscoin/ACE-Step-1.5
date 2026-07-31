import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/**
 * Harness smoke check only — no product behaviour is asserted here.
 *
 * Its purpose is to prove the `fast-check` property harness executes under
 * vitest with the run count design §10 requires (>= 100 cases per property).
 * The numbered correctness properties (Property 1..24) land in sibling files
 * as their subject modules are implemented.
 */
describe('fast-check harness', () => {
  it('executes at least 100 cases per property', () => {
    let cases = 0;

    fc.assert(
      fc.property(fc.string(), (value) => {
        cases += 1;
        return typeof value === 'string';
      }),
      { numRuns: 100 },
    );

    expect(cases).toBeGreaterThanOrEqual(100);
  });
});
