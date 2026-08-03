import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import registry from '../../src/components/amicro/registry.json';
import {
  MOTION_CATEGORIES,
  MOTION_CLASSIFICATION_TABLE,
  MOTION_PURPOSES,
  classificationOf,
  componentsInCategory,
  unclassifiedComponents,
} from '../../src/motion/classification';

/**
 * The Motion_Classification_Table and the registry listing.
 *
 * **Validates: Requirements 31.1, 31.2, 31.3, 31.18**
 *
 * 31.18's invariant is "the number of animated components with no classification is zero", and the
 * only honest way to check it is to look at the **components**, not at the table: a table that
 * lists itself is complete by construction. So the directory is walked, every file that imports
 * `motion/react` is treated as animated, and each one must have a row.
 */

const COMPONENT_ROOT = join(import.meta.dirname, '..', '..', 'src', 'components');

/** Every component that actually animates: one that imports Motion. */
function animatedComponents(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...animatedComponents(path));
      continue;
    }
    if (!entry.name.endsWith('.tsx')) continue;
    const source = readFileSync(path, 'utf8');
    if (source.includes("from 'motion/react'")) found.push(entry.name.replace(/\.tsx$/, ''));
  }
  return found;
}

describe('Requirement 31.18 — every animated component is classified', () => {
  it('leaves nothing unclassified', () => {
    const animated = animatedComponents(COMPONENT_ROOT);

    expect(animated.length).toBeGreaterThan(0);
    expect(unclassifiedComponents(animated)).toEqual([]);
  });

  it('classifies each one exactly once', () => {
    const names = MOTION_CLASSIFICATION_TABLE.map((entry) => entry.component);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses one of the two purposes, and only those', () => {
    for (const entry of MOTION_CLASSIFICATION_TABLE) {
      expect(MOTION_PURPOSES).toContain(entry.purpose);
      expect(MOTION_CATEGORIES).toContain(entry.category);
    }
  });

  it('records why, so a reclassification is a decision rather than an edit', () => {
    for (const entry of MOTION_CLASSIFICATION_TABLE) {
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe('Requirement 31.1 — the four categories, all from the registry listing', () => {
  it('covers every category with at least one component', () => {
    for (const category of MOTION_CATEGORIES) {
      expect(componentsInCategory(category).length, category).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps 100% of animated components on the registry listing', () => {
    // The invariant 31.1 states as a ratio. Written as "none is off the list" because that is what
    // a failure looks like — a component someone wrote by hand and nobody noticed.
    const offRegistry = MOTION_CLASSIFICATION_TABLE.filter(
      (entry) => !registry.categories[entry.category].includes(entry.amicroComponent),
    );

    expect(offRegistry.map((entry) => entry.component)).toEqual([]);
  });

  it('installs exactly the components the table uses', () => {
    const used = MOTION_CLASSIFICATION_TABLE.map((entry) => entry.amicroComponent).sort();
    expect([...registry.installed].sort()).toEqual(used);
  });

  it('offers a loading component from the eight Requirement 31.6 names', () => {
    expect(registry.categories.loading).toEqual([
      'waveform-loader',
      'apple-equalizer',
      'apple-sound-wave',
      'siri-wave',
      'wave-physics-loader',
      'symmetric-wave',
      'fluid-bars',
      'spring-bars',
    ]);
    expect(componentsInCategory('loading')[0]?.amicroComponent).toBe('waveform-loader');
  });
});

describe('Requirements 31.2, 31.3 — the registry is named and pinned', () => {
  const components = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'components.json'), 'utf8'),
  ) as { registries?: Record<string, { url?: string; version?: string }> };

  it('registers the @amicro namespace in components.json', () => {
    expect(components.registries).toHaveProperty('@amicro');
  });

  it('pins it to a version tag rather than a moving reference', () => {
    const pin = components.registries?.['@amicro']?.version ?? '';
    expect(pin).toMatch(/^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/);
    expect(pin).not.toBe('latest');
    // The vendored listing records the same pin, so the two cannot drift.
    expect(registry.version).toBe(pin);
  });
});

describe('the classification lookup', () => {
  it('finds a known component and reports nothing for an unknown one', () => {
    expect(classificationOf('WaveformLoader')?.purpose).toBe('state_transfer');
    expect(classificationOf('TextReveal')?.purpose).toBe('decorative');
    expect(classificationOf('NotAComponent')).toBeUndefined();
  });

  it('names an unclassified component when asked', () => {
    expect(unclassifiedComponents(['WaveformLoader', 'Rogue'])).toEqual(['Rogue']);
  });
});
