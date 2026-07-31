/**
 * Splitting a script into engine-sized chunks (Requirements 25.10–25.13).
 *
 * 25.11: "스크립트의 문자 수가 분할 기준 문자 수를 초과하면 ... 행 경계 또는 문장 종결
 * 부호(`.`, `?`, `!`, `。`) 직후 위치에서만 스크립트를 분할하고, 각 조각을 순차 합성한 후 인접
 * 조각을 50밀리초 교차 페이드로 연결한다".
 *
 * This module owns the first half — where the cuts go — and nothing else. The sequential
 * synthesis and the 50 ms join are `services/speech/speech-service.ts` and
 * `domain/audio/crossfade.ts` respectively.
 *
 * ### The two invariants, and why they are properties of the *cut set*
 *
 * 25.12 requires the chunk order to equal the script's sentence order and 25.13 requires
 * the chunk count not to exceed the sentence count. Both are stated here as consequences of
 * how the cuts are chosen rather than as checks applied afterwards:
 *
 * - **Order (25.12).** The chunks *partition* the script: every character appears in exactly
 *   one chunk, in its original position, so `joinChunks(splitScript(s, n)) === s` for every
 *   `s` and every `n`. That is a round-trip identity, which is a strictly stronger statement
 *   than "the order is preserved" — an implementation that reordered, dropped or duplicated
 *   even one character would fail it. `test/property/dialogue-generation.test.ts` asserts it
 *   over generated scripts.
 * - **Count (25.13).** Every chunk contains at least one non-whitespace character (see
 *   *whitespace-only chunks* below) and each chunk is a run of consecutive split units, so
 *   the number of chunks cannot exceed the number of units that carry text — which is what
 *   `sentenceCount` counts.
 *
 * ### Where the cuts may go
 *
 * A position `i` with `0 < i < len` is *eligible* when `script[i-1]` is a newline or one of
 * the four terminators. Nothing else is eligible, which is 25.11's "…위치에서만" read
 * literally. Note that eligibility is about the *preceding* character: the cut lands after
 * the punctuation, so the terminator stays with the sentence it ends.
 *
 * ### The greedy walk, and the overshoot case
 *
 * From the cursor, take the **last** eligible position within the threshold. If there is
 * none, take the **first** eligible position beyond it. If there is none of those either,
 * take the rest of the script.
 *
 * The overshoot case is the one worth stating plainly: **a chunk may exceed the threshold,
 * and must be allowed to.** A 3000-character script with no newline and no terminator has no
 * eligible position at all, and 25.11 permits a cut nowhere else — so the alternatives are
 * one over-long chunk or a cut the criterion forbids. Splitting illegally would be the worse
 * failure: it would hand the engine half a word. Taking the *first* eligible position past
 * the threshold, rather than the last one before giving up, keeps the overshoot as small as
 * the script allows.
 *
 * ### Whitespace-only chunks
 *
 * A chunk containing nothing but whitespace is merged into its neighbour. Not cosmetic: it
 * is what makes 25.13 true. Consider `"a.\n\n\nb."` with a small threshold — the eligible
 * positions after the period and after each newline would yield four chunks, two of which
 * are a lone `"\n"`, against two units that carry text. Merging keeps the partition (so the
 * round trip still holds) while guaranteeing every chunk carries text, which is the premise
 * the count argument needs.
 *
 * Pure, total and deterministic. No script is rejected here: 25.4's length rule and 25.22's
 * refusal live in `validation.ts`, so this function can be applied to anything and a
 * property test needs no precondition.
 */

import { SPLIT_THRESHOLD_DEFAULT, isSentenceTerminator } from './bounds';

export interface ScriptChunk {
  /** 0-based position in the sequential synthesis order of 25.11. */
  readonly index: number;
  readonly text: string;
  /** Character offset of the chunk's first character in the original script. */
  readonly startOffset: number;
  /** One past the chunk's last character. */
  readonly endOffset: number;
}

export interface ScriptSplit {
  readonly chunks: readonly ScriptChunk[];
  /** The threshold the walk used — the caller's, or 25.10's 800. */
  readonly thresholdChars: number;
  /**
   * Requirement 25.13's denominator: split units that carry at least one
   * non-whitespace character.
   *
   * "문장 개수" counted as *the units 25.11 would be allowed to cut between*, which is the
   * only counting rule this module can honestly apply — it has no sentence parser, and
   * 25.11 defines a sentence boundary by exactly these characters. Units that are pure
   * whitespace are excluded so the count is an upper bound on chunks rather than merely a
   * count of separators; see the module comment.
   */
  readonly sentenceCount: number;
  /** The original script, so the round trip can be stated without carrying it around. */
  readonly script: string;
}

export interface ScriptSplitOptions {
  /** Requirement 25.10's 분할 기준 문자 수. Defaults to 800. */
  readonly thresholdChars?: number;
}

/**
 * Requirement 25.11's split.
 *
 * A script no longer than the threshold yields exactly one chunk covering all of it, with
 * no cut to make — the common case, and the reason 25.11 is conditioned on "초과하면".
 */
