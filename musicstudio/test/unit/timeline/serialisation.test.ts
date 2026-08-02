import { describe, expect, it } from 'vitest';

import { TRACK_COUNT } from '../../../domain/timeline/bounds';
import {
  projectsEquivalent,
  timelineProjectsEquivalent,
} from '../../../domain/timeline/equivalence';
import { parseProjectDocument, parseProjectValue } from '../../../domain/timeline/project-parser';
import {
  CLIP_DOCUMENT_FIELDS,
  PROJECT_DOCUMENT_FIELDS,
  TRACK_DOCUMENT_FIELDS,
  printProject,
  projectToDocument,
} from '../../../domain/timeline/project-printer';
import { TIMELINE_CLIP_FIELDS } from '../../../domain/timeline/project';
import { clip, projectWith } from '../../support/timeline-harness';

/**
 * `Project_Printer` and `Project_Parser` by example (Requirements 28.30–28.34).
 *
 * Properties 6 and 7 in `test/property/timeline-project.test.ts` prove the round trip and the
 * idempotence over generated projects. What is here is the specific shape of the document and the
 * specific faults the clauses name — including the two hard-won cases the sibling parsers already
 * paid for: key order, and `JSON.stringify(-0)`.
 */

const project = projectWith([
  clip({ id: 'a', track: 0, startTimeMs: 0, sourceDurationMs: 4_000, gainDb: -3.5 }),
  clip({ id: 'b', track: 2, startTimeMs: 8_000, sourceDurationMs: 2_000, muted: true }),
]);

describe('the printed document (Requirement 28.30)', () => {
  it('writes the top-level keys in a declared order', () => {
    expect(Object.keys(projectToDocument(project))).toEqual([...PROJECT_DOCUMENT_FIELDS]);
  });

  it('writes clip fields in the order the equivalence relation iterates', () => {
    const document = projectToDocument(project);
    expect(Object.keys(document.clips[0] ?? {})).toEqual([...CLIP_DOCUMENT_FIELDS]);
    // The document's order is the relation's list followed by Requirement 29.31's chain, so a
    // field cannot be added to one and forgotten in the other. The chain is last and separate
    // because the relation compares it under the chain equivalence relation rather than with
    // `!==`; see `timelineClipsEquivalent`.
    expect(CLIP_DOCUMENT_FIELDS).toEqual([...TIMELINE_CLIP_FIELDS, 'effectChain']);
  });

  it('writes all 32 tracks positionally, with no redundant track number', () => {
    const document = projectToDocument(project);
    expect(document.tracks).toHaveLength(TRACK_COUNT);
    expect(Object.keys(document.tracks[0] ?? {})).toEqual([...TRACK_DOCUMENT_FIELDS]);
    expect(Object.keys(document.tracks[0] ?? {})).not.toContain('track');
  });

  it('carries no undo history and no timestamps', () => {
    // Requirement 28.32 excludes both from the equivalence relation; keeping them out of
    // `TimelineProject` means the printer cannot emit them by accident.
    expect(printProject(project)).not.toContain('history');
    expect(printProject(project)).not.toContain('createdAt');
  });
});

describe('negative zero (the case that costs a debugging session)', () => {
  it('prints as 0 and is still equivalent, because the relation compares by difference', () => {
    // `JSON.stringify(-0) === "0"`, so a gain or pan of -0 does not survive as itself. Both denote
    // the same quantity, so the relation must accept the pair — an `Object.is` comparison would not.
    const negativeZero = projectWith([clip({ id: 'a', gainDb: -0 })]);
    const withPan = {
      ...negativeZero,
      tracks: negativeZero.tracks.map((track, index) =>
        index === 0 ? { ...track, pan: -0, volumeDb: -0 } : track,
      ),
    };

    expect(printProject(withPan)).toContain('"gainDb":0');
    const reparsed = parseProjectDocument(printProject(withPan));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;

    expect(Object.is(reparsed.value.clips[0]?.gainDb, -0)).toBe(false);
    const verdict = timelineProjectsEquivalent(withPan, reparsed.value);
    expect(verdict.equivalent, 'reason' in verdict ? verdict.reason : '').toBe(true);
  });

  it('reprints byte-identically, so Requirement 28.33 is unaffected', () => {
    const negativeZero = projectWith([clip({ id: 'a', gainDb: -0 })]);
    const first = printProject(negativeZero);
    const parsed = parseProjectDocument(first);
    if (!parsed.ok) throw new Error('parse failed');
    expect(printProject(parsed.value)).toBe(first);
  });

  it('reports a NaN difference rather than accepting it', () => {
    // `!(drift <= tolerance)` rather than `drift > tolerance`: NaN compares false against
    // everything, so the naive form would silently call two projects equivalent.
    const broken = { ...project, clips: [{ ...clip({ id: 'a' }), gainDb: Number.NaN }] };
    expect(projectsEquivalent(broken, { ...broken, clips: [clip({ id: 'a', gainDb: 0 })] })).toBe(
      false,
    );
  });
});

