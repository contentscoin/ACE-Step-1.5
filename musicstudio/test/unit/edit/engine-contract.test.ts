import { describe, expect, it } from 'vitest';

import {
  ACE_DEFAULT_EDIT_MODEL_CATALOGUE,
  ACE_KNOWN_DIT_MODELS,
  aceEditModelCatalogueFrom,
  isAceTurboModelName,
} from '../../../adapters/ace/model-tasks';
import {
  ACE_EDIT_TASK_TYPE_BY_KIND,
  ACE_TASK_TYPES,
  ACE_TASK_TYPES_BASE,
  ACE_TASK_TYPES_TURBO,
  aceTaskTypeForEditKind,
  editKindsForTaskTypes,
} from '../../../adapters/ace/task-type';
import { DERIVATION_TYPES } from '../../../domain/derivation-type';
import {
  assetKindForEditKind,
  derivationTypeForEditKind,
  EDIT_KINDS,
} from '../../../domain/edit/edit-kind';
import {
  modelsSupportingEditKind,
  supportsEditKind,
  unsupportedEditKinds,
} from '../../../domain/edit/model-support';
import { TRACK_NAMES, TRACK_NAME_COUNT } from '../../../domain/edit/track-name';

/**
 * The engine facts Requirement 7 quotes, pinned.
 *
 * Everything asserted here is a transcription from `acestep/constants.py` or design
 * §3.6, which the product layer mirrors because it may not import the engine (design
 * §1.4.4). If the engine's constants change, these are the tests that notice.
 */

describe('Requirement 7.6 — the engine supports exactly twelve track kinds', () => {
  it('names twelve, with no duplicates', () => {
    expect(TRACK_NAMES).toHaveLength(TRACK_NAME_COUNT);
    expect(new Set(TRACK_NAMES).size).toBe(TRACK_NAME_COUNT);
  });

  it('matches `TRACK_NAMES` in `acestep/constants.py`, in order', () => {
    expect([...TRACK_NAMES]).toEqual([
      'woodwinds',
      'brass',
      'fx',
      'synth',
      'strings',
      'percussion',
      'keyboard',
      'guitar',
      'bass',
      'drums',
      'backing_vocals',
      'vocals',
    ]);
  });
});

describe('the five Edit_Task kinds map onto the engine and the data model', () => {
  it('maps each kind to the `task_type` its criterion names', () => {
    expect(ACE_EDIT_TASK_TYPE_BY_KIND).toEqual({
      cover: 'cover',
      repaint: 'repaint',
      extract: 'extract',
      lego: 'lego',
      complete: 'complete',
    });
    for (const kind of EDIT_KINDS) {
      expect(ACE_TASK_TYPES).toContain(aceTaskTypeForEditKind(kind));
    }
  });

  it('records each kind as a `derivation_type` the enum already has (Requirement 7.12)', () => {
    for (const kind of EDIT_KINDS) {
      expect(DERIVATION_TYPES).toContain(derivationTypeForEditKind(kind));
    }
  });

  it('yields `stem` for extract and `song` for the rest (design §3.6)', () => {
    expect(assetKindForEditKind('extract')).toBe('stem');
    for (const kind of EDIT_KINDS.filter((entry) => entry !== 'extract')) {
      expect(assetKindForEditKind(kind)).toBe('song');
    }
  });

  it('leaves `text2music` and `cover-nofsq` out of the edit mapping', () => {
    const mapped = Object.values(ACE_EDIT_TASK_TYPE_BY_KIND);
    expect(mapped).not.toContain('text2music');
    expect(mapped).not.toContain('cover-nofsq');
  });
});

describe('Requirement 7.9 — the turbo/base split is what makes an edit unsupported', () => {
  it('mirrors `TASK_TYPES_TURBO` and `TASK_TYPES_BASE`', () => {
    expect([...ACE_TASK_TYPES_TURBO]).toEqual(['text2music', 'repaint', 'cover', 'cover-nofsq']);
    expect([...ACE_TASK_TYPES_BASE]).toEqual([...ACE_TASK_TYPES]);
  });

  it('turns each task list into the edit kinds it covers', () => {
    expect(editKindsForTaskTypes([...ACE_TASK_TYPES_TURBO])).toEqual(['cover', 'repaint']);
    expect(editKindsForTaskTypes([...ACE_TASK_TYPES_BASE])).toEqual([...EDIT_KINDS]);
  });

  it('recognises the turbo checkpoints by name, and only those', () => {
    expect(ACE_KNOWN_DIT_MODELS.filter(isAceTurboModelName)).toEqual([
      'acestep-v15-turbo',
      'acestep-v15-turbo-shift3',
    ]);
  });

  it('builds a catalogue in which every kind is supported by some model', () => {
    expect(unsupportedEditKinds(ACE_DEFAULT_EDIT_MODEL_CATALOGUE)).toEqual([]);
    expect(modelsSupportingEditKind(ACE_DEFAULT_EDIT_MODEL_CATALOGUE, 'extract')).toEqual([
      'acestep-v15-base',
      'acestep-v15-sft',
    ]);
  });

  it('prefers the engine-reported task list over any local inference', () => {
    // A model whose name says "turbo" but which the engine reports as fully capable is
    // taken at the engine's word: `/v1/models` is authoritative, the name is a guess.
    const catalogue = aceEditModelCatalogueFrom([
      { name: 'acestep-v15-turbo-experimental', supportedTaskTypes: [...ACE_TASK_TYPES_BASE] },
    ]);

    expect(supportsEditKind(catalogue, 'acestep-v15-turbo-experimental', 'extract')).toBe(true);
  });

  it('honours the engine-declared default model', () => {
    const catalogue = aceEditModelCatalogueFrom([
      { name: 'acestep-v15-turbo', supportedTaskTypes: [...ACE_TASK_TYPES_TURBO] },
      { name: 'acestep-v15-base', supportedTaskTypes: [...ACE_TASK_TYPES_BASE], isDefault: true },
    ]);

    expect(catalogue.defaultModel).toBe('acestep-v15-base');
  });

  it('reports an empty inventory as supporting nothing rather than everything', () => {
    const catalogue = aceEditModelCatalogueFrom([]);

    expect(unsupportedEditKinds(catalogue)).toEqual([...EDIT_KINDS]);
    expect(supportsEditKind(catalogue, 'acestep-v15-base', 'cover')).toBe(false);
  });
});
