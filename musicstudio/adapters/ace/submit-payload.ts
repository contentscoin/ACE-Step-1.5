/**
 * The `/release_task` request body (Requirements 3.1–3.3, 3.6, 3.7, 4.1–4.5,
 * 4.7–4.10).
 *
 * This is the only module in the product layer that knows ACE-Step's field names.
 * Every field it writes is transcribed from `GenerateMusicRequest` in
 * `acestep/api/http/release_task_models.py`, and every field it *declines* to write
 * is a requirement:
 *
 * - Requirement 3.3 / 4.7: a metadata field the user left empty is **omitted**, not
 *   defaulted. The engine treats an absent `bpm` / `key_scale` / `time_signature` /
 *   `audio_duration` as "fill this in yourself" — see the `user_metadata` assembly
 *   in `acestep/inference.py`, which only forwards non-empty values to the LM. A
 *   default written here would silently overrule the user's choice not to choose.
 * - Nothing that the requirements do not mention is sent at all. Sampler settings,
 *   model selection, LM decoding parameters and output format all have engine-side
 *   defaults; restating them here would fork them.
 *
 * The payload is a plain record rather than a class so a test can compare it whole
 * against the expected wire form.
 */

import type { SongParameters } from '../../domain/song/request';

import { ACE_DEFAULT_TASK_TYPE, type AceTaskType } from './task-type';

/** Engine sentinel for "no explicit seed": `seed: Union[int, str] = -1`. */
export const ACE_RANDOM_SEED_SENTINEL = -1;

export interface AceSubmitPayloadInput {
  readonly song: SongParameters;
  /** Defaults to `text2music`; task 2.2 supplies the edit tasks. */
  readonly taskType?: AceTaskType;
}

export type AceSubmitPayload = Readonly<Record<string, unknown>>;

export function buildAceSubmitPayload(input: AceSubmitPayloadInput): AceSubmitPayload {
  const { song } = input;

  return {
    task_type: input.taskType ?? ACE_DEFAULT_TASK_TYPE,

    // Requirement 3.1: Simple_Mode turns on sample mode and passes the natural
    // language description as `sample_query`. Requirement 3.6's random generation
    // is the same call with no description, which is what makes the engine draw
    // random sample parameters.
    sample_mode: song.sampleMode,
    ...(song.description === undefined ? {} : { sample_query: song.description }),

    // Requirement 3.2. Resolved in the domain layer, so the default is stated once.
    thinking: song.thinking,

    // Requirement 4.1: the caption and the *entire* lyric text, never truncated.
    // Requirement 4.9's instrumental indicator arrives already substituted into
    // `lyrics`, because that field is how the engine is told there is no vocal.
    ...(song.caption === undefined ? {} : { prompt: song.caption }),
    ...(song.lyrics === undefined ? {} : { lyrics: song.lyrics }),

    // Requirements 4.2–4.5, and 3.3/4.7 by omission.
    ...(song.bpm === undefined ? {} : { bpm: song.bpm }),
    ...(song.keyScale === undefined ? {} : { key_scale: song.keyScale }),
    ...(song.timeSignature === undefined
      ? {}
      : // The engine's `time_signature` is a string holding only the numerator
        // (`""`, `"2"`, `"3"`, `"4"`, `"6"`).
        { time_signature: String(song.timeSignature) }),
    ...(song.durationSeconds === undefined ? {} : { audio_duration: song.durationSeconds }),

    // Requirement 3.7.
    ...(song.vocalLanguage === undefined ? {} : { vocal_language: song.vocalLanguage }),

    // Requirement 4.8.
    batch_size: song.batchSize,

    // Requirement 4.10: an explicit seed turns off random seeding, so the same
    // input reproduces the same audio. With no seed the engine keeps its own
    // randomness and the sentinel makes that explicit rather than implied.
    ...(song.seed === undefined
      ? { use_random_seed: true, seed: ACE_RANDOM_SEED_SENTINEL }
      : { use_random_seed: false, seed: song.seed }),
  };
}