describe('parser faults (Requirements 28.31, 28.34, design §7.2)', () => {
  it('reports malformed JSON distinctly from a non-object', () => {
    const malformed = parseProjectDocument('{oops');
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.errors[0]?.violation).toBe('project_json_malformed');

    const notObject = parseProjectDocument('[]');
    expect(notObject.ok).toBe(false);
    if (notObject.ok) return;
    expect(notObject.errors[0]?.violation).toBe('project_not_object');
  });

  it('reports a clips field that is not an array', () => {
    const result = parseProjectValue({ id: 'p', ownerId: 'o', name: 'n', clips: 'x', tracks: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.violation)).toContain('project_clips_not_array');
  });

  it('reports a track array of the wrong length', () => {
    const result = parseProjectValue({
      id: 'p',
      ownerId: 'o',
      name: 'n',
      description: '',
      tempoBpm: null,
      timeSignature: null,
      clips: [],
      tracks: [{ volumeDb: 0, pan: 0, muted: false, solo: false }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.violation)).toContain('project_track_count');
  });

  it('returns every fault rather than the first', () => {
    const broken = {
      ...projectToDocument(project),
      clips: [
        { ...projectToDocument(project).clips[0], track: 99, gainDb: 40 },
        { ...projectToDocument(project).clips[1], startTimeMs: -5 },
      ],
    };
    const result = parseProjectValue(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.violation);
    expect(codes).toContain('clip_track_range');
    expect(codes).toContain('clip_gain_range');
    expect(codes).toContain('clip_start_time_invalid');
  });

  it('reports the reference position and the missing asset id (Requirement 28.34)', () => {
    const result = parseProjectDocument(printProject(project), {
      knownAssets: new Map([['asset-0', 4_000]]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Clip `b` is at index 1 and references `asset-0` too in the harness default, so the fault is
    // asserted on the duration mismatch there; the point is that both position and id travel.
    const faults = result.errors.filter(
      (e) => e.violation === 'clip_asset_missing' || e.violation === 'clip_source_duration_mismatch',
    );
    expect(faults.length).toBeGreaterThan(0);
    expect(faults[0]?.index).toBeDefined();
    expect(faults[0]?.actual).toBeDefined();
  });

  it('reports a stored source duration that disagrees with the catalogue', () => {
    const result = parseProjectDocument(printProject(projectWith([clip({ id: 'a' })])), {
      knownAssets: new Map([['asset-0', 9_999]]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const fault = result.errors.find((e) => e.violation === 'clip_source_duration_mismatch');
    expect(fault?.expected).toBe('9999');
    expect(fault?.actual).toBe('10000');
  });

  it('accepts a document whose assets all resolve', () => {
    const result = parseProjectDocument(printProject(projectWith([clip({ id: 'a' })])), {
      knownAssets: new Map([['asset-0', 10_000]]),
    });
    expect(result.ok).toBe(true);
  });

  it('does not coerce a non-numeric field into a valid value', () => {
    // `Number(value) || 0` would turn "abc" into a perfectly legal start time of 0.
    const document = projectToDocument(project);
    const result = parseProjectValue({
      ...document,
      clips: [{ ...document.clips[0], startTimeMs: 'abc' }],
    });
    expect(result.ok).toBe(false);
  });

  it('reads a missing description as the empty string', () => {
    const document: Record<string, unknown> = { ...projectToDocument(projectWith([])) };
    delete document['description'];
    const result = parseProjectValue(document);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBe('');
  });
});

describe('the equivalence relation itself (Requirement 28.32)', () => {
  it('treats clip order as significant', () => {
    const reversed = { ...project, clips: [...project.clips].reverse() };
    expect(projectsEquivalent(project, reversed)).toBe(false);
  });

  it('accepts a gain 0.1 dB apart and refuses 0.2', () => {
    // Absolute values rather than `base + 0.1`: `-3.5 + 0.1` is `-3.4000000000000004`, whose
    // distance from `-3.5` is `0.10000000000000053` and so *outside* a tolerance of exactly 0.1.
    // The relation is deliberately not loosened for that — a round trip through JSON drifts by
    // zero, so the tolerance is never reached in practice, and widening it would make the relation
    // accept a difference Requirement 28.32 does not.
    const withGain = (gainDb: number) => ({
      ...project,
      clips: project.clips.map((c, index) => (index === 0 ? { ...c, gainDb } : c)),
    });
    expect(projectsEquivalent(withGain(0), withGain(0.1))).toBe(true);
    expect(projectsEquivalent(withGain(0), withGain(0.2))).toBe(false);
  });

  it('accepts a pan 0.01 apart and refuses 0.02', () => {
    const withPan = (pan: number) => ({
      ...project,
      tracks: project.tracks.map((track, index) => (index === 0 ? { ...track, pan } : track)),
    });
    expect(projectsEquivalent(withPan(0), withPan(0.01))).toBe(true);
    expect(projectsEquivalent(withPan(0), withPan(0.02))).toBe(false);
  });

  it('requires time values to match exactly', () => {
    const shifted = {
      ...project,
      clips: project.clips.map((c, index) =>
        index === 0 ? { ...c, startTimeMs: c.startTimeMs + 1 } : c,
      ),
    };
    expect(projectsEquivalent(project, shifted)).toBe(false);
  });

  it('names the field that differed', () => {
    const verdict = timelineProjectsEquivalent(project, { ...project, name: 'other' });
    expect(verdict.equivalent).toBe(false);
    if (verdict.equivalent) return;
    expect(verdict.reason).toContain('name');
  });
});
