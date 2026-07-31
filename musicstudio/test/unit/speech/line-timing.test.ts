import { describe, expect, it } from 'vitest';

import { LINE_LENGTH_CHANGE_THRESHOLD_MS } from '../../../domain/speech/bounds';
import {
  dialogueTimingDefects,
  dialogueTimingOf,
  gapsOf,
  isAddressableLineIndex,
  isValidDialogueTiming,
  layoutDurationMs,
  layoutOf,
  retimeAfterResynthesis,
  type DialogueLayout,
} from '../../../domain/speech/line-timing';
import { scriptLines, validateScriptLines } from '../../../domain/speech/lines';

/**
 * Per-line timings and single-line re-synthesis.
 *
 * **Validates: Requirements 25.14, 25.15, 25.16, 25.17, 25.20, 25.21, 27.14**
 *
 * The prefix-invariance claim of 25.20 and the gap preservation of 25.16 are also property-tested
 * over generated layouts in `test/property/dialogue-generation.test.ts`; the examples here pin the
 * arithmetic so a failure says which number is wrong.
 */

const OVERLAP = 50;

function layout(durations: readonly number[], overlapMs = OVERLAP): DialogueLayout {
  return {
    segments: durations.map((durationMs, lineIndex) => ({
      lineIndex,
      text: `line ${String(lineIndex)}`,
      durationMs,
    })),
    overlapsMs: durations.slice(1).map(() => overlapMs),
  };
}

describe('the line list (Requirement 25.14)', () => {
  it('indexes lines from 0 consecutively, dropping blank ones', () => {
    const lines = scriptLines('first\n\n  \nsecond\nthird');

    expect(lines.map((line) => line.text)).toEqual(['first', 'second', 'third']);
    expect(lines.map((line) => line.lineIndex)).toEqual([0, 1, 2]);
  });

  it('keeps each line verbatim, with no trimming', () => {
    const lines = scriptLines('  spaced out  \nplain');

    expect(lines[0]?.text).toBe('  spaced out  ');
  });

  it('treats CRLF and a lone CR as line breaks', () => {
    expect(scriptLines('a\r\nb\rc').map((line) => line.text)).toEqual(['a', 'b', 'c']);
  });

  it('records the offset of each line in the original script', () => {
    const lines = scriptLines('ab\ncd');

    expect(lines[0]?.startOffset).toBe(0);
    expect(lines[1]?.startOffset).toBe(3);
  });

  it('refuses a script whose only line is blank (no storable line list)', () => {
    const validation = validateScriptLines('   ');

    expect(validation.kind).toBe('invalid');
    if (validation.kind !== 'invalid') return;
    expect(validation.constraints).toContain('lineCount');
  });

  it('refuses a line past 1000 characters, naming the constraint', () => {
    const validation = validateScriptLines(`ok\n${'x'.repeat(1_001)}`);

    expect(validation.kind).toBe('invalid');
    if (validation.kind !== 'invalid') return;
    expect(validation.constraints).toContain('lineLength');
    expect(validation.violations[0]?.field).toBe('line[1]');
  });

  it('refuses more than 1000 lines', () => {
    const validation = validateScriptLines(Array.from({ length: 1_001 }, () => 'x').join('\n'));

    expect(validation.kind).toBe('invalid');
    if (validation.kind !== 'invalid') return;
    expect(validation.constraints).toContain('lineCount');
  });

  it('accepts exactly 1000 lines of one character', () => {
    const validation = validateScriptLines(Array.from({ length: 1_000 }, () => 'x').join('\n'));

    expect(validation.kind).toBe('valid');
  });
});

describe('deriving the timings (Requirements 25.14, 25.17)', () => {
  it('partitions the timeline with no gap and no overlap', () => {
    // Three 1000 ms pieces joined with two 50 ms fades: 2900 ms of audio.
    const timing = dialogueTimingOf(layout([1_000, 1_000, 1_000]));

    expect(layoutDurationMs(layout([1_000, 1_000, 1_000]))).toBe(2_900);
    expect(timing.lines.map((line) => [line.startMs, line.endMs])).toEqual([
      [0, 950],
      [950, 1_900],
      [1_900, 2_900],
    ]);
    expect(timing.totalDurationMs).toBe(2_900);
    expect(gapsOf(timing)).toEqual([0, 0]);
  });

  it('satisfies every clause of 25.17', () => {
    const timing = dialogueTimingOf(layout([400, 700, 250, 1_100]));

    expect(isValidDialogueTiming(timing)).toBe(true);
    expect(dialogueTimingDefects(timing)).toEqual([]);
    expect(timing.lines[0]?.startMs).toBe(0);
    expect(timing.lines.at(-1)?.endMs).toBeLessThanOrEqual(timing.totalDurationMs);
  });

  it('reports integer milliseconds even for fractional durations', () => {
    const timing = dialogueTimingOf(layout([333.333, 266.666]));

    for (const line of timing.lines) {
      expect(Number.isInteger(line.startMs)).toBe(true);
      expect(Number.isInteger(line.endMs)).toBe(true);
    }
    expect(Number.isInteger(timing.totalDurationMs)).toBe(true);
  });

  it('keeps start < end even when a line is shorter than the fade', () => {
    // A 20 ms line with a 20 ms clamped overlap has zero exclusive span; the nudge keeps it at 1 ms.
    const timing = dialogueTimingOf({
      segments: [
        { lineIndex: 0, text: 'a', durationMs: 20 },
        { lineIndex: 1, text: 'b', durationMs: 500 },
      ],
      overlapsMs: [20],
    });

    expect(isValidDialogueTiming(timing)).toBe(true);
    expect(timing.lines[0]?.endMs).toBeGreaterThan(timing.lines[0]?.startMs ?? 0);
  });

  it('pins the total to the measured joined length when one is supplied', () => {
    const timing = dialogueTimingOf(layout([1_000, 1_000]), 1_960);

    expect(timing.totalDurationMs).toBe(1_960);
  });

  it('clamps the last line rather than letting its end run past a shorter measurement', () => {
    // The arithmetic total is 1950; a measured 1948 (frame rounding) must not leave the final
    // line ending after the file does — 25.17 requires end ≤ total.
    const timing = dialogueTimingOf(layout([1_000, 1_000]), 1_948);

    expect(timing.totalDurationMs).toBe(1_948);
    expect(timing.lines.at(-1)?.endMs).toBe(1_948);
    expect(isValidDialogueTiming(timing)).toBe(true);
  });

  it('round-trips through layoutOf', () => {
    const original = layout([600, 900, 300]);
    const timing = dialogueTimingOf(original);
    const recovered = layoutOf(timing, original.overlapsMs);

    expect(recovered.segments.map((segment) => segment.durationMs)).toEqual([600, 900, 300]);
  });
});

