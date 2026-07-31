/**
 * Normalised generation request and result (design §3.5, Requirement 20.18).
 *
 * Every engine sees the same request shape and every engine's answer is folded
 * into the same result shape, with all six Requirement 20.18 fields populated:
 * Asset_Kind, duration, sample rate, seed, engine identifier, job status.
 */

import type { AssetKind } from '../domain/asset-kind';
import { CANONICAL_SAMPLE_RATE } from '../domain/provenance';
import type { SongParameters } from '../domain/song/request';

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
