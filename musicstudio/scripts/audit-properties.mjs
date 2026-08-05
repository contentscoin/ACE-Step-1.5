#!/usr/bin/env node
/**
 * The PBT coverage audit of task 9.2 — design §10's 24 Correctness Properties.
 *
 * Task 9.2 is explicit that it is **not** a place to write the properties: each is owned by the
 * feature task that built the thing it constrains. What 9.2 owns is the question "are they all
 * actually there", asked mechanically, in CI, so that the answer stops depending on somebody
 * remembering.
 *
 * ### The list is read from design.md, not restated here
 *
 * A hard-coded table of 24 entries is a 25th place for the truth to live, and the first time a
 * property is renumbered or its clause list changes, the audit passes against a design nobody is
 * building to any more. So the properties are parsed out of the design document itself: a heading
 * `#### Property N: title` and the `**Validates: Requirements ...**` line under it. If the design
 * gains a Property 25, this audit demands it the same day.
 *
 * ### What counts as a declaration
 *
 * Exactly one form:
 *
 *     Feature: ai-music-generation-service, Property N: <sentence>
 *
 * — the form tasks.md fixes. Prose mentions do not count, and that distinction is the whole
 * reason the audit can check for *duplicates*: several tests legitimately discuss a property they
 * do not implement (`edit-lineage.test.ts` applies Property 21's invariant to one subsystem and
 * says so), and a check that counted every mention would report those as double implementations.
 * One canonical line, in the test that owns it.
 *
 * ### What is checked
 *
 * 1. **Present** — every property in design §10 has exactly one declaration.
 * 2. **Not duplicated** — no property has two.
 * 3. **Run count** — the declaring file's `numRuns` / `max_examples` are all at least 100. Read
 *    per *file* rather than per assertion because a property's supporting generators sit in the
 *    same file, and a file with one 100-run property beside a 10-run helper is a file where the
 *    next property added quietly inherits 10.
 * 4. **Clauses named** — the declaring file mentions each requirement clause design §10 lists for
 *    that property. A property that is checked but not traceable to its clause is a property that
 *    survives the clause being deleted.
 *
 * Usage: `node scripts/audit-properties.mjs [--json]`
 * Exit status: 0 clean, 1 on any finding, 2 on a usage or parse error.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const HERE = dirname(fileURLToPath(import.meta.url));
const MUSICSTUDIO = resolve(HERE, '..');
const REPO = resolve(MUSICSTUDIO, '..');

const DESIGN = join(REPO, '.kiro/specs/ai-music-generation-service/design.md');

/**
 * Where a declaration may live: all three test trees.
 *
 * `web/test` is on the list because Property 19 lives there — the UI sound layer is the thing it
 * constrains, and its tests run in the web package's own Vitest. The first version of this audit
 * scanned only the two backend trees and reported Property 19 as missing when it was sitting in a
 * file that named it. A coverage audit that cannot see a whole package is a coverage audit that
 * reports its own blind spot as a gap in the product.
 */
const TEST_ROOTS = [
  join(MUSICSTUDIO, 'test'),
  join(MUSICSTUDIO, 'dsp', 'test'),
  join(MUSICSTUDIO, 'web', 'test'),
];
const TEST_EXTENSIONS = ['.ts', '.tsx', '.py'];
const SKIP_DIRECTORIES = new Set(['node_modules', '__pycache__', '.pytest_cache', '.hypothesis']);

/** Design §10: 속성당 최소 반복 100회. */
export const MINIMUM_RUNS = 100;

const DECLARATION = /Feature: ai-music-generation-service, Property (\d+):/g;

/**
 * `fast-check`'s knob and `hypothesis`'s, read from the same expression.
 *
 * The value may be a literal or a named constant — most files here write `numRuns: NUM_RUNS`,
 * which is better style and would have made a literal-only audit report every one of them as
 * unset. So constants are resolved, and a value the audit *cannot* resolve is reported as such
 * rather than assumed adequate: "I could not tell" and "it is fine" are different answers, and
 * only one of them is honest.
 */
