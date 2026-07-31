/**
 * The 70 key/scale combinations ACE-Step accepts (Requirement 4.5).
 *
 * Derived exactly as the engine derives them in `acestep/constants.py`:
 *
 *   VALID_KEYSCALES = {f"{note}{accidental} {mode}"
 *                      for note in KEYSCALE_NOTES        # 7
 *                      for accidental in KEYSCALE_ACCIDENTALS  # 5
 *                      for mode in KEYSCALE_MODES}       # 2
 *
 * 7 x 5 x 2 = 70, which is the count Requirement 4.5 quotes. The list is
 * *generated* rather than written out so it cannot fall out of step with the
 * three source lists, and so the count is a consequence rather than a claim.
 *
 * Note that the accidental list is a notation set, not a pitch set: `#`/`♯` and
 * `b`/`♭` are the same pitch spelled two ways, so the 70 combinations cover 24
 * distinct keys. That is the engine's own model and the product layer mirrors it
 * verbatim, because the string is what travels on the wire.
 */

/** `acestep/constants.py`: `KEYSCALE_NOTES`. */
export const KEY_SCALE_NOTES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

/** `acestep/constants.py`: `KEYSCALE_ACCIDENTALS` — natural, ASCII and Unicode. */
export const KEY_SCALE_ACCIDENTALS = ['', '#', 'b', '\u266F', '\u266D'] as const;

/** `acestep/constants.py`: `KEYSCALE_MODES`. */
export const KEY_SCALE_MODES = ['major', 'minor'] as const;

function deriveKeyScales(): readonly string[] {
  const combinations: string[] = [];
  for (const note of KEY_SCALE_NOTES) {
    for (const accidental of KEY_SCALE_ACCIDENTALS) {
      for (const mode of KEY_SCALE_MODES) {
        combinations.push(`${note}${accidental} ${mode}`);
      }
    }
  }
  return combinations;
}

/** All 70 combinations, in note-major order. */
export const VALID_KEY_SCALES: readonly string[] = deriveKeyScales();

const KEY_SCALE_SET: ReadonlySet<string> = new Set(VALID_KEY_SCALES);

/**
 * Requirement 4.5 membership test.
 *
 * Matching is exact: the engine compares the string against its own set
 * (`acestep/constrained_logits_processor.py`), so a case- or spacing-tolerant
 * check here would accept requests the engine then rejects.
 */
export function isKeyScale(value: unknown): value is string {
  return typeof value === 'string' && KEY_SCALE_SET.has(value);
}
