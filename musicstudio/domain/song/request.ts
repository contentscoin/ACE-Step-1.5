/**
 * Song generation request vocabulary (Requirements 3, 4).
 *
 * Engine-agnostic on purpose: these are musical concepts (caption, lyrics, BPM,
 * key/scale, time signature, batch size), not ACE-Step field names. The mapping
 * to `sample_mode` / `key_scale` / `batch_size` and the rest of the wire form
 * happens only in `adapters/ace/`, which is what keeps design §1.2's engine
 * transparency true of everything above the adapter layer.
 */

import type { SongTimeSignature } from './engine-bounds';

export const SONG_MODES = ['simple', 'custom'] as const;

export type SongMode = (typeof SONG_MODES)[number];

/**
 * Requirement 4.9's instrumental indicator.
 *
 * The engine detects an instrumental request by comparing the lyrics field
 * against `[inst]` / `[instrumental]` (`is_instrumental` in
 * `acestep/api/server_utils.py`), so the indicator *is* the lyrics value rather
 * than a separate flag on the wire.
 */
export const INSTRUMENTAL_LYRICS = '[instrumental]';

/**
 * Simple_Mode input (Requirement 3).
 *
 * `description` omitted means Requirement 3.6's random generation. An empty
 * string is not the same thing: it is a supplied description that violates
 * Requirement 3.5, and is rejected as such.
 */
export interface SimpleModeSongRequest {
  readonly mode: 'simple';
  readonly description?: string;
  /** Requirement 3.2 default is `true`; only an explicit `false` disables it. */
  readonly thinking?: boolean;
  /** Omitted leaves the length to the engine (Requirement 3.3). */
  readonly durationSeconds?: number;
  readonly vocalLanguage?: string;
  readonly batchSize?: number;
  /** Requirement 4.10 reproducibility; omitted means a random seed. */
  readonly seed?: number;
}

/** Custom_Mode input (Requirement 4). Every metadata field may be left empty (4.7). */
export interface CustomModeSongRequest {
  readonly mode: 'custom';
  readonly caption?: string;
  readonly lyrics?: string;
  readonly instrumental?: boolean;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: number;
  readonly durationSeconds?: number;
  readonly vocalLanguage?: string;
  readonly batchSize?: number;
  readonly seed?: number;
  readonly thinking?: boolean;
}

export type SongGenerationRequest = SimpleModeSongRequest | CustomModeSongRequest;

/**
 * A request that has passed validation.
 *
 * Absent optional fields are meaningful: they are the fields Requirements 3.3 and
 * 4.7 require to reach the engine empty so its metadata auto-completion fills
 * them. Nothing downstream may substitute a default for them.
 */
export interface SongParameters {
  readonly mode: SongMode;
  /** Requirement 3.1: `sample_mode` is on for Simple_Mode and off for Custom_Mode. */
  readonly sampleMode: boolean;
  /** Requirement 3.2. */
  readonly thinking: boolean;
  /** Requirement 3.1: travels as `sample_query`. Absent for Requirement 3.6. */
  readonly description?: string;
  readonly caption?: string;
  /** Requirement 4.1: exactly what the user wrote, never truncated. */
  readonly lyrics?: string;
  /** Requirement 4.9. */
  readonly instrumental: boolean;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: SongTimeSignature;
  readonly durationSeconds?: number;
  readonly vocalLanguage?: string;
  /** Requirement 4.8, always resolved: 1 when the caller asked for no count. */
  readonly batchSize: number;
  /** Requirement 4.10. Absent means the engine picks a random seed. */
  readonly seed?: number;
}
