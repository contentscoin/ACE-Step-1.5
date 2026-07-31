/**
 * ACE-Step's `task_type` values (design §3.6).
 *
 * Transcribed from `TASK_TYPES` in `acestep/constants.py`. Design §3.6 lists six
 * for `song` — text2music, cover, repaint, extract, lego, complete — while the
 * engine constant carries a seventh, `cover-nofsq`, a cover variant that skips the
 * FSQ stage. It is included here because the wire accepts it and omitting it would
 * make this list quietly narrower than the engine's.
 *
 * Task 2.1 only submits `text2music`. The remaining values are named so task 2.2
 * (cover, repaint, extract, lego, complete) can select one without reopening the
 * request builder; none of their edit-specific parameters or validation exists yet.
 */

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
