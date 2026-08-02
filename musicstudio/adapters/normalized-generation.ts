/**
 * Normalised generation request and result (design §3.5, Requirement 20.18).
 *
 * Every engine sees the same request shape and every engine's answer is folded
 * into the same result shape, with all six Requirement 20.18 fields populated:
 * Asset_Kind, duration, sample rate, seed, engine identifier, job status.
 */

import type { AssetKind } from '../domain/asset-kind';
import type { EditParameters } from '../domain/edit/request';
import { CANONICAL_SAMPLE_RATE } from '../domain/provenance';
import type { SfxParameters } from '../domain/sfx/request';
import type { SongParameters } from '../domain/song/request';
import type { SpeechParameters } from '../domain/speech/request';

import { ENGINE_JOB_STATE, type EngineJobState, type RawAudioResult } from './engine-job';

export const INPUT_MODALITIES = ['text', 'audio', 'video'] as const;

export type InputModality = (typeof INPUT_MODALITIES)[number];

export function isInputModality(value: unknown): value is InputModality {
  return typeof value === 'string' && (INPUT_MODALITIES as readonly string[]).includes(value);
}

/**
 * Fixed sentinel stored when an engine reports no seed (design §3.5).
 *
 * A sentinel rather than `null` in storage keeps Requirement 20.18's "all six
 * fields populated" true for the persisted record while still being
 * distinguishable from any real seed, which engines express as a non-negative
 * integer.
 */
export const SEED_UNSPECIFIED = -1;

export interface NormalizedGenerationRequest {
  readonly requestId: string;
  readonly accountId: string;
  readonly assetKind: AssetKind;
  readonly inputModality: InputModality;
  readonly durationMs: number;
  /** Text prompt, lyric block or instruction, depending on `inputModality`. */
  readonly prompt?: string;
  /** Existing asset identifiers used as input (stem, cover, repaint, mix). */
  readonly inputAssetIds?: readonly string[];
  /** Caller-provided seed; `null` lets the engine choose. */
  readonly seed?: number | null;
  /** Engine chosen explicitly by the caller (Requirement 20.3). */
  readonly engineId?: string;
  /**
   * Validated song parameters (Requirements 3, 4), present for Simple/Custom mode
   * song requests.
   *
   * Musical vocabulary, not engine vocabulary: caption, lyrics, BPM, key/scale,
   * time signature, batch size. Translating those into any one engine's field names
   * stays inside that engine's adapter, so nothing above the adapter layer learns
   * an engine's spelling. Absent for requests that carry only a prompt, which every
   * engine understands without help.
   */
  readonly song?: SongParameters;
  /**
   * Validated Edit_Task parameters (Requirement 7), present for cover, repaint,
   * extract, lego and complete requests.
   *
   * Editing vocabulary, not engine vocabulary — a source audio, a strength, an
   * interval, a track name — for the same reason `song` is: the translation to
   * `src_audio_path` / `audio_cover_strength` / `repainting_start` / `track_name`
   * belongs to the engine's adapter. It carries the validated source descriptor, so
   * `inputAssetIds` remains the routing-level statement of which assets are inputs
   * and this is the statement of what the edit does with them.
   */
  readonly edit?: EditParameters;
  /**
   * Validated sound-effect parameters (Requirement 22), present for `sfx` requests.
   *
   * Present for the same reason `song` and `edit` are, and translated for the same reason:
   * Requirements 22.10–22.12 give the sampling step count and guidance scale as *product*
   * concepts with product ranges, and turning them into whatever field names a Woosh
   * deployment uses stays inside `adapters/woosh/`. Nothing above the adapter layer learns
   * an engine's spelling.
   *
   * Note that `seed` is not read from here. A request produces up to eight variants
   * (22.5, 22.16), each a separate submission with a seed derived from the base
   * (`domain/sfx/seed.ts`), so the per-submission seed is the one on `seed` above and
   * `sfx.seed` records only what the caller named.
   */
  readonly sfx?: SfxParameters;
  /**
   * Validated dialogue parameters (Requirement 25), present for `dialogue` requests.
   *
   * Present for the same reason `song`, `edit` and `sfx` are, and translated for the same
   * reason: 25.5's 발화 속도, 25.6's 음높이 조정 and 25.7's 연기 지시 are *product* concepts with
   * product ranges, and turning them into whatever field names a TTS deployment uses stays
   * inside `adapters/tts/`. The two engines design §3.6 names for `dialogue` spell all three
   * differently, which is precisely why nothing above the adapter layer learns either spelling.
   *
   * Note that `seed` is not read from here. A dialogue asset is synthesised one line at a time
   * (Requirements 25.14, 25.15), each submission carrying a seed derived from the base by
   * `domain/sfx/seed.ts`, so the per-submission seed is the one on `seed` above and
   * `speech.seed` records only what the caller named.
   */
  readonly speech?: SpeechParameters;
}

export interface NormalizedGenerationResult {
  readonly assetKind: AssetKind;
  readonly durationMs: number;
  /** Always 48 kHz: the stored form is resampled (design §3.5). */
  readonly sampleRate: number;
  readonly seed: number;
  readonly engineId: string;
  readonly status: 'success' | 'failed';
  readonly audioBuffer: Buffer;
  /** Engine-native rate, retained for provenance (Requirement 19.5). */
  readonly originalSampleRate: number;
}

export interface NormalizationInput {
  readonly assetKind: AssetKind;
  readonly engineId: string;
  readonly jobState: EngineJobState;
  readonly raw: RawAudioResult;
}

/**
 * Requirement 20.18: fold one engine answer into the single normalised form.
 *
 * `sampleRate` is reported as the canonical 48 kHz because §3.5 defines the
 * normalised form as post-resampling; the engine-native rate survives in
 * `originalSampleRate` so the DSP stage and provenance record can both use it.
 */
export function normalizeEngineResult(input: NormalizationInput): NormalizedGenerationResult {
  return {
    assetKind: input.assetKind,
    durationMs: input.raw.durationMs,
    sampleRate: CANONICAL_SAMPLE_RATE,
    seed: input.raw.seed ?? SEED_UNSPECIFIED,
    engineId: input.engineId,
    status: input.jobState === ENGINE_JOB_STATE.succeeded ? 'success' : 'failed',
    audioBuffer: input.raw.audioBuffer,
    originalSampleRate: input.raw.sampleRate,
  };
}

/** Guard for Requirement 20.18: none of the six fields may be left blank. */
export function isFullyNormalized(result: NormalizedGenerationResult): boolean {
  return (
    result.assetKind.length > 0 &&
    Number.isFinite(result.durationMs) &&
    result.sampleRate === CANONICAL_SAMPLE_RATE &&
    Number.isInteger(result.seed) &&
    result.engineId.length > 0 &&
    (result.status === 'success' || result.status === 'failed')
  );
}