describe('re-synthesising one line (Requirements 25.15, 25.16, 25.20)', () => {
  const before = layout([1_000, 1_000, 1_000]);

  it('shifts only the target line and its successors, by exactly the delta', () => {
    const after = retimeAfterResynthesis(before, 1, 1_400);

    expect(after.retimed).toBe(true);
    expect(after.deltaMs).toBe(400);
    expect(after.timing.lines.map((line) => [line.startMs, line.endMs])).toEqual([
      // Requirement 25.20: line 0 is untouched.
      [0, 950],
      // The target line grows by the delta.
      [950, 2_300],
      // Requirement 25.16: the successor's start and end both move by 400.
      [2_300, 3_300],
    ]);
    expect(after.timing.totalDurationMs).toBe(3_300);
  });

  it('keeps every preceding line byte-identical, whichever line is regenerated', () => {
    const original = dialogueTimingOf(before);

    for (const lineIndex of [0, 1, 2]) {
      const after = retimeAfterResynthesis(before, lineIndex, 1_500);
      for (let position = 0; position < lineIndex; position += 1) {
        expect(after.timing.lines[position]).toEqual(original.lines[position]);
      }
    }
  });

  it('shortens as well as lengthens, keeping the total consistent', () => {
    const after = retimeAfterResynthesis(before, 0, 600);

    expect(after.deltaMs).toBe(-400);
    expect(after.timing.totalDurationMs).toBe(2_500);
    expect(after.timing.lines[1]?.startMs).toBe(550);
  });

  it('preserves the gap between adjacent lines (Requirement 25.16)', () => {
    const gapsBefore = gapsOf(dialogueTimingOf(before));
    const after = retimeAfterResynthesis(before, 1, 2_000);

    expect(gapsOf(after.timing)).toEqual(gapsBefore);
  });

  it('changes nothing at all below the 1 ms threshold (Requirement 25.16)', () => {
    const original = dialogueTimingOf(before);
    const after = retimeAfterResynthesis(before, 1, 1_000 + LINE_LENGTH_CHANGE_THRESHOLD_MS / 2);

    expect(after.retimed).toBe(false);
    expect(after.timing).toEqual(original);
    expect(after.layout).toBe(before);
  });

  it('re-times at exactly 1 ms, which is the boundary 25.16 includes', () => {
    const after = retimeAfterResynthesis(before, 1, 1_001);

    expect(after.retimed).toBe(true);
    expect(after.deltaMs).toBe(1);
  });

  it('accepts the overlaps measured on the new join', () => {
    const after = retimeAfterResynthesis(before, 1, 1_400, [50, 30]);

    expect(after.layout.overlapsMs).toEqual([50, 30]);
    // The last seam consumed 20 ms less, so 20 ms more audio survives.
    expect(after.timing.totalDurationMs).toBe(3_320);
  });

  it('is a no-op for an index that does not exist', () => {
    const after = retimeAfterResynthesis(before, 9, 5_000);

    expect(after.retimed).toBe(false);
    expect(after.deltaMs).toBe(0);
  });
});

describe('the addressable index range (Requirement 25.21)', () => {
  it('accepts 0 up to one less than the line count, and nothing else', () => {
    const timing = dialogueTimingOf(layout([500, 500]));

    expect(isAddressableLineIndex(timing, 0)).toBe(true);
    expect(isAddressableLineIndex(timing, 1)).toBe(true);
    expect(isAddressableLineIndex(timing, 2)).toBe(false);
    expect(isAddressableLineIndex(timing, -1)).toBe(false);
    expect(isAddressableLineIndex(timing, 0.5)).toBe(false);
  });
});

describe('the defect vocabulary (Requirement 25.17)', () => {
  it('names an overlap, an out-of-order pair and an end past the total', () => {
    const defects = dialogueTimingDefects({
      lines: [
        { lineIndex: 0, text: 'a', startMs: 0, endMs: 500 },
        // Starts before its predecessor ends: overlapping and out of order.
        { lineIndex: 1, text: 'b', startMs: 400, endMs: 900 },
        { lineIndex: 2, text: 'c', startMs: 900, endMs: 5_000 },
      ],
      totalDurationMs: 1_000,
    });

    const kinds = defects.map((defect) => defect.kind);
    expect(kinds).toContain('overlapping');
    expect(kinds).toContain('end_past_total');
  });

  it('names a non-sequential index and a blank line', () => {
    const defects = dialogueTimingDefects({
      lines: [{ lineIndex: 3, text: '', startMs: 0, endMs: 100 }],
      totalDurationMs: 100,
    });

    const kinds = defects.map((defect) => defect.kind);
    expect(kinds).toContain('line_index_not_sequential');
    expect(kinds).toContain('line_length_out_of_range');
  });
});
