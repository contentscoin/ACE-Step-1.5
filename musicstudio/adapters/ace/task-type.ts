/**
 * ACE-Step's `task_type` values (design §3.6).
 *
 * Transcribed from `TASK_TYPES` in `acestep/constants.py`. Design §3.6 lists six
 * for `song` — text2music, cover, repaint, extract, lego, complete — while the
 * engine constant carries a seventh, `cover-nofsq`, a cover variant that skips the
 * FSQ stage. It is included here because the wire accepts it and omitting it would
 * make this list quietly narrower than the engine's.
 *
 * Task 2.1 only submits `text2music`. Task 2.2 selects the five edit tasks through
 * `aceTaskTypeForEditKind`, which is the single place the product layer's `EditKind`
 * becomes an engine string.
 */

import type { EditKind } from '../../domain/edit/edit-kind';

export const ACE_TASK_TYPES = [
  'text2music',
  'repaint',
  'cover',
  'cover-nofsq',
  'extract',
  'lego',
  'complete',
] as const;

export type AceTaskType = (typeof ACE_TASK_TYPES)[number];

/** The task Requirements 3 and 4 both generate with. */
export const ACE_DEFAULT_TASK_TYPE: AceTaskType = 'text2music';

export function isAceTaskType(value: unknown): value is AceTaskType {
  return typeof value === 'string' && (ACE_TASK_TYPES as readonly string[]).includes(value);
}

/**
 * `TASK_TYPES_TURBO` — the subset a turbo checkpoint can run.
 *
 * Requirement 7.9 is exactly this distinction: `extract`, `lego` and `complete` are
 * missing here, so asking a turbo model for one of them is the criterion's
 * "unsupported kind".
 */
export const ACE_TASK_TYPES_TURBO: readonly AceTaskType[] = [
  'text2music',
  'repaint',
  'cover',
  'cover-nofsq',
];

/** `TASK_TYPES_BASE` — the full set, which is `TASK_TYPES` itself. */
export const ACE_TASK_TYPES_BASE: readonly AceTaskType[] = [...ACE_TASK_TYPES];

/**
 * The five edit tasks, as engine strings.
 *
 * `cover-nofsq` is not among them, and that is a judgement rather than an omission:
 * `acestep/constants.py` carries it as a seventh `TASK_TYPES` member and
 * `task_utils.py` treats it as a cover (`is_cover_task`, sharing the `cover`
 * instruction), but requirements.md Requirement 7 names five edits and gives no
 * criterion that would distinguish a cover from an FSQ-skipping cover. Exposing it
 * would be a product decision nothing in the spec authorises, so the product layer
 * submits plain `cover` and the value stays reachable only through the
 * `taskTypeFor` seam.
 */
export const ACE_EDIT_TASK_TYPE_BY_KIND: Readonly<Record<EditKind, AceTaskType>> = {
  cover: 'cover',
  repaint: 'repaint',
  extract: 'extract',
  lego: 'lego',
  complete: 'complete',
};

/** Requirements 7.1, 7.3, 7.6, 7.7, 7.8 — the `task_type` each edit is submitted as. */
export function aceTaskTypeForEditKind(kind: EditKind): AceTaskType {
  return ACE_EDIT_TASK_TYPE_BY_KIND[kind];
}

/** The edit kinds an engine-reported `supported_task_types` list covers. */
export function editKindsForTaskTypes(taskTypes: readonly string[]): readonly EditKind[] {
  return (Object.keys(ACE_EDIT_TASK_TYPE_BY_KIND) as readonly EditKind[]).filter((kind) =>
    taskTypes.includes(ACE_EDIT_TASK_TYPE_BY_KIND[kind]),
  );
}