export function splitScript(script: string, options: ScriptSplitOptions = {}): ScriptSplit {
  const thresholdChars = Math.max(1, options.thresholdChars ?? SPLIT_THRESHOLD_DEFAULT);
  const eligible = eligibleCutPositions(script);
  const sentenceCount = textBearingUnitCount(script, eligible);

  if (script.length <= thresholdChars) {
    return {
      chunks: script.length === 0 ? [] : [chunk(0, script, 0, script.length)],
      thresholdChars,
      sentenceCount,
      script,
    };
  }

  const cuts = greedyCuts(script, eligible, thresholdChars);
  const merged = mergeWhitespaceOnly(script, cuts);

  return {
    chunks: chunksFrom(script, merged),
    thresholdChars,
    sentenceCount,
    script,
  };
}

/**
 * Requirement 25.12's inverse: the chunks concatenated, in order.
 *
 * Equal to the original script for every input, which is the round-trip form of the order
 * invariant. Exported so the property test states the identity rather than reimplementing
 * the join it is checking.
 */
export function joinChunks(split: ScriptSplit): string {
  return split.chunks.map((piece) => piece.text).join('');
}

/** Requirement 25.12: chunk offsets are ascending and contiguous with no gap. */
export function isContiguousInOrder(split: ScriptSplit): boolean {
  let cursor = 0;
  for (const piece of split.chunks) {
    if (piece.startOffset !== cursor) return false;
    if (piece.endOffset <= piece.startOffset) return false;
    cursor = piece.endOffset;
  }
  return cursor === split.script.length;
}

/** Requirement 25.13, as a predicate over a produced split. */
export function respectsSentenceCount(split: ScriptSplit): boolean {
  return split.chunks.length <= split.sentenceCount;
}

/**
 * Requirement 25.11: every cut sits immediately after a newline or a terminator.
 *
 * Checked on the produced split rather than assumed, so a future change to the walk cannot
 * quietly start cutting mid-sentence.
 */
export function cutsAtPermittedPositions(split: ScriptSplit): boolean {
  return split.chunks.every((piece) => {
    if (piece.startOffset === 0) return true;
    const preceding = split.script[piece.startOffset - 1] ?? '';
    return preceding === '\n' || isSentenceTerminator(preceding);
  });
}

/**
 * Positions `i` in `0 < i < len` at which 25.11 permits a cut, ascending.
 *
 * `\r\n` needs no special case: a cut after the `\n` is eligible, and a cut after the `\r`
 * is not, so a CRLF script is never split between the two halves of its line ending.
 */
export function eligibleCutPositions(script: string): readonly number[] {
  const positions: number[] = [];
  for (let index = 1; index < script.length; index += 1) {
    const preceding = script[index - 1] ?? '';
    if (preceding === '\n' || isSentenceTerminator(preceding)) positions.push(index);
  }
  return positions;
}

/** The greedy walk described in the module comment. Returns cut positions, ascending. */
function greedyCuts(
  script: string,
  eligible: readonly number[],
  thresholdChars: number,
): readonly number[] {
  const cuts: number[] = [];
  let cursor = 0;
  // The eligible list is ascending, so the scan never restarts: `next` is the index of the
  // first eligible position strictly greater than the cursor.
  let next = 0;

  while (script.length - cursor > thresholdChars) {
    while (next < eligible.length && (eligible[next] ?? 0) <= cursor) next += 1;
    if (next >= eligible.length) break;

    // The last eligible position within the threshold, or — when there is none — the first
    // one beyond it. See the module comment on the overshoot case.
    let chosen = eligible[next] ?? 0;
    let scan = next;
    while (scan + 1 < eligible.length && (eligible[scan + 1] ?? 0) - cursor <= thresholdChars) {
      scan += 1;
      chosen = eligible[scan] ?? chosen;
    }

    cuts.push(chosen);
    cursor = chosen;
    next = scan + 1;
  }

  return cuts;
}

/**
 * Drops the cuts that would produce a whitespace-only chunk.
 *
 * Dropping a cut merges the chunk into its predecessor, which keeps the partition intact.
 * The scan runs left to right and re-measures against the surviving left boundary, so a run
 * of blank lines collapses into the preceding chunk rather than into each other.
 */
function mergeWhitespaceOnly(script: string, cuts: readonly number[]): readonly number[] {
  const kept: number[] = [];
  let left = 0;

  for (const cut of cuts) {
    if (script.slice(left, cut).trim().length === 0) continue;
    kept.push(cut);
    left = cut;
  }

  // The final chunk runs from the last surviving cut to the end. If it carries no text it is
  // merged backwards, by dropping the cut that created it.
  while (kept.length > 0 && script.slice(kept[kept.length - 1] ?? 0).trim().length === 0) {
    kept.pop();
  }

  return kept;
}

function chunksFrom(script: string, cuts: readonly number[]): readonly ScriptChunk[] {
  const boundaries = [0, ...cuts, script.length];
  const chunks: ScriptChunk[] = [];

  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? script.length;
    if (end <= start) continue;
    chunks.push(chunk(chunks.length, script.slice(start, end), start, end));
  }

  return chunks;
}

/**
 * Requirement 25.13's count: split units carrying at least one non-whitespace character.
 *
 * The units are the script cut at *every* eligible position — the finest split 25.11 allows
 * — so no reachable chunking can produce more text-bearing pieces than this.
 */
function textBearingUnitCount(script: string, eligible: readonly number[]): number {
  if (script.trim().length === 0) return script.length === 0 ? 0 : 1;

  const boundaries = [0, ...eligible, script.length];
  let count = 0;
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? script.length;
    if (script.slice(start, end).trim().length > 0) count += 1;
  }
  return count;
}

function chunk(index: number, text: string, startOffset: number, endOffset: number): ScriptChunk {
  return { index, text, startOffset, endOffset };
}
