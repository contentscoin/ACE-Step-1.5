import { describe, expect, it } from 'vitest';

import { projectsEquivalent } from '../../../domain/timeline/equivalence';
import { clipPlayLengthMs } from '../../../domain/timeline/project';
import { isGenerationError } from '../../../services/generation/errors';
import { createTimelineService } from '../../../services/timeline/timeline-service';
import { createMutableClock } from '../../support/mutable-clock';
import {
  assetState,
  fixedAssetCatalogue,
  inMemoryTimelineStore,
} from '../../support/timeline-harness';

/**
 * `Timeline_Service` end to end against in-memory ports.
 *
 * No PostgreSQL, Redis or broker is reachable here, which is why `TimelineProjectStore` and
 * `TimelineAssetCatalogue` are interfaces — see `services/timeline/ports.ts`.
 *
 * What this file covers that the domain suites cannot: ownership, the asset lookup that supplies a
 * clip's source duration, Requirement 28.36's unreferenceable-clip list, and the ordering of
 * validate → record → save.
 */

function harness(options: { readonly deletedAssets?: readonly string[] } = {}) {
  const clock = createMutableClock(new Date('2025-01-01T00:00:00Z'));
  const store = inMemoryTimelineStore();
  const deleted = new Set(options.deletedAssets ?? []);
  const assets = fixedAssetCatalogue([
    assetState('asset-0', 10_000, { isDeleted: deleted.has('asset-0') }),
    assetState('asset-1', 4_000, { isDeleted: deleted.has('asset-1') }),
  ]);

  let counter = 0;
  const service = createTimelineService({
    store,
    assets,
    clock,
    generateId: () => `id-${String((counter += 1))}`,
  });

  return { service, store, clock };
}

async function expectRejection(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(isGenerationError(error)).toBe(true);
    if (!isGenerationError(error)) return;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('project CRUD (Requirements 28.1, 28.39)', () => {
  it('creates a project with an empty clip list and 32 default tracks', async () => {
    const { service } = harness();
    const created = await service.createProject({
      ownerId: 'owner-0',
      name: 'Scene 1',
      description: 'kitchen',
      tempoBpm: 120,
      timeSignature: 4,
    });

    expect(created.project.clips).toEqual([]);
    expect(created.project.tracks).toHaveLength(32);
    expect(created.project.tracks[0]).toEqual({
      volumeDb: 0,
      pan: 0,
      muted: false,
      solo: false,
    });
    expect(created.history.undoable).toEqual([]);
  });

  it('allows a project with no tempo and no time signature', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    expect(created.project.tempoBpm).toBeNull();
    expect(created.project.timeSignature).toBeNull();
  });

  it('refuses a tempo outside 30–300 and a signature outside 2/3/4/6', async () => {
    const { service } = harness();
    await expectRejection(
      () => service.createProject({ ownerId: 'o', name: 'x', tempoBpm: 29 }),
      'timeline_project_invalid',
    );
    await expectRejection(
      () => service.createProject({ ownerId: 'o', name: 'x', timeSignature: 5 }),
      'timeline_project_invalid',
    );
    await expectRejection(
      () => service.createProject({ ownerId: 'o', name: '' }),
      'timeline_project_invalid',
    );
  });

  it('reports another account\'s project as forbidden, not missing', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await expectRejection(
      () => service.readProject('someone-else', created.project.id),
      'timeline_project_forbidden',
    );
    await expectRejection(
      () => service.readProject('owner-0', 'no-such-project'),
      'timeline_project_not_found',
    );
  });

  it('renames without touching the undo history', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await service.addClip('owner-0', created.project.id, { assetId: 'asset-0', track: 0 });
    const renamed = await service.updateProject('owner-0', created.project.id, { name: 'Scene 2' });

    expect(renamed.project.name).toBe('Scene 2');
    // Requirement 28.23's twelve are clip- and track-level; a rename is not one of them.
    expect(renamed.history.undoable).toHaveLength(1);
    expect(renamed.history.undoable[0]?.type).toBe('clip_add');
  });

  it('deletes a project and refuses to read it afterwards', async () => {
    const { service, store } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await service.deleteProject('owner-0', created.project.id);
    expect(store.size()).toBe(0);
    await expectRejection(
      () => service.readProject('owner-0', created.project.id),
      'timeline_project_not_found',
    );
  });

  it('lists only the caller\'s projects', async () => {
    const { service } = harness();
    await service.createProject({ ownerId: 'owner-0', name: 'A' });
    await service.createProject({ ownerId: 'owner-1', name: 'B' });
    expect(await service.listProjects('owner-0')).toHaveLength(1);
  });
});

