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

import type { EditParameters } from '../../domain/edit/request';
import type { SongParameters } from '../../domain/song/request';

import { ACE_DEFAULT_TASK_TYPE, aceTaskTypeForEditKind, type AceTaskType } from './task-type';

/** Engine sentinel for "no explicit seed": `seed: Union[int, str] = -1`. */
export const ACE_RANDOM_SEED_SENTINEL = -1;

export interface AceSubmitPayloadInput {
  readonly song: SongParameters;
  /**
   * Overrides the task type.
   *
   * Normally unnecessary: with `edit` supplied the task type follows the edit kind
   * (Requirements 7.1, 7.3, 7.6–7.8), and without it the task is `text2music`. The
   * override exists for the `cover-nofsq` variant, which no requirement names.
   */
  readonly taskType?: AceTaskType;
  /** Requirement 7's Edit_Task parameters; absent for a plain generation. */
  readonly edit?: EditParameters;
}

export type AceSubmitPayload = Readonly<Record<string, unknown>>;

export function buildAceSubmitPayload(input: AceSubmitPayloadInput): AceSubmitPayload {
  const { song, edit } = input;

  return {
    task_type: input.taskType ?? taskTypeFor(edit),

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

    // Requirement 7.
    ...(edit === undefined ? {} : editFields(edit)),
  };
}

function taskTypeFor(edit: EditParameters | undefined): AceTaskType {
  return edit === undefined ? ACE_DEFAULT_TASK_TYPE : aceTaskTypeForEditKind(edit.kind);
}

/**
 * The Edit_Task fields (Requirements 7.1–7.3, 7.6–7.8).
 *
 * Every name below is transcribed from `GenerateMusicRequest` in
 * `acestep/api/http/release_task_models.py`, and the same omission discipline as the
 * song fields applies: a parameter the caller did not set is absent, not defaulted,
 * so the engine's own default stands.
 *
 * `src_audio_path` rather than `reference_audio_path` — the two are different inputs.
 * `_prepare_reference_and_source_audio` in
 * `acestep/core/generation/handler/generate_music_request.py` treats `src_audio` as
 * the audio being *operated on* and requires it for cover, repaint, extract and lego;
 * `reference_audio` is a separate style reference the requirements do not mention.
 * `complete` is absent from that required set in the engine, but Requirement 7.8 says
 * the audio is passed, and it must be — completing nothing is not a task — so the
 * source travels on the same field for all five kinds.
 */
function editFields(edit: EditParameters): Readonly<Record<string, unknown>> {
  return {
    // Requirements 7.1, 7.8: the source audio, on the field the engine reads it from.
    src_audio_path: edit.source.enginePath,

    // Requirement 7.9's selected model, so the engine runs the checkpoint the
    // capability check was made against rather than whichever is loaded.
    model: edit.model,

    // Requirement 7.2.
    ...(edit.coverStrength === undefined ? {} : { audio_cover_strength: edit.coverStrength }),

    // Requirement 7.3. Sent as a pair or not at all: the engine's `repainting_start`
    // defaults to 0.0, so sending one bound alone would silently repaint from the
    // beginning.
    ...(edit.repaintStartSeconds === undefined || edit.repaintEndSeconds === undefined
      ? {}
      : {
          repainting_start: edit.repaintStartSeconds,
          repainting_end: edit.repaintEndSeconds,
        }),

    // Requirements 7.6, 7.7.
    ...(edit.trackName === undefined ? {} : { track_name: edit.trackName }),

    // Requirement 7.8's optional track list.
    ...(edit.trackClasses === undefined ? {} : { track_classes: [...edit.trackClasses] }),
  };
}
