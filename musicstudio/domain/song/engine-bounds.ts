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

/** Requirement 3.5. Not an engine constant: the product layer sets this bound. */
export const SONG_DESCRIPTION_MIN_LENGTH = 1;
export const SONG_DESCRIPTION_MAX_LENGTH = 2_000;

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
