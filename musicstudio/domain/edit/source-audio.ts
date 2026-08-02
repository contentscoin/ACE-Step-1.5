/**
 * The uploaded source audio an Edit_Task consumes (Requirements 7.10, 7.11).
 *
 * Requirement 7.10 names three constraints — container format, length and byte
 * size — and 7.11 requires a refusal that states the violated one *and* its allowed
 * value. Both are decided here, purely: a descriptor in, either the accepted form
 * or the complete list of violations out. Nothing reads a file, so the whole
 * rejection surface is testable without storage.
 *
 * The three bounds are product policy, not engine bounds. The engine imposes none
 * of them: `process_src_audio` will decode whatever `torchaudio` can open, of any
 * length. `SOURCE_AUDIO_MAX_DURATION_SECONDS` coincides with the engine's
 * `DURATION_MAX` (600) but is stated separately because it constrains an *input*
 * rather than an output, and the two could legitimately diverge.
 *
 * `enginePath` is the one field the product layer cannot invent. ACE-Step's
 * `/release_task` takes the source audio as `src_audio_path`, a location the engine
 * process can itself open (`validate_audio_path` in
 * `acestep/api/http/release_task_audio_paths.py` accepts a temp-directory path or a
 * relative one). Producing that location is the Library_Service's job — see
 * `services/generation/edit-ports.ts`.
 */

import {
  editEnumViolation,
  editRangeViolation,
  editSizeViolation,
  type EditFieldViolation,
} from './violation';

/** Requirement 7.10: the three accepted container formats. */
export const SOURCE_AUDIO_FORMATS = ['mp3', 'wav', 'flac'] as const;

export type SourceAudioFormat = (typeof SOURCE_AUDIO_FORMATS)[number];

/** Requirement 7.10: length ceiling, in seconds. */
export const SOURCE_AUDIO_MIN_DURATION_SECONDS = 0;
export const SOURCE_AUDIO_MAX_DURATION_SECONDS = 600;

/** Requirement 7.10: 50 MB, counted as binary megabytes. */
export const SOURCE_AUDIO_MAX_BYTES = 50 * 1024 * 1024;

export function isSourceAudioFormat(value: unknown): value is SourceAudioFormat {
  return typeof value === 'string' && (SOURCE_AUDIO_FORMATS as readonly string[]).includes(value);
}

/**
 * What is known about the audio an edit will start from.
 *
 * `assetId` is the Audio_Asset the edit derives from, which is also what
 * Requirement 7.12 records as the lineage parent. A freshly uploaded file becomes an
 * Audio_Asset before it can be edited, so there is one identifier rather than two.
 */
export interface SourceAudioDescriptor {
  readonly assetId: string;
  readonly format: string;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
  /** Location `src_audio_path` will carry; opaque to everything above the adapter. */
  readonly enginePath: string;
}

/** A descriptor that has passed Requirement 7.10. */
export interface SourceAudio extends SourceAudioDescriptor {
  readonly format: SourceAudioFormat;
}

export type SourceAudioValidation =
  | { readonly kind: 'valid'; readonly source: SourceAudio }
  | { readonly kind: 'invalid'; readonly violations: readonly EditFieldViolation[] };

/**
 * Requirement 7.10, with every violated constraint reported at once.
 *
 * All three are checked rather than stopping at the first, for the same reason
 * Requirement 4.6 reports every out-of-range field: a caller fixing one constraint
 * per round trip is a worse product than one told everything.
 */
export function validateSourceAudio(
  descriptor: SourceAudioDescriptor,
): SourceAudioValidation {
  const violations: EditFieldViolation[] = [];
  const format = descriptor.format;

  if (!isSourceAudioFormat(format)) {
    violations.push(editEnumViolation('sourceAudio.format', format, SOURCE_AUDIO_FORMATS));
  }

  if (
    !Number.isFinite(descriptor.durationSeconds) ||
    descriptor.durationSeconds <= SOURCE_AUDIO_MIN_DURATION_SECONDS ||
    descriptor.durationSeconds > SOURCE_AUDIO_MAX_DURATION_SECONDS
  ) {
    violations.push(
      editRangeViolation(
        'sourceAudio.durationSeconds',
        descriptor.durationSeconds,
        SOURCE_AUDIO_MIN_DURATION_SECONDS,
        SOURCE_AUDIO_MAX_DURATION_SECONDS,
      ),
    );
  }

  if (
    !Number.isInteger(descriptor.sizeBytes) ||
    descriptor.sizeBytes <= 0 ||
    descriptor.sizeBytes > SOURCE_AUDIO_MAX_BYTES
  ) {
    violations.push(
      editSizeViolation('sourceAudio.sizeBytes', descriptor.sizeBytes, SOURCE_AUDIO_MAX_BYTES),
    );
  }

  if (violations.length > 0 || !isSourceAudioFormat(format)) {
    return { kind: 'invalid', violations };
  }
  // The guard is what narrows `format`, so the accepted form needs no cast.
  return { kind: 'valid', source: { ...descriptor, format } };
}
