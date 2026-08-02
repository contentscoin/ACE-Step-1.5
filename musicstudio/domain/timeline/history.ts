/**
 * The undo/redo history (Requirements 28.22, 28.23, 28.37, 28.38; design §6.4).
 *
 * Requirement 28.22 states three rules and this module is exactly those three:
 *
 * 1. **Depth 100.** "최근 100회의 편집 조작을 되돌리기 이력으로 보관하고, 101번째 조작이 기록되면
 *    가장 오래된 1건을 제거" — a bounded queue, oldest out at the head.
 * 2. **A new operation after an undo clears the redo history.** "되돌리기 이후 새 편집 조작이
 *    기록되면 다시 실행 이력을 0건으로 비운다".
 * 3. Only *successful* operations are recorded — 28.22 says 편집 조작 1건이 성공한, and
 *    `commands.ts` splits planning from execution precisely so that a rejected request never
 *    reaches `record`.
 *
 * Requirement 28.38 supplies the fourth rule: an undo with nothing to undo, or a redo with
 * nothing to redo, is *refused with a reason code* and leaves the project alone. So `undo` and
 * `redo` return a discriminated result rather than the project — a signature that cannot
 * silently return an unchanged project and let the caller believe something happened.
 *
 * ### The history is a value, not an object with mutable state
 *
 * Every function here returns a new `EditHistory`. That is not stylistic: Requirement 28.23's
 * round-trip property and 28.37's inverse property are both statements about a *sequence* of
 * states, and a property test that has to unwind a mutable object between runs is a test that
 * can leak state between runs. `fast-check` shrinks by replaying, so a mutable history would
 * shrink to a counter-example that does not reproduce.
 *
 * ### Why the redo stack holds commands and not snapshots
 *
 * A snapshot-based redo would satisfy Requirement 28.23 trivially — store the project, put it
 * back — and would test nothing about the commands. Design §6.4 asks for the Command Pattern,
 * and the properties are only meaningful if `redo` really is `execute` run again. So it is:
 * `redo` calls `executeCommand` on the same record the undo pushed.
 */

import { UNDO_HISTORY_MAX } from './bounds';
import { executeCommand, undoCommand, type EditCommand } from './commands';
import type { TimelineProject } from './project';

export interface EditHistory {
  /** Oldest first; the newest is the one `undo` will apply. */
  readonly undoable: readonly EditCommand[];
  /** Newest first; the head is the one `redo` will apply. */
  readonly redoable: readonly EditCommand[];
}

export const EMPTY_HISTORY: EditHistory = { undoable: [], redoable: [] };

export function createHistory(): EditHistory {
  return EMPTY_HISTORY;
}

/** Requirement 28.38's two reason codes. */
export type HistoryRejectionCode = 'undo_history_empty' | 'redo_history_empty';

export type HistoryStep =
  | {
      readonly ok: true;
      readonly project: TimelineProject;
      readonly history: EditHistory;
      readonly command: EditCommand;
    }
  | { readonly ok: false; readonly reason: HistoryRejectionCode };

/**
 * Requirement 28.22: record a successful operation.
 *
 * The eviction is `slice(-UNDO_HISTORY_MAX)` rather than a conditional `shift`, so the bound
 * holds even if a caller records several at once — which is what a batched import would do, and
 * which a "drop one when we hit 101" formulation would get wrong by exactly the batch size.
 */
export function record(history: EditHistory, command: EditCommand): EditHistory {
  const undoable = [...history.undoable, command];
  return {
    undoable: undoable.length > UNDO_HISTORY_MAX ? undoable.slice(-UNDO_HISTORY_MAX) : undoable,
    // Rule 2: a new operation makes the redo history unreachable, so it is emptied rather than
    // left to be applied on top of a state it was never derived from.
    redoable: [],
  };
}

/** Requirements 28.37, 28.38. */
export function undo(project: TimelineProject, history: EditHistory): HistoryStep {
  const command = history.undoable[history.undoable.length - 1];
  if (command === undefined) return { ok: false, reason: 'undo_history_empty' };

  return {
    ok: true,
    project: undoCommand(project, command),
    history: {
      undoable: history.undoable.slice(0, -1),
      redoable: [command, ...history.redoable],
    },
    command,
  };
}

/** Requirements 28.23, 28.38. */
export function redo(project: TimelineProject, history: EditHistory): HistoryStep {
  const command = history.redoable[0];
  if (command === undefined) return { ok: false, reason: 'redo_history_empty' };

  return {
    ok: true,
    // The same command record the undo pushed, re-executed. See the header.
    project: executeCommand(project, command),
    history: {
      undoable: [...history.undoable, command],
      redoable: history.redoable.slice(1),
    },
    command,
  };
}

export function canUndo(history: EditHistory): boolean {
  return history.undoable.length > 0;
}

export function canRedo(history: EditHistory): boolean {
  return history.redoable.length > 0;
}
