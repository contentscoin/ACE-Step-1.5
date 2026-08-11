import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MINIMUM_RUNS,
  auditProperties,
  collectDeclarations,
  parseDesignProperties,
  readTestFiles,
  runCountsIn,
} from '../../scripts/audit-properties.mjs';

/**
 * The PBT coverage audit itself (task 9.2).
 *
 * **Validates: design §10 — 24 Correctness Properties, ≥100 runs each**
 *
 * Two halves, and the second is the one that matters. The first runs the audit over this
 * repository and asserts it is clean; the second feeds the audit's own machinery a synthetic
 * repository in which each defect is present, and asserts it says so. An audit only ever tested
 * against a passing tree is an audit that could be `return []` and nobody would know.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');
const DESIGN = readFileSync(
  join(REPO, '.kiro/specs/ai-music-generation-service/design.md'),
  'utf8',
);

describe('this repository', () => {
  it('declares every Correctness Property design §10 defines, once each', () => {
    const { properties, findings } = auditProperties(DESIGN, readTestFiles());

    // The acceptance criterion of task 9.2: 24개 Property 전부 식별, 누락 0건, 중복 0건.
    expect(findings).toEqual([]);
    expect(properties).toHaveLength(24);
  });

  it('finds each declaration in exactly one file', () => {
    const declarations = collectDeclarations(readTestFiles());

    for (const [property, paths] of declarations) {
      expect(paths, `Property ${String(property)}`).toHaveLength(1);
    }
  });
});

/**
 * Declarations built rather than written out.
 *
 * A literal `Feature: ai-music-generation-service, Property N:` in this file *is* a declaration —
 * the audit scans the whole test tree, and it found this file the first time it ran, reporting
 * Property 1 as declared twice. Excluding this path from the scan would have been the easy fix and
 * the wrong one: an audit with a hole in it is exactly what the audit exists to prevent. The
 * marker is assembled instead, so the file can talk about the form without being an instance of it.
 */
const MARKER = ['Feature: ai-music-generation-service,', 'Property'].join(' ');

function declarationFor(property: number, sentence: string): string {
  return `${MARKER} ${String(property)}: ${sentence}`;
}

describe('reading design §10', () => {
  it('takes the property list from the design rather than a copy of it', () => {
    // The reason this is parsed and not transcribed: a hard-coded table is a 25th place for the
    // truth to live, and it passes against a design nobody builds to any more.
    const properties = parseDesignProperties(DESIGN);

    expect(properties[0]).toMatchObject({ number: 1, clauses: ['Requirements 9.6'.slice(13)] });
    expect(properties.at(-1)?.number).toBe(24);
  });

  it('demands a new property the day the design gains one', () => {
    const withTwentyFive = `${DESIGN}\n#### Property 25: something new\n\n**Validates: Requirements 99.1**\n`;

    const { findings } = auditProperties(withTwentyFive, readTestFiles());

    expect(findings).toEqual([
      expect.objectContaining({ kind: 'missing', property: 25 }),
    ]);
  });

  it('reports a property the design gives no clause', () => {
    const design = '#### Property 1: unclaused\n\nno validates line here\n';

    const { findings } = auditProperties(design, [
      { path: 'test/x.test.ts', source: `${declarationFor(1, 'x')}\nnumRuns: 100` },
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ kind: 'design_clause_missing', property: 1 }),
    ]);
  });
});

describe('what the audit refuses', () => {
  const design = '#### Property 1: a thing\n\n**Validates: Requirements 1.1, 1.2**\n';
  const declaration = declarationFor(1, 'a thing');

  function audit(files: { path: string; source: string }[]) {
    return auditProperties(design, files).findings;
  }

  it('a property nothing declares', () => {
    expect(audit([{ path: 'test/a.test.ts', source: 'no property here' }])).toEqual([
      expect.objectContaining({ kind: 'missing', property: 1 }),
    ]);
  });

  it('a property two files declare', () => {
    // The check the canonical form exists for: several tests legitimately *discuss* a property
    // they do not implement, and a rule that counted mentions would report those as duplicates.
    const findings = audit([
      { path: 'test/a.test.ts', source: `${declaration}\nnumRuns: 100\n1.1 1.2` },
      { path: 'test/b.test.ts', source: `${declaration}\nnumRuns: 100\n1.1 1.2` },
    ]);

    expect(findings).toEqual([expect.objectContaining({ kind: 'duplicate', property: 1 })]);
  });

  it('a mention that is not a declaration', () => {
    // Prose about Property 1 does not claim it.
    expect(
      audit([{ path: 'test/a.test.ts', source: 'see design 10, Property 1, for the shape' }]),
    ).toEqual([expect.objectContaining({ kind: 'missing', property: 1 })]);
  });

  it('a run count below the floor', () => {
    const findings = audit([
      { path: 'test/a.test.ts', source: `${declaration}\nnumRuns: 99\n1.1 1.2` },
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ kind: 'runs_short', property: 1 }),
    ]);
  });

  it('a declaration with no run count at all', () => {
    expect(audit([{ path: 'test/a.test.ts', source: `${declaration}\n1.1 1.2` }])).toEqual([
      expect.objectContaining({ kind: 'runs_unset', property: 1 }),
    ]);
  });

  it('a run count it cannot follow to a number', () => {
    // "I could not tell" and "it is fine" are different answers, and only one is honest.
    expect(
      audit([{ path: 'test/a.test.ts', source: `${declaration}\nnumRuns: computed()\n1.1 1.2` }]),
    ).toEqual([expect.objectContaining({ kind: 'runs_unresolved', property: 1 })]);
  });

  it('a declaration that names none of its requirement clauses', () => {
    // A property checked but not traceable to its clause survives the clause being deleted.
    expect(audit([{ path: 'test/a.test.ts', source: `${declaration}\nnumRuns: 100` }])).toEqual([
      expect.objectContaining({ kind: 'clause_untraced', property: 1 }),
    ]);
  });
});

describe('reading run counts', () => {
  it('follows a named constant, in either language', () => {
    expect(runCountsIn('const NUM_RUNS = 200;\nfc.assert(x, { numRuns: NUM_RUNS })').lowest).toBe(
      200,
    );
    expect(runCountsIn('RUNS = 250\n@settings(max_examples=RUNS)').lowest).toBe(250);
  });

  it('takes the lowest a file sets, not the first', () => {
    // A file with one 100-run property beside a 10-run helper is a file where the next property
    // added quietly inherits 10.
    expect(runCountsIn('{ numRuns: 500 }\n{ numRuns: 10 }').lowest).toBe(10);
  });

  it('honours an exemption on the same line, and only there', () => {
    const exempted = runCountsIn('{ numRuns: CUES.length }, // property-audit-runs-ok: finite');
    expect(exempted).toEqual({ lowest: null, unresolved: [] });

    const above = runCountsIn('// property-audit-runs-ok: finite\n{ numRuns: CUES.length }');
    expect(above.unresolved).toEqual(['CUES']);
  });

  it('knows the floor design §10 sets', () => {
    expect(MINIMUM_RUNS).toBe(100);
  });
});
