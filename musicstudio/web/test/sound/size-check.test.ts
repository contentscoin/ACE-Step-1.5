/**
 * The sound runtime size budget (Requirement 32.17).
 *
 * **Validates: Requirement 32.17**
 *
 * > THE UI_Sound_Layer SHALL 오디오 자산을 제외한 사운드 재생 런타임 코드의 압축 후 전송 크기를
 * > 20킬로바이트 이하로 유지한다(불변식)
 *
 * Two claims, and the second is the one a weaker test would skip:
 *
 * 1. the runtime is inside the budget **today**;
 * 2. the check would **fail** if it were not — a size check that cannot fail is a log line.
 *
 * The second is established by running the real script against a copied tree whose cue table has
 * been inflated past the budget, exactly as `test/motion/static-check.test.ts` does for
 * Requirement 31.5. Asserting a number the script printed proves the number; running the script
 * against something too big proves the gate.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const WEB_ROOT = join(import.meta.dirname, '..', '..');
let workspace: string | null = null;

afterEach(() => {
  if (workspace !== null) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function runCheck(cwd: string): { code: number; output: string } {
  try {
    const output = execFileSync('node', [join(cwd, 'scripts', 'check-sound-size.mjs')], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('check-sound-size (Req 32.17)', () => {
  it('passes on the real runtime and reports the measured size', () => {
    const { code, output } = runCheck(WEB_ROOT);
    expect(code).toBe(0);
    expect(output).toContain('통과');

    // The printed number is the claim, so it is parsed and checked rather than trusted.
    const gzip = /gzip ([\d.]+) KB \/ ([\d.]+) KB/.exec(output);
    expect(gzip).not.toBeNull();
    expect(Number(gzip?.[1])).toBeLessThanOrEqual(Number(gzip?.[2]));
    expect(Number(gzip?.[2])).toBe(20);
  });

  it('fails, with no artefact, when the runtime exceeds the budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'sound-size-'));
    workspace = root;

    // A real copy of the tree the script measures, plus the node_modules it needs. The modules
    // are symlinked rather than copied: this is esbuild, and copying it is a hundred megabytes.
    cpSync(join(WEB_ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(WEB_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
    cpSync(join(WEB_ROOT, 'tsconfig.json'), join(root, 'tsconfig.json'));
    symlinkSync(join(WEB_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');

    // Inflate the cue table past 20 KB gzipped, by lengthening the status sentences themselves.
    //
    // Not by appending an unused `export const`: esbuild tree-shakes it, the bundle comes out the
    // same size, and the test passes for the wrong reason. The strings the table already reaches
    // are the only bytes a bundler cannot drop. The filler is unique per entry because gzip would
    // otherwise compress a repeated block away and the planted violation would not violate.
    const cues = readFileSync(join(root, 'src', 'sound', 'cues.ts'), 'utf8');
    let index = 0;
    const inflated = cues.replace(/status: '/g, () => {
      index += 1;
      const noise = Array.from(
        { length: 60 },
        (_unused, part) => ((index * 2_654_435_761 + part * 40_503) % 2 ** 32).toString(36),
      ).join(' ');
      return `status: '${noise} `;
    });
    expect(index).toBeGreaterThan(70);
    writeFileSync(join(root, 'src', 'sound', 'cues.ts'), inflated);

    const { code, output } = runCheck(root);

    expect(code).toBe(1);
    expect(output).toContain('Req 32.17');
    expect(output).toContain('초과');
  });
});
