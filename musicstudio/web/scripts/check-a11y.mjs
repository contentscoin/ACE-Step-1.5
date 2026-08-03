/**
 * The accessibility invariants a build can enforce (Requirements 31.11, 31.13, 31.14).
 *
 * ### Why these and not a general audit
 *
 * Most of Requirement 31 is about behaviour and is checked by tests. These four clauses are
 * different: they are invariants stated over *all* interactive components, and every one of them
 * is broken by adding a single line that looks harmless.
 *
 * - **31.11** — input is never blocked, not for one millisecond. Broken by `pointer-events: none`
 *   on something that animates, or by an overlay without one of its own.
 * - **31.13** — tab order matches visual order. Broken two ways: a positive `tabIndex`, which
 *   lifts an element into a separate earlier sequence; and the CSS that reorders a layout
 *   visually while leaving the DOM alone (`row-reverse`, `wrap-reverse`, `order`). Tab order
 *   follows the DOM, so either one silently makes the clause false.
 * - **31.14** — the focus indicator appears. Broken by `outline: none`, usually added because a
 *   ring looked wrong somewhere and removed globally.
 *
 * A test catches these only where a test happens to render; this catches them everywhere. Run
 * before `vite build`, so a violation produces no artefact — the same shape as the motion check of
 * Requirement 31.5.
 *
 * ### What it deliberately does not do
 *
 * It does not parse TypeScript, and it cannot see layout. A regex over source would be the wrong
 * tool for a question about types, but these are literal property spellings; a parser dependency
 * for four rules costs more than it is worth. The *geometric* half of 31.13 — that the rendered
 * boxes really do read in tab order — needs a browser, and lives in
 * `scripts/verify-a11y-browser.mjs`. False positives here are suppressible with a comment, and
 * the suppression has to say why.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import process from 'node:process';
import console from 'node:console';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_ROOT = join(root, 'src');

/** Written on the offending line to accept it, and the reason has to follow. */
const SUPPRESSION = 'a11y-check-ok:';

const RULES = [
  {
    id: 'pointer-events-none',
    requirement: '31.11',
    // `pointerEvents: 'none'` in a style object, or `pointer-events: none` in CSS.
    pattern: /pointerEvents\s*:\s*['"]none['"]|pointer-events\s*:\s*none/,
    message: '입력이 차단됩니다. 31.11은 차단 시간을 0ms로 유지하도록 요구합니다.',
  },
  {
    id: 'positive-tabindex',
    requirement: '31.13',
    // `tabIndex={1}` and up. `{0}` and `{-1}` are fine and are what the app uses.
    pattern: /tabIndex\s*=\s*\{\s*[1-9]\d*\s*\}|tabindex\s*=\s*["'][1-9]\d*["']/,
    message: '양수 tabIndex는 탭 순서를 시각적 배치 순서에서 떼어냅니다 (31.13).',
  },
  {
    id: 'visual-reordering',
    requirement: '31.13',
    // The CSS that makes visual order differ from DOM order. Tab order follows the DOM, so any of
    // these silently breaks the clause — and none of them is visible in a screenshot of a
    // symmetric layout, which is why a static rule earns its place here.
    pattern:
      /flexDirection\s*:\s*['"](row|column)-reverse['"]|flex-direction\s*:\s*(row|column)-reverse|flexWrap\s*:\s*['"]wrap-reverse['"]|flex-wrap\s*:\s*wrap-reverse|(^|[^-\w])order\s*:\s*-?[1-9]/,
    message: 'DOM 순서와 시각적 순서가 어긋납니다. 탭 순서는 DOM을 따릅니다 (31.13).',
  },
  {
    id: 'outline-none',
    requirement: '31.14',
    // Removing the focus ring. The one legitimate case — a `tabindex="-1"` container — does not
    // need it either, so there is no exemption and the app has none.
    pattern: /outline\s*:\s*(['"])?\s*none/,
    message: '포커스 표시를 제거합니다. 31.14는 포커스 표시가 나타나도록 요구합니다.',
  },
];

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

const violations = [];

for (const file of sourceFiles(SOURCE_ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    // A line that is only a comment is documentation about a rule, not a use of it — every rule
    // here is described in prose somewhere in this tree, including in this file's own siblings.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (line.includes(SUPPRESSION)) continue;

    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        violations.push({
          file: relative(root, file),
          line: index + 1,
          rule,
          source: trimmed.slice(0, 100),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`접근성 정적 검사 실패 — ${String(violations.length)}건`);
  for (const violation of violations) {
    console.error(
      `  Req ${violation.rule.requirement}  ${violation.rule.id}  ` +
        `(${violation.file}:${String(violation.line)})`,
    );
    console.error(`    ${violation.source}`);
    console.error(`    ${violation.rule.message}`);
  }
  console.error(`  의도한 예외라면 해당 줄에 \`${SUPPRESSION} 이유\` 주석을 붙이세요.`);
  process.exit(1);
}

console.log(
  `a11y check: 통과 — ${String(RULES.length)}개 규칙, 위반 없음 (Req 31.11, 31.13, 31.14)`,
);
