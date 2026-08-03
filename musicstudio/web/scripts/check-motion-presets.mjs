/**
 * Requirement 31.5 — the static check.
 *
 * > IF 정적 검사 실행 중 모션 전환값이 Amicro_Motion_Preset 식별자 참조가 아니라 스프링 파라미터
 * > (강성, 감쇠, 질량, 지속 시간) 수치 리터럴로 표기된 구성요소가 1개 이상 발견되면, THEN …
 * > 정적 검사 결과를 실패로 반환하고, **위반 1건당 1개 항목으로 위반 구성요소 이름과 위반 파라미터
 * > 값을 보고하며, 빌드 산출물을 생성하지 않는다**
 *
 * Three obligations, and each shapes the implementation:
 *
 * 1. **One item per violation** — not one per file, not "3 files failed". A component with two bad
 *    values produces two rows, each naming the parameter and the number.
 * 2. **The component's name**, not just a path. The name is what a reviewer searches for, so it is
 *    read from the nearest enclosing `export function`/`const` above the violation.
 * 3. **No build artefact.** This runs *before* `vite build` in the `build` script, so a failure
 *    means the bundler never starts. A Vite plugin would already have created `dist/` on a watch
 *    build before it could object.
 *
 * ### Why a regex scanner rather than the TypeScript AST
 *
 * The rule is lexical: "a spring parameter written as a number, inside a transition". An AST walk
 * would be more precise about *where* the literal sits, and it would need the TypeScript compiler
 * in the check's dependency path — the check would then fail to run in exactly the offline build
 * Requirement 31.15 is about. The scanner has no dependencies at all: `node scripts/…` with nothing
 * installed still runs it.
 *
 * The trade is false positives on a file that mentions `stiffness:` outside a transition. That is
 * the safe direction (a build fails loudly rather than shipping a drifted spring), and the one file
 * that legitimately holds the numbers — `src/motion/presets.ts` — is exempted by exact path.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');
const SOURCE_DIR = join(ROOT, 'src');

/**
 * The one file allowed to write spring numbers.
 *
 * An exact path, not a pattern: `**\/presets.ts` would let a component named `presets.ts` slip
 * through, and that is precisely the file someone would create while working around this check.
 */
const EXEMPT = new Set([join('src', 'motion', 'presets.ts')]);

/** Requirement 31.5's four parameters, in the spellings Motion accepts. */
const SPRING_PARAMETERS = [
  'stiffness',
  'damping',
  'mass',
  'duration',
  'bounce',
  'velocity',
  'restSpeed',
  'restDelta',
];

/** `stiffness: 400`, `damping : 12.5`, `duration:0.3` — a parameter set to a number. */
const VIOLATION = new RegExp(`\\b(${SPRING_PARAMETERS.join('|')})\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g');

/** `export function Name`, `export const Name =`, `function Name` — the nearest one above a line. */
const DECLARATION = /(?:export\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/;

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx|js|jsx)$/.test(entry)) found.push(path);
  }
  return found;
}

/** The component a line belongs to: the nearest declaration at or above it. */
function componentNameAt(lines, lineIndex) {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const match = DECLARATION.exec(lines[index] ?? '');
    if (match !== null) return match[1];
  }
  return '(module scope)';
}

function violationsIn(path) {
  const relativePath = relative(ROOT, path);
  if (EXEMPT.has(relativePath)) return [];

  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const found = [];

  lines.forEach((line, index) => {
    // A comment is prose, not a transition. `duration: 0.3` in a doc comment explaining the rule
    // would otherwise fail the build the comment is describing.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    for (const match of line.matchAll(VIOLATION)) {
      found.push({
        file: relativePath.split(sep).join('/'),
        line: index + 1,
        component: componentNameAt(lines, index),
        parameter: match[1],
        value: match[2],
      });
    }
  });

  return found;
}

export function checkMotionPresets() {
  return sourceFiles(SOURCE_DIR).flatMap(violationsIn);
}

/* --------------------------------------------------------------------------- */

const violations = checkMotionPresets();

if (violations.length === 0) {
  console.log('motion preset check: 통과 — 스프링 파라미터 수치 리터럴 없음');
  process.exit(0);
}

// Requirement 31.5: one item per violation, each naming the component and the offending value.
console.error(`motion preset check: 실패 — 위반 ${String(violations.length)}건\n`);
for (const violation of violations) {
  console.error(
    `  ${violation.component}  ${violation.parameter}=${violation.value}` +
      `  (${violation.file}:${String(violation.line)})`,
  );
}
console.error(
  '\n  스프링 전환값은 Amicro_Motion_Preset 식별자로만 참조한다 (Requirement 31.4).' +
    '\n  src/motion/presets.ts 의 5개 프리셋 중 하나를 쓰고, 수치는 그 파일에만 둔다.',
);
process.exit(1);