const RUN_COUNT = /\b(?:numRuns|max_examples)\s*[:=]\s*([A-Za-z_$][\w$]*|\d+)/g;
/** `const NUM_RUNS = 200`, `NUM_RUNS = 200`, `NUM_RUNS: Final[int] = 200`. */
const NUMERIC_CONSTANT = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)(?::[^=\n]+)?\s*=\s*(\d[\d_]*)/gm;

/**
 * The one way to tell the audit a run count it cannot read is deliberate.
 *
 * There is exactly one real case, and it is a case where the count is *stronger* than the floor
 * rather than weaker: a property quantified over a finite domain, run exhaustively.
 * `voice-invariants.test.ts` runs one over every loop cue there is —
 * `{ numRuns: LOOP_CUES.length }` — which covers the domain completely and happens to be fewer
 * than 100 draws. Raising it to 100 would repeat the same handful of cases 90 times and call the
 * result more thorough.
 *
 * Written as a comment the audit greps for, on the same line, so an exemption is visible in the
 * diff that introduces it and carries its reason with it. Same arrangement as `a11y-check-ok:`.
 */
const RUNS_EXEMPTION = /property-audit-runs-ok:/;

/* ------------------------------------------------------------------ design */

/**
 * The properties design §10 defines.
 *
 * Parsed rather than transcribed — see the module header. A `#### Property N: …` heading whose
 * `**Validates:**` line is missing is itself a finding, because a property with no clause is a
 * property nothing can be traced to.
 */
export function parseDesignProperties(markdown) {
  const properties = [];
  const headings = [
    ...markdown.matchAll(/^#### Property (\d+): (.+)$/gm),
  ];

  for (const [index, heading] of headings.entries()) {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(start, end);
    const validates = /^\*\*Validates: Requirements? ([^*]+)\*\*$/m.exec(section);

    properties.push({
      number: Number(heading[1]),
      title: (heading[2] ?? '').trim(),
      clauses:
        validates === null
          ? []
          : (validates[1] ?? '')
              .split(',')
              .map((clause) => clause.trim())
              .filter((clause) => clause.length > 0),
    });
  }

  return properties;
}

/* ------------------------------------------------------------------- tests */

function* walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return; // A root that does not exist is not a finding; an empty one is the same thing.
  }

  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (TEST_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      yield path;
    }
  }
}

/** Every declaration in the test tree, with the file it was found in. */
export function collectDeclarations(files) {
  const declarations = new Map();

  for (const { path, source } of files) {
    for (const match of source.matchAll(DECLARATION)) {
      const number = Number(match[1]);
      const existing = declarations.get(number) ?? [];
      // A file may repeat its own declaration — a `describe` title and the comment above it are
      // the ordinary case. That is one declaration, not two.
      if (!existing.includes(path)) existing.push(path);
      declarations.set(number, existing);
    }
  }

  return declarations;
}

/**
 * The run counts a file configures.
 *
 * `lowest` is the smallest it sets, `unresolved` the names it sets that this audit could not
 * follow to a number. Both are reported: a file whose count is computed at runtime is not a file
 * the audit may call compliant.
 */
export function runCountsIn(source) {
  const constants = new Map(
    [...source.matchAll(NUMERIC_CONSTANT)].map((match) => [
      match[1],
      Number((match[2] ?? '').replaceAll('_', '')),
    ]),
  );

  const resolved = [];
  const unresolved = [];

  for (const match of source.matchAll(RUN_COUNT)) {
    const value = match[1] ?? '';

    // An exempted line is not read at all — see `RUNS_EXEMPTION`.
    const lineStart = source.lastIndexOf('\n', match.index ?? 0) + 1;
    const lineEnd = source.indexOf('\n', match.index ?? 0);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    if (RUNS_EXEMPTION.test(line)) continue;

    if (/^\d+$/.test(value)) {
      resolved.push(Number(value));
      continue;
    }
    const constant = constants.get(value);
    if (constant === undefined) unresolved.push(value);
    else resolved.push(constant);
  }

  return {
    lowest: resolved.length === 0 ? null : Math.min(...resolved),
    unresolved: [...new Set(unresolved)],
  };
}

