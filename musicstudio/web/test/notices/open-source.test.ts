import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPEN_SOURCE_NOTICES, noticeFor } from '../../src/notices/open-source';

/**
 * The open-source notice screen.
 *
 * **Validates: Requirements 31.16, 31.17**
 *
 * 31.17 asks for Amicro's notice specifically, and it is the one most easily lost: its components
 * are *vendored*, so nothing in `package.json` would remind anyone the dependency exists.
 *
 * 31.16's version floors are asserted against `package.json` rather than restated, because the
 * criterion is about what the project **declares** — a test that repeated the numbers would pass
 * while the manifest said something else.
 */

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

describe('Requirement 31.17 — the Amicro notice', () => {
  it('is present, with its licence and origin', () => {
    const amicro = noticeFor('Amicro');

    expect(amicro).toBeDefined();
    expect(amicro?.license).toBe('MIT');
    expect(amicro?.url).toContain('github.com');
    expect(amicro?.copyright.length).toBeGreaterThan(0);
  });

  it('names the same pin the registry does', () => {
    const registry = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', 'src', 'components', 'amicro', 'registry.json'),
        'utf8',
      ),
    ) as { version: string };

    expect(noticeFor('Amicro')?.version).toBe(registry.version);
  });

  it('gives every notice the four fields a licence screen needs', () => {
    for (const notice of OPEN_SOURCE_NOTICES) {
      expect(notice.name.length).toBeGreaterThan(0);
      expect(notice.license.length).toBeGreaterThan(0);
      expect(notice.url).toMatch(/^https:\/\//);
      expect(notice.copyright.length).toBeGreaterThan(0);
    }
  });
});

describe('Requirement 31.16 — the declared version floors', () => {
  const floors: readonly [string, number][] = [
    ['react', 19],
    ['motion', 12],
    ['tailwindcss', 4],
  ];

  it('declares React 19+, Motion 12+ and Tailwind 4+ in the dependency definition', () => {
    for (const [name, floor] of floors) {
      const range = manifest.dependencies[name] ?? manifest.devDependencies[name];
      expect(range, `${name} is not declared`).toBeDefined();

      const major = Number.parseInt((range ?? '').replace(/^[^\d]*/, ''), 10);
      expect(major, `${name} floor is ${String(range)}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('declares Vite 6+, which design §8.1 states as the bundler floor', () => {
    const major = Number.parseInt((manifest.devDependencies['vite'] ?? '').replace(/^[^\d]*/, ''), 10);
    expect(major).toBeGreaterThanOrEqual(6);
  });

  it('declares the state libraries design §8.1 names', () => {
    expect(manifest.dependencies['zustand']).toBeDefined();
    expect(manifest.dependencies['@tanstack/react-query']).toBeDefined();
  });
});
