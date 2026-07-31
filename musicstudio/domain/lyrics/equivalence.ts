/**
 * The two equivalence relations design §7.1 fixes for the lyric structs.
 *
 * §7.1 is explicit that round-trip correctness is judged by a *named relation*, not
 * by deep equality:
 *
 * | struct            | relation                                        |
 * |-------------------|-------------------------------------------------|
 * | `Lyrics_Document` | section order, section kind and line content     |
 * | `Timed_Lyrics`    | timestamps within ±10 ms, line text identical    |
 *
 * Encoding them as functions rather than inlining `toEqual` in the property suites
 * matters for two reasons. Deep equality is the wrong relation for `Timed_Lyrics` —
 * it would demand exact timestamps and so contradict Requirement 10.4's explicit
 * tolerance. And for `Lyrics_Document` it is *stricter* than §7.1 asks, so a future
 * derived field (a cached line count, a source offset) would break the properties
 * for a reason the requirements do not care about.
 *
 * Each relation returns a reason on mismatch. A property failure that only says
 * `false` costs a debugging session; one that says "section 2 line 3 differs" does
 * not.
 */

import { sectionTypesEqual } from './section-type';
import type { LyricsDocument } from './document';
import { LRC_ROUND_TRIP_TOLERANCE_MS, type TimedLyrics } from './timed-lyrics';

export type EquivalenceVerdict =
  | { readonly equivalent: true }
  | { readonly equivalent: false; readonly reason: string };

const EQUIVALENT: EquivalenceVerdict = { equivalent: true };

function differs(reason: string): EquivalenceVerdict {
  return { equivalent: false, reason };
}

/**
 * §7.1's `Lyrics_Document` relation: section order, section kind, line content.
 *
 * Line content is compared by exact string equality. That is not a stricter reading
 * of "행 내용 일치" than intended — a lyric line is the user's text, and normalising
 * it before comparison would let the printer quietly alter what was written and
 * still pass.
 */
export function lyricsDocumentsEquivalent(
  left: LyricsDocument,
  right: LyricsDocument,
): EquivalenceVerdict {
  if (left.sections.length !== right.sections.length) {
    return differs(
      `section count ${String(left.sections.length)} !== ${String(right.sections.length)}`,
    );
  }

  for (const [index, leftSection] of left.sections.entries()) {
    const rightSection = right.sections[index];
    if (rightSection === undefined) return differs(`section ${String(index)} missing`);

    if (!sectionTypesEqual(leftSection.type, rightSection.type)) {
      return differs(
        `section ${String(index)} kind ${JSON.stringify(leftSection.type)} !== ${JSON.stringify(rightSection.type)}`,
      );
    }

    if (leftSection.lines.length !== rightSection.lines.length) {
      return differs(
        `section ${String(index)} line count ${String(leftSection.lines.length)} !== ${String(rightSection.lines.length)}`,
      );
    }

    for (const [lineIndex, leftLine] of leftSection.lines.entries()) {
      if (leftLine !== rightSection.lines[lineIndex]) {
        return differs(
          `section ${String(index)} line ${String(lineIndex)}: ${JSON.stringify(leftLine)} !== ${JSON.stringify(rightSection.lines[lineIndex])}`,
        );
      }
    }
  }

  return EQUIVALENT;
}

/**
 * §7.1's `Timed_Lyrics` relation: timestamps within ±10 ms and identical text.
 *
 * The tolerance is inclusive, matching Requirement 10.4's "10밀리초 이내".
 */
export function timedLyricsEquivalent(
  left: TimedLyrics,
  right: TimedLyrics,
  toleranceMs: number = LRC_ROUND_TRIP_TOLERANCE_MS,
): EquivalenceVerdict {
  if (left.lines.length !== right.lines.length) {
    return differs(`line count ${String(left.lines.length)} !== ${String(right.lines.length)}`);
  }

  for (const [index, leftLine] of left.lines.entries()) {
    const rightLine = right.lines[index];
    if (rightLine === undefined) return differs(`line ${String(index)} missing`);

    const drift = Math.abs(leftLine.startMs - rightLine.startMs);
    if (!(drift <= toleranceMs)) {
      return differs(
        `line ${String(index)} timestamp drifted ${String(drift)} ms (> ${String(toleranceMs)} ms)`,
      );
    }

    if (leftLine.text !== rightLine.text) {
      return differs(
        `line ${String(index)} text ${JSON.stringify(leftLine.text)} !== ${JSON.stringify(rightLine.text)}`,
      );
    }
  }

  return EQUIVALENT;
}
