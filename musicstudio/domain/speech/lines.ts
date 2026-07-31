/**
 * The script's line list (Requirement 25.14).
 *
 * "스크립트를 줄바꿈 문자로 구분된 행 단위로 저장하고, 각 행에 0부터 시작하는 연속 정수 행
 * 인덱스와 ... 행 개수를 1개 이상 1000개 이하로, 행당 문자 수를 1자 이상 1000자 이하로 유지한다".
 *
 * ### Blank lines are dropped, not rejected
 *
 * 25.14 keeps every stored line between 1 and 1000 characters, so a blank line cannot be
 * stored — and a script with a paragraph break is entirely ordinary. The criterion says the
 * bounds are *maintained* (유지한다) rather than validated, so the reading applied here is that
 * a blank line is not a line: it separates lines. Rejecting `"a\n\nb"` would refuse a script
 * nothing is wrong with, and storing an empty line would break 25.17's `start < end` for a
 * line with no audio to have a duration.
 *
 * Dropping means the stored `lineIndex` is a position in the *stored* list, which is what
 * 25.14 asks for ("0부터 시작하는 연속 정수") and what 25.15's re-synthesis request addresses.
 * The original offset is kept on each line so a caller can map a stored line back to the
 * script the user typed.
 *
 * ### A line that is too long is refused rather than folded
 *
 * A 1500-character line has no legal stored form: it exceeds 25.14's per-line ceiling and
 * splitting it would create a line the user did not write, which would make the line indices
 * of 25.15 disagree with the script. So it is reported as a violation.
 *
 * **Interpretation, reported with this task.** 25.22 enumerates the constraints whose breach
 * refuses the request — script length, rate, pitch, acting instruction, split threshold — and
 * 25.14's line bounds are not among them. The form of the refusal is therefore borrowed from
 * 25.22 (constraint name plus permitted range, nothing charged) because there is no other
 * outcome available: 25.14 cannot be satisfied and there is no clause permitting the line to
 * be altered.
 */

import { lengthViolation, rangeViolation, type SongFieldViolation } from '../song/violation';

import {
  DIALOGUE_LINE_COUNT_MAX,
  DIALOGUE_LINE_COUNT_MIN,
  DIALOGUE_LINE_LENGTH_MAX,
  DIALOGUE_LINE_LENGTH_MIN,
} from './bounds';

export interface ScriptLine {
  /** Requirement 25.14: position in the stored list, 0-based and consecutive. */
  readonly lineIndex: number;
  readonly text: string;
  /** Character offset of the line's first character in the original script. */
  readonly startOffset: number;
}

/**
 * Requirement 25.14's line split.
 *
 * `\r\n` and a lone `\r` both count as a line break, because a script pasted from a Windows
 * editor is the same script and a stored line ending in `\r` would carry an invisible
 * character into synthesis. Each line is otherwise verbatim: no trimming, so the text stored
 * is the text the user typed, and any paralinguistic tag (25.8) keeps its position within the
 * line.
 *
 * Lines that are blank *after trimming* are dropped — a line of spaces has nothing to
 * synthesise, so storing it would produce a zero-length audio region.
 */
export function scriptLines(script: string): readonly ScriptLine[] {
  const lines: ScriptLine[] = [];
  let offset = 0;

  for (const raw of script.split(/\r\n|\r|\n/u)) {
    if (raw.trim().length > 0) {
      lines.push({ lineIndex: lines.length, text: raw, startOffset: offset });
    }
    // `+ 1` for the separator that was consumed. The last piece has none, and the extra
    // increment is harmless because the loop ends there.
    offset += raw.length + 1;
  }

  return lines;
}

export type ScriptLineValidation =
  | { readonly kind: 'valid'; readonly lines: readonly ScriptLine[] }
  | {
      readonly kind: 'invalid';
      readonly lines: readonly ScriptLine[];
      readonly violations: readonly SongFieldViolation[];
      /** The constraint names 25.14 bounds, for the rejection payload. */
      readonly constraints: readonly ScriptLineConstraint[];
    };

export const SCRIPT_LINE_CONSTRAINTS = ['lineCount', 'lineLength'] as const;

export type ScriptLineConstraint = (typeof SCRIPT_LINE_CONSTRAINTS)[number];

export const SCRIPT_LINE_CONSTRAINT_REQUIREMENT: Readonly<
  Record<ScriptLineConstraint, string>
> = {
  lineCount: '25.14',
  lineLength: '25.14',
};

/** Requirement 25.14's two bounds, reported together so one round trip fixes both. */
export function validateScriptLines(script: string): ScriptLineValidation {
  const lines = scriptLines(script);
  const violations: SongFieldViolation[] = [];
  const constraints: ScriptLineConstraint[] = [];

  if (lines.length < DIALOGUE_LINE_COUNT_MIN || lines.length > DIALOGUE_LINE_COUNT_MAX) {
    violations.push(
      rangeViolation('lineCount', lines.length, DIALOGUE_LINE_COUNT_MIN, DIALOGUE_LINE_COUNT_MAX),
    );
    constraints.push('lineCount');
  }

  const offending = lines.find(
    (line) =>
      line.text.length < DIALOGUE_LINE_LENGTH_MIN ||
      line.text.length > DIALOGUE_LINE_LENGTH_MAX,
  );
  if (offending !== undefined) {
    violations.push(
      lengthViolation(
        `line[${String(offending.lineIndex)}]`,
        offending.text.length,
        DIALOGUE_LINE_LENGTH_MIN,
        DIALOGUE_LINE_LENGTH_MAX,
      ),
    );
    constraints.push('lineLength');
  }

  if (violations.length > 0) return { kind: 'invalid', lines, violations, constraints };
  return { kind: 'valid', lines };
}
