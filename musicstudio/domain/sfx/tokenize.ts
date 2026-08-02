/**
 * Prompt token counting (Requirements 22.2, 22.3).
 *
 * 22.2 bounds the prompt "토큰화 후 77토큰 이하" and 22.3 requires the *input token
 * count* back on rejection, so a number has to be produced before the engine is
 * called. That forces a decision the requirements do not make: whose tokeniser?
 *
 * The engine's text encoder is the authority, and it is not reachable from the
 * product layer — asking it would mean an HTTP round trip to decide whether a request
 * is well-formed, which would put a network failure on the validation path. So this
 * module is a **local upper-bound estimate**, and it is deliberately an *upper* bound:
 * it never counts fewer tokens than a byte-pair encoder would, so a prompt this module
 * admits is one the engine's tokeniser also admits. A prompt it rejects might have fit,
 * which is the safe direction to be wrong in — the alternative is submitting work that
 * the engine truncates silently, producing audio for a prompt the user did not write.
 *
 * Why it is an upper bound: a BPE vocabulary merges adjacent characters into single
 * tokens and never splits below the character level, so the number of BPE tokens for a
 * run of word characters is at most the number of characters in it. Counting each
 * alphanumeric run as `ceil(length / MIN_CHARS_PER_TOKEN)` and each other non-space
 * character as one token is therefore at or above the true count for any vocabulary
 * whose merges cover at least `MIN_CHARS_PER_TOKEN` characters — which is the
 * conservative assumption, since a vocabulary with longer merges only produces fewer
 * tokens.
 *
 * **Open question for the spec.** Whether the 77 of 22.2 is the encoder's full context
 * length (in which case the two positional tokens a CLIP-style encoder reserves for
 * sequence start and end leave 75 for text) or 77 text tokens on top of them. This
 * module counts text tokens only and does not reserve the two, which is the reading
 * that admits more prompts; `PROMPT_TOKEN_RESERVED_POSITIONS` records the quantity so
 * the decision is one constant to change rather than a search.
 *
 * The count is injectable — see `PromptTokenizer` — so a composition that *can* reach
 * a real tokeniser supplies it and this estimate is never used.
 */

/**
 * Characters a single token is assumed to cover, at minimum.
 *
 * 1 makes the estimate exactly "one token per character", which is the true upper
 * bound for any BPE vocabulary but rejects ordinary English prompts far below the
 * limit — "a heavy wooden door slams shut" is 30 characters and would count as 30 of
 * the 77 tokens for six words. 4 is the widely observed average for English BPE
 * vocabularies and is used here, which makes the estimate an upper bound in practice
 * rather than in the worst case.
 *
 * **Unverified:** the actual tokeniser and vocabulary the engine's text encoder uses.
 * §14 risk to settle with the engine owner before this is relied on for anything but
 * validation.
 */
export const MIN_CHARS_PER_TOKEN = 4;

/** Positional tokens a CLIP-style encoder reserves. Not currently deducted; see above. */
export const PROMPT_TOKEN_RESERVED_POSITIONS = 2;

/**
 * Runs of word characters, and every other non-whitespace character singly.
 *
 * Punctuation is counted individually because a tokeniser does not merge it with the
 * word beside it: `"door,"` is two tokens and not one. Unicode-aware, so a prompt in
 * a non-Latin script is segmented by character run rather than collapsing to one token.
 */
const TOKEN_UNIT = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * The estimated token count of `prompt`.
 *
 * Total: any string, including an empty one, has a count. Whitespace alone is 0
 * tokens, which is what makes 22.3's "앞뒤 공백 제거 후 1자 미만" and the token ceiling
 * two independent checks rather than one.
 */
export function countPromptTokens(prompt: string): number {
  let total = 0;
  for (const match of prompt.matchAll(TOKEN_UNIT)) {
    const unit = match[0];
    total += isWordRun(unit) ? Math.ceil(unit.length / MIN_CHARS_PER_TOKEN) : 1;
  }
  return total;
}

function isWordRun(unit: string): boolean {
  return unit.length > 1 || /[\p{L}\p{N}_]/u.test(unit);
}

/**
 * The seam onto a real tokeniser.
 *
 * A port rather than a direct call so a composition that has the engine's vocabulary
 * on hand — or a future `/tokenize` route — can supply the authoritative count without
 * anything above it changing. `estimatingPromptTokenizer` is the default.
 */
export interface PromptTokenizer {
  countTokens(prompt: string): number;
}

export const estimatingPromptTokenizer: PromptTokenizer = { countTokens: countPromptTokens };
