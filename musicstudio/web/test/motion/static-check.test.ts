import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * The static check of Requirement 31.5.
 *
 * **Validates: Requirement 31.5**
 *
 * > … 위반 1건당 1개 항목으로 위반 구성요소 이름과 위반 파라미터 값을 보고하며, 빌드 산출물을
 * > 생성하지 않는다
 *
 * Three things to prove, and the third is the one a weaker test would miss:
 *
 * 1. it **fails** on a spring literal;
 * 2. it reports **one item per violation**, each naming the component and the value — not a count,
 *    not one line per file;
 * 3. it exits non-zero, which is what keeps `vite build` from running and therefore what makes
 *    "no build artefact" true.
 *
 * The check is run as a subprocess against a *copied* tree with a planted violation, so the
 * assertions are about the real script's real output rather than about an imported function that
 * the build might not be calling.
 */

const WEB_ROOT = join(import.meta.dirname, '..', '..');
let workspace: string | null = null;

/** Copy the checker and a source tree into a scratch directory. */
function plant(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'motion-check-'));
  workspace = root;

  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(
    join(WEB_ROOT, 'scripts', 'check-motion-presets.mjs'),
    join(root, 'scripts', 'check-motion-presets.mjs'),
  );

  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return root;
}

function runCheck(root: string): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [join(root, 'scripts', 'check-motion-presets.mjs')], {
      encoding: 'utf8',
    });
    return { status: 0, output: stdout };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

afterEach(() => {
  if (workspace !== null) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe('a clean tree', () => {
  it('passes and exits zero', () => {
    const root = plant({
      'src/components/Fine.tsx': [
        "import { MOTION_PRESETS } from '../motion/presets';",
        'export function Fine() {',
        '  return <motion.div transition={MOTION_PRESETS.snappy} />;',
        '}',
      ].join('\n'),
      'src/motion/presets.ts': 'export const MOTION_PRESETS = { snappy: { stiffness: 420 } };',
    });

    const result = runCheck(root);

    expect(result.status).toBe(0);
    expect(result.output).toContain('통과');
  });
});

describe('a spring literal (Requirement 31.5)', () => {
  it('fails, and produces no zero exit for a build to continue from', () => {
    const root = plant({
      'src/components/Drifted.tsx': [
        'export function Drifted() {',
        '  return <motion.div transition={{ type: "spring", stiffness: 400, damping: 12 }} />;',
        '}',
      ].join('\n'),
    });

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain('실패');
  });

  it('reports one item per violation, naming the component and the value', () => {
    const root = plant({
      'src/components/Drifted.tsx': [
        'export function Drifted() {',
        '  return <motion.div transition={{ stiffness: 400, damping: 12 }} />;',
        '}',
        'export function AlsoDrifted() {',
        '  return <motion.span transition={{ duration: 0.35 }} />;',
        '}',
      ].join('\n'),
    });

    const result = runCheck(root);

    expect(result.output).toContain('위반 3건');
    expect(result.output).toContain('Drifted  stiffness=400');
    expect(result.output).toContain('Drifted  damping=12');
    expect(result.output).toContain('AlsoDrifted  duration=0.35');
  });

  it('catches every parameter Requirement 31.5 names', () => {
    const root = plant({
      'src/components/Every.tsx': [
        'export function Every() {',
        '  return <motion.div transition={{ stiffness: 1, damping: 2, mass: 3, duration: 4 }} />;',
        '}',
      ].join('\n'),
    });

    expect(runCheck(root).output).toContain('위반 4건');
  });

  it('reports the file and line so the violation is findable', () => {
    const root = plant({
      'src/components/Deep.tsx': ['export function Deep() {', '  const t = { mass: 2 };', '}'].join(
        '\n',
      ),
    });

    expect(runCheck(root).output).toMatch(/src\/components\/Deep\.tsx:2/);
  });
});

describe('what it deliberately does not flag', () => {
  it('exempts the preset module, which is where the numbers belong', () => {
    const root = plant({
      'src/motion/presets.ts': 'export const P = { stiffness: 420, damping: 32, mass: 1 };',
    });

    expect(runCheck(root).status).toBe(0);
  });

  it('ignores prose in comments', () => {
    // A doc comment explaining the rule must not fail the build the comment describes.
    const root = plant({
      'src/components/Documented.tsx': [
        '/**',
        ' * Never write `stiffness: 400` here — use a preset.',
        ' */',
        '// duration: 0.3 would also be wrong',
        'export function Documented() { return null; }',
      ].join('\n'),
    });

    expect(runCheck(root).status).toBe(0);
  });

  it('accepts a named constant, because that is the fix it is asking for', () => {
    const root = plant({
      'src/components/Fixed.tsx': [
        "import { MOTION_PRESETS } from '../motion/presets';",
        'export function Fixed() {',
        '  return <motion.div transition={MOTION_PRESETS.gentle} />;',
        '}',
      ].join('\n'),
      'src/motion/presets.ts': 'export const MOTION_PRESETS = { gentle: { stiffness: 170 } };',
    });

    expect(runCheck(root).status).toBe(0);
  });
});

describe('the real source tree', () => {
  it('passes, so the build can run', () => {
    const stdout = execFileSync(
      'node',
      [join(WEB_ROOT, 'scripts', 'check-motion-presets.mjs')],
      { encoding: 'utf8' },
    );
    expect(stdout).toContain('통과');
  });
});
