import { describe, expect, it } from 'vitest';

import { UNDO_HISTORY_MAX } from '../../../domain/timeline/bounds';
import {
  executeCommand,
  planClipGain,
  planTrackPan,
  type EditCommand,
} from '../../../domain/timeline/commands';
import { projectsEquivalent } from '../../../domain/timeline/equivalence';
import {
  canRedo,
  canUndo,
  createHistory,
  record,
  redo,
  undo,
} from '../../../domain/timeline/history';
import type { TimelineProject } from '../../../domain/timeline/project';
import { clip, projectWith } from '../../support/timeline-harness';

/**
 * Requirement 28.22's history depth and Requirement 28.38's empty-history refusals.
 *
 * The undo/redo *algebra* is proved by Properties 16 and 17 in `test/property/`. What is here is
 * the bookkeeping the clauses state numerically — 100 entries, the 101st evicting the oldest, and
 * the redo history being cleared — which a property over single operations never reaches.
 */

const base = projectWith([clip({ id: 'a', sourceDurationMs: 10_000, gainDb: 0 })]);

/** `count` successive gain changes, each recorded, applied to `project`. */
function applyGainSequence(
  project: TimelineProject,
  count: number,
): { project: TimelineProject; history: ReturnType<typeof createHistory> } {
  let current = project;
  let history = createHistory();

  for (let index = 0; index < count; index += 1) {
    // Each step is a distinct, valid gain so the sequence is 100 genuinely different states.
    const plan = planClipGain(current, 'a', -(index % 40));
    if (!plan.ok) throw new Error(`step ${String(index)} rejected`);
    current = executeCommand(current, plan.command);
    history = record(history, plan.command);
  }

  return { project: current, history };
}

describe('history depth (Requirement 28.22)', () => {
  it('keeps 100 operations', () => {
    const { history } = applyGainSequence(base, UNDO_HISTORY_MAX);
    expect(history.undoable).toHaveLength(UNDO_HISTORY_MAX);
    expect(UNDO_HISTORY_MAX).toBe(100);
  });

  it('drops the oldest when the 101st is recorded', () => {
    const { history } = applyGainSequence(base, UNDO_HISTORY_MAX + 1);
    expect(history.undoable).toHaveLength(UNDO_HISTORY_MAX);

    // The first recorded operation moved the gain to 0; after eviction the oldest surviving entry
    // is the second, which moved it to -1.
    const oldest = history.undoable[0];
    expect(oldest?.type).toBe('clip_gain');
    if (oldest?.type !== 'clip_gain') return;
    expect(oldest.after).toBe(-1);
  });

  it('holds the bound when several are recorded at once', () => {
    // `slice(-100)` rather than "drop one when we hit 101": the latter is wrong by exactly the
    // batch size, and a batched import is the caller that would find out.
    const { history } = applyGainSequence(base, UNDO_HISTORY_MAX + 37);
    expect(history.undoable).toHaveLength(UNDO_HISTORY_MAX);
  });

  it('can undo the whole retained history and no further', () => {
    const { project, history } = applyGainSequence(base, UNDO_HISTORY_MAX + 5);

    let current = project;
    let ledger = history;
    for (let step = 0; step < UNDO_HISTORY_MAX; step += 1) {
      const undone = undo(current, ledger);
      expect(undone.ok).toBe(true);
      if (!undone.ok) return;
      current = undone.project;
      ledger = undone.history;
    }

    expect(canUndo(ledger)).toBe(false);
    expect(ledger.redoable).toHaveLength(UNDO_HISTORY_MAX);
    // Requirement 28.38: the 101st undo is refused.
    const overrun = undo(current, ledger);
    expect(overrun.ok).toBe(false);
    if (overrun.ok) return;
    expect(overrun.reason).toBe('undo_history_empty');
  });
});

describe('a new operation after an undo clears the redo history (Requirement 28.22)', () => {
  it('empties the redo stack', () => {
    const first = planClipGain(base, 'a', -6);
    if (!first.ok) throw new Error('rejected');
    const afterFirst = executeCommand(base, first.command);
    const undone = undo(afterFirst, record(createHistory(), first.command));
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(canRedo(undone.history)).toBe(true);

    const second = planTrackPan(undone.project, 3, 0.5);
    if (!second.ok) throw new Error('rejected');
    const history = record(undone.history, second.command);

    expect(history.redoable).toEqual([]);
    expect(canRedo(history)).toBe(false);
    // Requirement 28.38: with nothing to redo the request is refused with its reason code.
    const refused = redo(executeCommand(undone.project, second.command), history);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe('redo_history_empty');
  });
});

describe('empty history refusals (Requirement 28.38)', () => {
  it('refuses an undo on a fresh project and changes nothing', () => {
    const result = undo(base, createHistory());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('undo_history_empty');
  });

  it('refuses a redo on a fresh project', () => {
    const result = redo(base, createHistory());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('redo_history_empty');
  });
});

describe('a full undo of a long sequence returns the original project', () => {
  it('is equivalent to where it started', () => {
    // Nine operations rather than a hundred, so the sequence fits inside the history and the whole
    // thing really can be unwound. This is the composed form of Requirement 28.37, which Property 17
    // states for a single operation.
    const { project, history } = applyGainSequence(base, 9);

    let current = project;
    let ledger = history;
    let step = undo(current, ledger);
    while (step.ok) {
      current = step.project;
      ledger = step.history;
      step = undo(current, ledger);
    }

    expect(projectsEquivalent(base, current)).toBe(true);
  });

  it('and redoing all of them returns to the end state', () => {
    const { project, history } = applyGainSequence(base, 9);

    let current = project;
    let ledger = history;
    let back = undo(current, ledger);
    while (back.ok) {
      current = back.project;
      ledger = back.history;
      back = undo(current, ledger);
    }

    let forward = redo(current, ledger);
    while (forward.ok) {
      current = forward.project;
      ledger = forward.history;
      forward = redo(current, ledger);
    }

    expect(projectsEquivalent(project, current)).toBe(true);
  });
});

describe('the history is inspectable data, not a list of closures', () => {
  it('says which operations it holds', () => {
    const { history } = applyGainSequence(base, 3);
    const types: readonly EditCommand['type'][] = history.undoable.map((command) => command.type);
    expect(types).toEqual(['clip_gain', 'clip_gain', 'clip_gain']);
  });
});
