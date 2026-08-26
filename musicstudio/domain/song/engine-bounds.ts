/**
 * ACE-Step's accepted ranges for song metadata, in one place.
 *
 * Every value below is transcribed from a named symbol in the engine's
 * `acestep/constants.py`. The engine is reached only over HTTP (design §1.4.4),
 * so its bounds cannot be imported — they are mirrored here, each with the symbol
 * it came from, so a divergence is a one-line correction in this file rather than
 * a hunt through validators.
 *
 * `test/unit/song/engine-bounds.test.ts` pins the counts the requirements quote
 * (70 key/scale combinations, 50 vocal languages), so a silent drift fails there.
 */

/** `acestep/constants.py`: `BPM_MIN`, `BPM_MAX`. Requirement 4.3. */
export const SONG_BPM_MIN = 30;
export const SONG_BPM_MAX = 300;

/** `acestep/constants.py`: `DURATION_MIN`, `DURATION_MAX` (seconds). Requirement 4.2. */
export const SONG_DURATION_SECONDS_MIN = 10;
export const SONG_DURATION_SECONDS_MAX = 600;

/**
 * `acestep/constants.py`: `VALID_TIME_SIGNATURES`. Requirement 4.4.
 *
 * The engine stores only the numerator (`"2"`, `"3"`, `"4"`, `"6"` — see the
 * `time_signature` dropdown in `acestep/ui/gradio/interfaces/`), so the product
 * layer models it as that single integer rather than as a `n/m` pair.
 */
export const SONG_TIME_SIGNATURES = [2, 3, 4, 6] as const;

export type SongTimeSignature = (typeof SONG_TIME_SIGNATURES)[number];

/**
 * Requirement 3.5. Not an engine constant: the product layer sets this bound.
 *
 * This bounds Simple_Mode's natural-language *description*, which reaches the engine as
 * `sample_query` — the language model's input, from which it writes the caption. It is a different
 * field from `caption` below, and the engine documents no length for it, so 2000 stands as the
 * product's own number.
 */
export const SONG_DESCRIPTION_MIN_LENGTH = 1;
export const SONG_DESCRIPTION_MAX_LENGTH = 2_000;

/**
 * `acestep/inference.py`: "caption: A short text prompt describing the desired music (main
 * prompt). **< 512 characters**".
 *
 * ### Why this is a rejection and not a truncation
 *
 * The engine does not refuse a longer caption. It tokenises with `truncation=True` and generates
 * from whatever survived, so a 1200-character caption produces a track built from roughly the
 * first half of what the user asked for, with nothing anywhere saying so. The user's evidence that
 * their instruction was dropped is that the music does not match it.
 *
 * The product layer validated nothing here — Requirement 4 bounds duration, BPM, time signature,
 * key, batch and seed, and says nothing about caption length — so every caption above the engine's
 * limit was silently cut. Rejecting with the allowance is the only option that leaves the user able
 * to act: they can shorten the caption themselves and keep the part they care about, which is a
 * choice the tokenizer was making for them.
 *
 * Requirement 4.1 is the precedent. It insists the lyric text reach the engine **untruncated**;
 * this is the same commitment for the field beside it, enforced at the only place that can enforce
 * it — before the request is sent.
 */
export const SONG_CAPTION_MIN_LENGTH = 1;
export const SONG_CAPTION_MAX_LENGTH = 512;

/**
 * Requirement 4.8.
 *
 * `acestep/constants.py` does not carry this bound; the engine expresses it as
 * `max_batch_size_with_lm` / `max_batch_size_without_lm` in
 * `acestep/gpu_config.py`, whose highest tier is 8.
 */
export const SONG_BATCH_SIZE_MIN = 1;
export const SONG_BATCH_SIZE_MAX = 8;

/**
 * Rate the engine emits, and the rate design §3.5 normalises to.
 *
 * Also absent from `acestep/constants.py`: the engine hard-codes it as
 * `MP3_DEFAULT_SAMPLE_RATE` in `acestep/audio_utils.py` and resamples every input
 * to it in `acestep/core/generation/handler/io_audio.py`.
 */
export const ACE_ENGINE_SAMPLE_RATE = 48_000;

export function isSongTimeSignature(value: unknown): value is SongTimeSignature {
  return (
    typeof value === 'number' && (SONG_TIME_SIGNATURES as readonly number[]).includes(value)
  );
}

export function isSongBpm(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= SONG_BPM_MIN && (value as number) <= SONG_BPM_MAX;
}

export function isSongDurationSeconds(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= SONG_DURATION_SECONDS_MIN &&
    value <= SONG_DURATION_SECONDS_MAX
  );
}

export function isSongBatchSize(value: unknown): boolean {
  return (
    Number.isInteger(value) &&
    (value as number) >= SONG_BATCH_SIZE_MIN &&
    (value as number) <= SONG_BATCH_SIZE_MAX
  );
}