describe('adding clips takes the source duration from the catalogue', () => {
  it('uses the asset\'s duration rather than anything the caller supplies', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    const result = await service.addClip('owner-0', created.project.id, {
      assetId: 'asset-1',
      track: 0,
    });

    expect(result.record.project.clips[0]?.sourceDurationMs).toBe(4_000);
    expect(clipPlayLengthMs(result.record.project.clips[0]!)).toBe(4_000);
  });

  it('refuses a clip against an unknown or deleted asset', async () => {
    const { service } = harness({ deletedAssets: ['asset-1'] });
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await expectRejection(
      () => service.addClip('owner-0', created.project.id, { assetId: 'nope', track: 0 }),
      'timeline_asset_not_found',
    );
    await expectRejection(
      () => service.addClip('owner-0', created.project.id, { assetId: 'asset-1', track: 0 }),
      'timeline_asset_not_found',
    );
  });

  it('reports a collision as a 409 carrying the overlap', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await service.addClip('owner-0', created.project.id, {
      assetId: 'asset-0',
      track: 0,
      startTimeMs: 0,
    });

    try {
      await service.addClip('owner-0', created.project.id, {
        assetId: 'asset-0',
        track: 0,
        startTimeMs: 5_000,
      });
      throw new Error('expected a collision');
    } catch (error) {
      if (!isGenerationError(error)) throw error;
      expect(error.code).toBe('timeline_clip_overlap');
      expect(error.statusCode).toBe(409);
      expect(error.details['overlaps']).toBeDefined();
    }
  });
});

describe('the twelve operations all record history, and undo/redo work through the store', () => {
  it('undoes and redoes a clip gain change', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    const added = await service.addClip('owner-0', created.project.id, {
      assetId: 'asset-0',
      track: 0,
    });
    const clipId = added.record.project.clips[0]?.id;
    if (clipId === undefined) throw new Error('no clip');

    const before = added.record.project;
    const changed = await service.setClipGain('owner-0', created.project.id, clipId, -12);
    expect(changed.record.project.clips[0]?.gainDb).toBe(-12);

    const undone = await service.undo('owner-0', created.project.id);
    expect(projectsEquivalent(before, undone.record.project)).toBe(true);

    const redone = await service.redo('owner-0', created.project.id);
    expect(projectsEquivalent(changed.record.project, redone.record.project)).toBe(true);
  });

  it('refuses an undo with nothing to undo and leaves the project alone', async () => {
    const { service, store } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    const before = await store.load(created.project.id);

    await expectRejection(
      () => service.undo('owner-0', created.project.id),
      'timeline_history_empty',
    );
    expect(await store.load(created.project.id)).toEqual(before);
  });

  it('does not record a rejected edit', async () => {
    const { service, store } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    const added = await service.addClip('owner-0', created.project.id, {
      assetId: 'asset-0',
      track: 0,
    });
    const clipId = added.record.project.clips[0]?.id ?? '';

    await expectRejection(
      () => service.setClipGain('owner-0', created.project.id, clipId, 99),
      'timeline_edit_rejected',
    );
    // Requirement 28.22 records only successful operations, so the history still holds one entry.
    expect((await store.load(created.project.id))?.history.undoable).toHaveLength(1);
  });

  it('runs each of track volume, pan and solo through the history', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await service.setTrackVolume('owner-0', created.project.id, 3, -12);
    await service.setTrackPan('owner-0', created.project.id, 3, -0.5);
    const soloed = await service.toggleTrackSolo('owner-0', created.project.id, 3);

    expect(soloed.record.project.tracks[3]).toEqual({
      volumeDb: -12,
      pan: -0.5,
      muted: false,
      solo: true,
    });
    expect(soloed.record.history.undoable.map((c) => c.type)).toEqual([
      'track_volume',
      'track_pan',
      'track_solo',
    ]);
  });

  it('splits, duplicates and deletes with generated identifiers', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    const added = await service.addClip('owner-0', created.project.id, {
      assetId: 'asset-0',
      track: 0,
      startTimeMs: 0,
    });
    const clipId = added.record.project.clips[0]?.id ?? '';

    const split = await service.splitClip('owner-0', created.project.id, { clipId, atMs: 4_000 });
    expect(split.record.project.clips).toHaveLength(2);
    const [left, right] = split.record.project.clips;
    expect(clipPlayLengthMs(left!) + clipPlayLengthMs(right!)).toBe(10_000);

    const duplicated = await service.duplicateClip(
      'owner-0',
      created.project.id,
      right?.id ?? '',
    );
    expect(duplicated.record.project.clips).toHaveLength(3);

    const deleted = await service.deleteClip('owner-0', created.project.id, left?.id ?? '');
    expect(deleted.record.project.clips).toHaveLength(2);
  });

  it('updates the modified timestamp on every edit and keeps the created one', async () => {
    const { service, clock } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    clock.advanceSeconds(5);
    const edited = await service.setTrackVolume('owner-0', created.project.id, 0, -3);

    // Both are excluded from Requirement 28.32's equivalence relation, which is why they can move
    // freely without any round trip noticing.
    expect(edited.record.createdAtMs).toBe(created.createdAtMs);
    expect(edited.record.updatedAtMs).toBeGreaterThan(created.updatedAtMs);
  });
});

