/**
 * The accessibility static check (Requirements 31.11, 31.13, 31.14).
 *
 * **Validates: Requirements 31.11, 31.13, 31.14**
 *
 * The same shape as `test/motion/static-check.test.ts`: a check that cannot fail is a log line, so
 * each rule is planted into a copied tree and the real script is run as a subprocess against it.
 * Asserting an imported predicate would prove the predicate and say nothing about whether the
 * build calls it.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const WEB_ROOT = join(import.meta.dirname, '..', '..');
let workspace: string | null = null;

afterEach(() => {
  if (workspace !== null) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

/** A scratch tree holding only the checker and the planted sources. */
function plant(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'a11y-check-'));
  workspace = root;

  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(WEB_ROOT, 'scripts', 'check-a11y.mjs'), join(root, 'scripts', 'check-a11y.mjs'));

  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function runCheck(cwd: string): { code: number; output: string } {
  try {
    const output = execFileSync('node', [join(cwd, 'scripts', 'check-a11y.mjs')], {
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

const CLEAN = `export const panel = { padding: 16 };\nexport const button = { cursor: 'pointer' };\n`;

describe('check-a11y', () => {
  it('passes on the real source tree', () => {
    const { code, output } = runCheck(WEB_ROOT);
    expect(code).toBe(0);
    expect(output).toContain('통과');
  });

  it('passes on a clean planted tree, so a failure below means the plant', () => {
    const { code } = runCheck(plant({ 'src/clean.ts': CLEAN }));
    expect(code).toBe(0);
  });

  it('fails on `pointer-events: none` (Req 31.11)', () => {
    const root = plant({
      'src/overlay.tsx': `export const overlay = { pointerEvents: 'none' };\n`,
    });
    const { code, output } = runCheck(root);

    expect(code).toBe(1);
    // One item per violation, naming the requirement, the rule and the location — the same
    // reporting shape the motion check of Requirement 31.5 uses.
    expect(output).toContain('Req 31.11');
    expect(output).toContain('pointer-events-none');
    expect(output).toContain('src/overlay.tsx:1');
  });

  it('fails on a positive tabIndex (Req 31.13)', () => {
    const { code, output } = runCheck(
      plant({ 'src/jump.tsx': `export const x = <button tabIndex={3}>먼저</button>;\n` }),
    );
    expect(code).toBe(1);
    expect(output).toContain('Req 31.13');
    expect(output).toContain('positive-tabindex');
  });

  it('accepts tabIndex 0 and -1, which are how the app reaches its region', () => {
    const { code } = runCheck(
      plant({
        'src/ok.tsx': `export const a = <div tabIndex={-1} />;\nexport const b = <div tabIndex={0} />;\n`,
      }),
    );
    expect(code).toBe(0);
  });

  it('fails on CSS that reorders a layout visually (Req 31.13)', () => {
    for (const source of [
      `export const s = { flexDirection: 'row-reverse' };`,
      `export const s = { flexWrap: 'wrap-reverse' };`,
      `.a { flex-direction: column-reverse; }`,
    ]) {
      const { code, output } = runCheck(plant({ 'src/reorder.ts': `${source}\n` }));
      expect(code, source).toBe(1);
      expect(output).toContain('visual-reordering');
      rmSync(workspace as string, { recursive: true, force: true });
      workspace = null;
    }
  });

  it('fails on `outline: none` (Req 31.14)', () => {
    const { code, output } = runCheck(
      plant({ 'src/quiet.css': `button:focus-visible { outline: none; }\n` }),
    );
    expect(code).toBe(1);
    expect(output).toContain('Req 31.14');
    expect(output).toContain('outline-none');
  });

  it('reports every violation rather than stopping at the first', () => {
    const { code, output } = runCheck(
      plant({
        'src/one.ts': `export const a = { pointerEvents: 'none' };\n`,
        'src/two.tsx': `export const b = <i tabIndex={2} />;\n`,
        'src/three.css': `.c { outline: none; }\n`,
      }),
    );
    expect(code).toBe(1);
    expect(output).toContain('3건');
  });

  it('accepts a violation carrying a suppression comment with a reason', () => {
    const { code } = runCheck(
      plant({
        'src/scrim.tsx':
          `export const s = { pointerEvents: 'none' }; // a11y-check-ok: 장식용 스크림, 입력 대상 아님\n`,
      }),
    );
    expect(code).toBe(0);
  });

  it('does not flag prose about a rule', () => {
    const { code } = runCheck(
      plant({
        'src/doc.ts':
          `/**\n * Never write pointer-events: none here.\n */\n// and tabIndex={9} is banned too\nexport const x = 1;\n`,
      }),
    );
    expect(code).toBe(0);
  });
});