/* ------------------------------------------------------------------- audit */

export function auditProperties(designMarkdown, files) {
  const properties = parseDesignProperties(designMarkdown);
  const declarations = collectDeclarations(files);
  const byPath = new Map(files.map((file) => [file.path, file.source]));
  const findings = [];

  if (properties.length === 0) {
    findings.push({
      kind: 'design_unreadable',
      message: 'design §10 defines no properties — the audit has nothing to check against',
    });
    return { properties, findings };
  }

  for (const property of properties) {
    const paths = declarations.get(property.number) ?? [];

    if (property.clauses.length === 0) {
      findings.push({
        kind: 'design_clause_missing',
        property: property.number,
        message: `design §10 gives Property ${String(property.number)} no "Validates" line`,
      });
    }

    if (paths.length === 0) {
      findings.push({
        kind: 'missing',
        property: property.number,
        message: `Property ${String(property.number)} (${property.title}) is declared by no test`,
      });
      continue;
    }

    if (paths.length > 1) {
      findings.push({
        kind: 'duplicate',
        property: property.number,
        message: `Property ${String(property.number)} is declared by ${String(paths.length)} tests: ${paths.join(', ')}`,
      });
    }

    for (const path of paths) {
      const source = byPath.get(path) ?? '';
      const { lowest, unresolved } = runCountsIn(source);

      if (lowest === null && unresolved.length === 0) {
        findings.push({
          kind: 'runs_unset',
          property: property.number,
          message: `${path} declares Property ${String(property.number)} but sets no numRuns/max_examples`,
        });
      } else if (lowest !== null && lowest < MINIMUM_RUNS) {
        findings.push({
          kind: 'runs_short',
          property: property.number,
          message: `${path} runs Property ${String(property.number)} at ${String(lowest)}, below the ${String(MINIMUM_RUNS)} design §10 requires`,
        });
      }

      if (unresolved.length > 0) {
        findings.push({
          kind: 'runs_unresolved',
          property: property.number,
          message: `${path} sets the run count from ${unresolved.join(', ')}, which this audit cannot follow to a number`,
        });
      }

      const absent = property.clauses.filter((clause) => !source.includes(clause));
      if (absent.length > 0) {
        findings.push({
          kind: 'clause_untraced',
          property: property.number,
          message: `${path} declares Property ${String(property.number)} without naming requirement ${absent.join(', ')}`,
        });
      }
    }
  }

  return { properties, findings };
}

/* -------------------------------------------------------------------- main */

export function readTestFiles() {
  const files = [];
  for (const root of TEST_ROOTS) {
    for (const path of walk(root)) {
      files.push({ path: relative(MUSICSTUDIO, path), source: readFileSync(path, 'utf8') });
    }
  }
  return files;
}

function main() {
  const asJson = process.argv.includes('--json');

  let designMarkdown;
  try {
    designMarkdown = readFileSync(DESIGN, 'utf8');
  } catch {
    console.error(`property audit: cannot read the design document at ${DESIGN}`);
    process.exit(2);
  }

  const { properties, findings } = auditProperties(designMarkdown, readTestFiles());

  if (asJson) {
    console.log(JSON.stringify({ propertyCount: properties.length, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(
      `property audit: 통과 — design §10의 Property ${String(properties.length)}개 전부가 최소 ${String(MINIMUM_RUNS)}회로 선언되어 있습니다`,
    );
  } else {
    console.error(`property audit: ${String(findings.length)}건`);
    for (const finding of findings) {
      console.error(`  [${finding.kind}] ${finding.message}`);
    }
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

// Run when invoked directly; stay silent when imported by the test that also runs the audit.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
