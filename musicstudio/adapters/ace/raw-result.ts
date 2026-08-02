/**
 * Turning downloaded audio into `RawAudioResult` (design §3.5; Requirement 3.4).
 *
 * `RawAudioResult` is task 1.3's shape and stays exactly as it is. The engine has
 * one more thing to say than it can hold — the final caption, lyrics, BPM, key,
 * time signature and length Requirement 3.4 asks to be stored — so this module
 * returns a *widening* of it: `AceRawAudioResult` is a `RawAudioResult` with
 * `trackMetadata` attached. Anything typed against the interface sees the plain
 * form and is unaffected; the Library layer narrows with `hasTrackMetadata` to
 * store the six values.
 *
 * Two fields are worth their comments:
 *
 * - `sampleRate` is the engine's own rate, not the canonical 48 kHz. Design §3.5
 *   makes normalisation `normalizeEngineResult`'s job, and it keeps the engine rate
 *   as `originalSampleRate` for provenance (Requirement 19.5).
 * - `seed` is always `null`. The engine does record the seeds it used
 *   (`seed_value` in its job result), but `/query_result` drops that field when it
 *   builds the per-file response, so the adapter genuinely cannot observe it.
 *   §3.5 already defines that case: `null` becomes the `SEED_UNSPECIFIED` sentinel.
 *   Requirement 4.10's reproducibility rests on the seed the adapter *sends*, which
 *   `buildAceSubmitPayload` puts on the wire.
 */

import type { RawAudioResult } from '../engine-job';
import type { SongTrackMetadata } from '../../domain/song/track-metadata';

import type { AceResultEntry } from './query-result';

export interface AceRawAudioResult extends RawAudioResult {
  /** Requirement 3.4: what the engine finally used. */
  readonly trackMetadata: SongTrackMetadata;
}

export interface AceDownloadedAudio {
  readonly entry: AceResultEntry;
  readonly audioBuffer: Buffer;
}

export function toRawAudioResults(
  downloads: readonly AceDownloadedAudio[],
  sampleRate: number,
): AceRawAudioResult[] {
  return downloads.map((download) => ({
    audioBuffer: download.audioBuffer,
    sampleRate,
    durationMs: durationMsOf(download.entry.metadata.durationSeconds),
    seed: null,
    trackMetadata: download.entry.metadata,
  }));
}

export function hasTrackMetadata(result: RawAudioResult): result is AceRawAudioResult {
  return 'trackMetadata' in result;
}

/**
 * The engine reports length in whole or fractional seconds; 0 when it reports none.
 *
 * 0 rather than a guess: `normalizeEngineResult` requires a finite number, and an
 * invented length would be indistinguishable from a measured one downstream. A DSP
 * stage that needs the true length reads it from the audio.
 */
function durationMsOf(durationSeconds: number | null): number {
  return durationSeconds === null ? 0 : Math.round(durationSeconds * 1000);
}
