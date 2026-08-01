import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PROJECT_GAIN_TOLERANCE_DB, PROJECT_PAN_TOLERANCE } from '../../domain/timeline/bounds';
import {
  equivalenceReason,
  timelineProjectsEquivalent,
} from '../../domain/timeline/equivalence';
import { parseProjectDocument } from '../../domain/timeline/project-parser';
import { printProject, printProjectPretty } from '../../domain/timeline/project-printer';
import { isValidTimelineProject } from '../../domain/timeline/project';
import { validProject } from '../support/timeline-harness';

/**
 * Properties 6 and 7 of design §10 — the `Timeline_Project` round trip and its idempotence.
 *
 * Task 4.1 owns Properties 6, 7, 16 and 17 (tasks.md §9.2's ownership table); 6 and 7 are here and
 * 16 and 17 are in `timeline-undo-redo.test.ts`. Anything else asserted in this file is labelled
 * **unnumbered** so task 9.2's audit does not miscount it, following the convention
 * `test/property/cue-pack-manifest.test.ts` uses.
 *
 * The generator is `validProject` from `test/support/timeline-harness.ts`, which *constructs*
 * valid layouts rather than filtering for them — see that file's header. Both properties are
 * quantified over valid structures (28.32: "유효한 Timeline_Project"; 28.33: "파싱에 성공한 JSON
 * 프로젝트 문서"), so a generator that produced overlapping clips would spend every run on inputs
 * the properties say nothing about.
 */

