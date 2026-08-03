/**
 * The Semantic_Cue table (Requirements 32.1, 32.10, 32.16, 32.20).
 *
 * The table is data, so these are assertions about data — but they are the assertions that stop it
 * degrading. "78 entries" is the clause's own number and is checked rather than believed; "every
 * entry names at least one element and one sentence" is the part a later contributor would be
 * tempted to leave blank for a cue whose screen does not exist yet.
 */

import { describe, expect, it } from 'vitest';

import {
  CUE_COUNT,
  CUE_SEVERITIES,
  LOOP_CUES,
  SEMANTIC_CUES,
  SEMANTIC_CUE_NAMES,
  cueDefinition,
  isSemanticCue,
} from '../../src/sound/cues';
import { SEVERITY_PRESENTATION } from '../../src/components/sound/CueAnnouncer';
import { SOUND_PACKS, SOUND_PACK_IDS } from '../../src/sound/packs';
import { OPEN_SOURCE_NOTICES } from '../../src/notices/open-source';

/** Routes `app/router.tsx` and `App.tsx` actually serve, plus the ones Phase 8 will add. */
const KNOWN_ROUTES = new Set([
  'generate',
  'library',
  'asset',
  'timeline',
  'mastering',
  'explore',
  'system',
  'account',
  'voice',
  'persona',
]);

describe('the 78 Semantic_Cues (Req 32.1)', () => {
  it('has exactly 78 entries', () => {
    expect(SEMANTIC_CUE_NAMES).toHaveLength(CUE_COUNT);
    expect(Object.keys(SEMANTIC_CUES)).toHaveLength(78);
  });

  it('gives every cue at least one screen element and one status sentence', () => {
    for (const cue of SEMANTIC_CUE_NAMES) {
      const definition = cueDefinition(cue);
      expect(definition.elements.length).toBeGreaterThanOrEqual(1);
      expect(definition.status.trim().length).toBeGreaterThan(0);
      // A sentence, not a label: the clause says 상태를 서술하는 텍스트 문구.
      expect(definition.status).toMatch(/[.。]$/);
    }
  });

  it('names only routes the product has', () => {
    for (const cue of SEMANTIC_CUE_NAMES) {
      for (const element of cueDefinition(cue).elements) {
        expect(element).toMatch(/^[a-z]+:[a-z][a-z0-9-]*$/);
        expect(KNOWN_ROUTES).toContain(element.split(':')[0]);
      }
    }
  });

  it('has no duplicate cue names and no duplicate status sentences', () => {
    expect(new Set(SEMANTIC_CUE_NAMES).size).toBe(CUE_COUNT);
    // Two cues with the same sentence would make Requirement 32.15's display ambiguous: the user
    // would see the same words for two different states.
    const sentences = SEMANTIC_CUE_NAMES.map((cue) => cueDefinition(cue).status);
    expect(new Set(sentences).size).toBe(CUE_COUNT);
  });

  it('recognises its own names and nothing else', () => {
    expect(isSemanticCue('generation.succeeded')).toBe(true);
    expect(isSemanticCue('generation.definitelyNot')).toBe(false);
    expect(isSemanticCue(42)).toBe(false);
    // Not fooled by `Object.prototype` members, which a bare `in` check would accept.
    expect(isSemanticCue('toString')).toBe(false);
  });

  it('marks the waiting states as loops and nothing else', () => {
    expect(LOOP_CUES.length).toBeGreaterThan(0);
    for (const cue of LOOP_CUES) expect(cueDefinition(cue).kind).toBe('loop');
    // Every loop describes a state the user waits inside; spot-checking the ones that must be.
    expect(LOOP_CUES).toContain('generation.running');
    expect(LOOP_CUES).toContain('persona.training.running');
    expect(LOOP_CUES).not.toContain('generation.succeeded');
  });
});

describe('non-colour channels (Req 32.16)', () => {
  it('gives success, warning and error distinct shapes and distinct labels', () => {
    const stated = ['success', 'warning', 'error'] as const;
    const shapes = stated.map((severity) => SEVERITY_PRESENTATION[severity].shape);
    const labels = stated.map((severity) => SEVERITY_PRESENTATION[severity].label);
    // Two channels, each pairwise distinct — a shared shape would leave colour carrying it.
    expect(new Set(shapes).size).toBe(stated.length);
    expect(new Set(labels).size).toBe(stated.length);
  });

  it('covers every severity the table can produce', () => {
    for (const severity of CUE_SEVERITIES) {
      expect(SEVERITY_PRESENTATION[severity].shape.length).toBeGreaterThan(0);
      expect(SEVERITY_PRESENTATION[severity].label.length).toBeGreaterThan(0);
    }
  });
});

describe('sound packs (Reqs 32.10, 32.20)', () => {
  it('offers at least two', () => {
    expect(SOUND_PACK_IDS.length).toBeGreaterThanOrEqual(2);
  });

  it('voices every cue in every pack, so a pack switch can never lack an asset', () => {
    for (const packId of SOUND_PACK_IDS) {
      for (const cue of SEMANTIC_CUE_NAMES) {
        const voicing = SOUND_PACKS[packId].voicing(cue);
        expect(voicing.frequencyHz).toBeGreaterThan(0);
        expect(voicing.durationMs).toBeGreaterThan(0);
        expect(voicing.peak).toBeGreaterThan(0);
        expect(voicing.peak).toBeLessThanOrEqual(1);
      }
    }
  });

  it('makes the two packs audibly different rather than only louder', () => {
    const soft = SOUND_PACKS.soft.voicing('generation.succeeded');
    const crisp = SOUND_PACKS.crisp.voicing('generation.succeeded');
    expect(soft.wave).not.toBe(crisp.wave);
    expect(soft.frequencyHz).not.toBe(crisp.frequencyHz);
  });

  it('puts the interface sounds licence on the open-source notice screen (Req 32.20)', () => {
    const notice = OPEN_SOURCE_NOTICES.find((entry) => entry.name.includes('인터페이스 사운드'));
    expect(notice).toBeDefined();
    expect(notice?.license.length).toBeGreaterThan(0);
  });
});