describe('Requirement 28.36: a clip whose asset was marked deleted', () => {
  it('is listed as unreferenceable, and the project still reads', async () => {
    const { service, store } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    const added = await service.addClip('owner-0', created.project.id, {
      assetId: 'asset-0',
      track: 0,
    });
    const clipId = added.record.project.clips[0]?.id ?? '';

    // The asset is deleted after the clip exists, which is exactly the situation 28.36 describes.
    const withDeleted = createTimelineService({
      store,
      assets: fixedAssetCatalogue([assetState('asset-0', 10_000, { isDeleted: true })]),
    });

    const read = await withDeleted.readProject('owner-0', created.project.id);
    expect(read.unreferenceableClipIds).toEqual([clipId]);
    expect(read.record.project.clips).toHaveLength(1);
  });

  it('lists nothing when every asset is present', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await service.addClip('owner-0', created.project.id, { assetId: 'asset-0', track: 0 });
    const read = await service.readProject('owner-0', created.project.id);
    expect(read.unreferenceableClipIds).toEqual([]);
  });
});

describe('export and import (Requirements 28.30, 28.31, 28.34)', () => {
  it('exports a document that imports back to an equivalent clip list', async () => {
    const { service } = harness();
    const created = await service.createProject({
      ownerId: 'owner-0',
      name: 'Scene',
      tempoBpm: 90,
      timeSignature: 3,
    });
    await service.addClip('owner-0', created.project.id, { assetId: 'asset-0', track: 0 });
    await service.addClip('owner-0', created.project.id, { assetId: 'asset-1', track: 2 });

    const document = await service.exportProject('owner-0', created.project.id);
    const imported = await service.importProject('owner-0', document);

    // A new project id, since an import is a new project rather than an overwrite.
    expect(imported.project.id).not.toBe(created.project.id);
    expect(imported.project.clips.map((c) => c.assetId)).toEqual(['asset-0', 'asset-1']);
    expect(imported.project.tempoBpm).toBe(90);
    expect(imported.history.undoable).toEqual([]);
  });

  it('refuses a document referencing an asset that does not exist', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await service.addClip('owner-0', created.project.id, { assetId: 'asset-0', track: 0 });
    const document = await service.exportProject('owner-0', created.project.id);

    const strangerService = createTimelineService({
      store: inMemoryTimelineStore(),
      assets: fixedAssetCatalogue([]),
    });
    await expectRejection(
      () => strangerService.importProject('owner-0', document),
      'timeline_project_document_invalid',
    );
  });

  it('refuses a document that is not JSON', async () => {
    const { service } = harness();
    await expectRejection(
      () => service.importProject('owner-0', '{oops'),
      'timeline_project_document_invalid',
    );
  });

  it('exports an indented document on request', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    const pretty = await service.exportProject('owner-0', created.project.id, { pretty: true });
    expect(pretty).toContain('\n');
  });
});

describe('render targets and the playhead through the service', () => {
  it('excludes a muted track\'s clips', async () => {
    const { service } = harness();
    const created = await service.createProject({ ownerId: 'owner-0', name: 'Scene' });
    await service.addClip('owner-0', created.project.id, { assetId: 'asset-0', track: 0 });
    await service.toggleClipMute(
      'owner-0',
      created.project.id,
      (await service.readProject('owner-0', created.project.id)).record.project.clips[0]?.id ?? '',
    );

    const targets = await service.renderTargets('owner-0', created.project.id);
    expect(targets.clips).toEqual([]);
    expect(targets.excluded[0]?.reason).toBe('clip_muted');
  });

  it('gives every track the same playhead position', () => {
    const { service } = harness();
    const position = service.seekPlayhead(4_321);
    expect(new Set(position.trackPositionsMs).size).toBe(1);
  });
});