describe('Feature: ai-music-generation-service, Property 6: Timeline_Project round-trip', () => {
  /**
   * Feature: ai-music-generation-service, Property 6: For any valid `Timeline_Project`, serialising
   * it with `Project_Printer` and deserialising the result with `Project_Parser` yields a project
   * equivalent to the original under the project equivalence relation.
   *
   * **Validates: Requirements 28.32**
   */
  it('prints and re-parses to an equivalent project', async () => {
    await fc.assert(
      fc.asyncProperty(validProject(), async (project) => {
        // The property is about *valid* projects, so a generator that stopped producing them
        // would silently weaken it rather than fail.
        expect(isValidTimelineProject(project)).toBe(true);

        const document = printProject(project);
        const reparsed = parseProjectDocument(document);

        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;

        const verdict = timelineProjectsEquivalent(project, reparsed.value);
        // The reason is asserted on, not just the boolean: a failure that says only `false` costs
        // a debugging session.
        expect(verdict.equivalent, equivalenceReason(verdict)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * The same property against the indented document.
   *
   * Unnumbered — it is Property 6 over the other printer, kept because the two are separate
   * functions and a change to one must not silently break the round trip of the other.
   */
  it('round-trips the indented document too', async () => {
    await fc.assert(
      fc.asyncProperty(validProject(), async (project) => {
        const reparsed = parseProjectDocument(printProjectPretty(project));
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;
        expect(timelineProjectsEquivalent(project, reparsed.value).equivalent).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe('Feature: ai-music-generation-service, Property 7: Timeline_Project idempotence', () => {
  /**
   * Feature: ai-music-generation-service, Property 7: For any JSON project document that parses
   * successfully, parsing then printing then re-parsing yields a project equivalent to the first
   * parse under the project equivalence relation, and the two printed documents are byte-identical.
   *
   * **Validates: Requirements 28.33**
   */
  it('parse → print → parse equals the first parse, and the documents are byte-identical', async () => {
    await fc.assert(
      fc.asyncProperty(validProject(), async (project) => {
        // The *document* is 28.33's subject, so the property starts from one rather than from a
        // structure — which is what makes it a different claim from Property 6.
        const first = parseProjectDocument(printProject(project));
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        const printedOnce = printProject(first.value);
        const second = parseProjectDocument(printedOnce);
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        const printedTwice = printProject(second.value);

        const verdict = timelineProjectsEquivalent(first.value, second.value);
        expect(verdict.equivalent, equivalenceReason(verdict)).toBe(true);
        // Byte-identity, which is what Requirement 28.33 asks for and is stronger than equivalence.
        expect(printedTwice).toBe(printedOnce);
      }),
      { numRuns: 200 },
    );
  });
});

describe('unnumbered Timeline_Project serialisation invariants', () => {
  /**
   * Unnumbered. Design §10 numbers no property for key order, but Requirement 28.33's byte-identity
   * depends on it entirely: the printer must not inherit the insertion order of the object it was
   * handed. Same regression `test/property/cue-pack-manifest.test.ts` guards for the manifest.
   */
  it('prints the same bytes for a project whose keys were built in another order', async () => {
    await fc.assert(
      fc.asyncProperty(validProject({ minClips: 1 }), async (project) => {
        const shuffled = {
          // Deliberately the reverse of the printer's declared field order.
          tracks: project.tracks.map((track) => ({
            solo: track.solo,
            muted: track.muted,
            pan: track.pan,
            volumeDb: track.volumeDb,
          })),
          clips: project.clips.map((clip) => ({
            // Requirement 29.31's chain, with the *parameter* keys of every item reversed too.
            // `chainToDocument` re-orders them from the registry, so a project holding a chain
            // built in another key order still reprints byte for byte — which is what Requirement
            // 28.33 needs once a clip can carry a chain, and it would not hold if the printer
            // spread the chain instead of going through `chainToDocument`.
            effectChain:
              clip.effectChain === null
                ? null
                : {
                    items: clip.effectChain.items.map((item) => ({
                      kind: item.kind,
                      parameters: Object.fromEntries(
                        Object.entries(item.parameters).reverse(),
                      ) as Record<string, number>,
                    })),
                  },
            muted: clip.muted,
            fadeOutMs: clip.fadeOutMs,
            fadeInMs: clip.fadeInMs,
            gainDb: clip.gainDb,
            trimEndMs: clip.trimEndMs,
            trimStartMs: clip.trimStartMs,
            track: clip.track,
            startTimeMs: clip.startTimeMs,
            sourceDurationMs: clip.sourceDurationMs,
            assetId: clip.assetId,
            id: clip.id,
          })),
          timeSignature: project.timeSignature,
          tempoBpm: project.tempoBpm,
          description: project.description,
          name: project.name,
          ownerId: project.ownerId,
          id: project.id,
        };

        expect(printProject(shuffled)).toBe(printProject(project));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Unnumbered. Requirement 28.32 requires times and identifiers to match *exactly*, so this pins
   * that the round trip really is exact for those rather than merely within the gain and pan
   * tolerances the relation also allows.
   *
   * Compared by absolute difference, never `toBe` or `Object.is`: `JSON.stringify(-0)` is `"0"`, so
   * a `-0` anywhere in the structure comes back as `+0` and an identity comparison would fail for
   * two numbers denoting the same quantity. See `domain/timeline/equivalence.ts`.
   */
  it('loses nothing from any time value or identifier', async () => {
    await fc.assert(
      fc.asyncProperty(validProject({ minClips: 1 }), async (project) => {
        const reparsed = parseProjectDocument(printProject(project));
        if (!reparsed.ok) throw new Error('a valid project failed to parse');

        for (const [index, clip] of project.clips.entries()) {
          const other = reparsed.value.clips[index];
          expect(other?.id).toBe(clip.id);
          expect(other?.assetId).toBe(clip.assetId);
          for (const field of [
            'startTimeMs',
            'trimStartMs',
            'trimEndMs',
            'sourceDurationMs',
            'fadeInMs',
            'fadeOutMs',
            'track',
          ] as const) {
            expect(Math.abs(clip[field] - (other?.[field] ?? NaN))).toBe(0);
          }
          expect(Math.abs(clip.gainDb - (other?.gainDb ?? NaN))).toBeLessThanOrEqual(
            PROJECT_GAIN_TOLERANCE_DB,
          );
        }

        for (const [track, settings] of project.tracks.entries()) {
          const other = reparsed.value.tracks[track];
          expect(Math.abs(settings.pan - (other?.pan ?? NaN))).toBeLessThanOrEqual(
            PROJECT_PAN_TOLERANCE,
          );
          expect(other?.muted).toBe(settings.muted);
          expect(other?.solo).toBe(settings.solo);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Unnumbered. Requirement 28.34's rule, as a property over every clip position: a document whose
   * asset is absent from the catalogue is refused, and the error carries the reference position and
   * the missing identifier.
   */
  it('rejects a document referencing an unknown asset, reporting position and id', async () => {
    await fc.assert(
      fc.asyncProperty(
        validProject({ minClips: 1, maxClips: 4 }),
        fc.nat(),
        async (project, pick) => {
          const index = pick % project.clips.length;
          const missing = project.clips[index]?.assetId;
          if (missing === undefined) return;

          // Everything except the chosen clip's asset resolves, so the only fault is 28.34's.
          const knownAssets = new Map(
            project.clips
              .filter((_clip, position) => position !== index)
              .map((clip) => [clip.assetId, clip.sourceDurationMs] as const),
          );
          knownAssets.delete(missing);

          const result = parseProjectDocument(printProject(project), { knownAssets });
          expect(result.ok).toBe(false);
          if (result.ok) return;

          const fault = result.errors.find(
            (error) => error.violation === 'clip_asset_missing' && error.actual === missing,
          );
          expect(fault).toBeDefined();
          // The clip that was singled out must be among the reported positions. Other clips may
          // share the same asset id, so the assertion is membership rather than equality.
          const positions = result.errors
            .filter((error) => error.violation === 'clip_asset_missing')
            .map((error) => error.index);
          expect(positions).toContain(index);
        },
      ),
      { numRuns: 100 },
    );
  });
});
