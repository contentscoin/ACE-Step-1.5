/**
 * Narrow outbound ports of the Sound_Pack_Service.
 *
 * Same discipline as `sfx-ports.ts` and `bgm-ports.ts`: each is the seam to something this
 * task does not build, stated in the shape Requirement 24 needs.
 *
 * Note what is **not** here. There is no cue-generation port, no credit port and no
 * rejection port, because a sound pack is 78 sound-effect generations and `SfxService`
 * already owns all three. The pack service drives it; it does not reach past it. That is
 * what keeps the refund path single (see `sound-pack-service.ts`).
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { CueMfccVector } from '../../domain/sound-pack/similarity';
import type { PackExportReport } from '../../domain/sound-pack/export';
import type { CuePackManifest } from '../../domain/sound-pack/manifest';

/** One cue's audio, named, as the pack holds it. */
export interface PackCueAudio {
  readonly cueName: string;
  readonly audio: PcmAudio;
}

/**
 * Requirement 24.9's measurement: one 13-dimension vector per cue.
 *
 * A port rather than an in-process computation, and `domain/sound-pack/similarity.ts` states
 * why at length: the mel spectrogram and the DCT belong to the Python DSP layer (design
 * §5.5), `dsp/src/musicstudio_dsp/mfcc.py` is the one declaration of them, and a second
 * FFT in TypeScript would put pairs on either side of 0.95 depending on which side of the
 * process boundary the check ran.
 *
 * **The whole pack in one call, not one cue per call.** Requirement 24.9's subject is the
 * pack: the worker decodes each cue once, computes 78 vectors and compares 3003 pairs in one
 * matrix product (`cue_pack_similarity_task`). A per-cue port would recompute each vector 77
 * times if the caller compared pairwise, or would look identical while letting a partial
 * result pass for a complete one.
 *
 * **Integration point (task 3.1).** The production implementation enqueues
 * `musicstudio_dsp.cue_pack_similarity` and reads `mfcc_vectors` off the result.
 */
export interface CueMfccPort {
  /** Vectors in the order the cues were given, one per cue. */
  measureCueMfcc(cues: readonly PackCueAudio[]): Promise<readonly CueMfccVector[]>;
}

/** What an export was asked to produce. */
export interface PackExportRequest {
  readonly cues: readonly PackCueAudio[];
  /**
   * The manifest, already printed.
   *
   * Text rather than a structure, deliberately. Requirement 24.15's idempotence is a claim
   * about the *document*, and `Manifest_Printer` is the only thing entitled to produce it —
   * so the document crosses the boundary verbatim and the exporter stores it unchanged. An
   * exporter that re-serialised a structure would be a second printer, and the two would
   * differ in key order the first time either changed.
   */
  readonly manifestDocument: string;
}

/**
 * Requirements 24.10, 24.11: the archive, and the facts needed to judge it.
 *
 * The port reports `elapsedMs` and does **not** judge it. Whether an elapsed time meets the
 * 60-second budget is a Quality_Threshold_Set decision (`sound_pack_export_budget_ms`) and
 * belongs to the product layer — which is also what makes the clause testable without
 * waiting, since the predicate is then pure. See `domain/sound-pack/export.ts`.
 *
 * **Integration point (task 3.1).** The production implementation enqueues
 * `musicstudio_dsp.export_sound_pack`, which encodes mp3 and ogg through the bundled
 * `libsndfile` — there is no `ffmpeg` in this environment and none is required.
 */
export interface PackExportPort {
  export(request: PackExportRequest): Promise<PackExportResult>;
}

export interface PackExportResult {
  readonly report: PackExportReport;
  /** The archive bytes. Held by the caller only long enough to hand to storage. */
  readonly archive: Uint8Array;
}

/**
 * Requirement 24.18: each cue's audio is stored as an `sfx` Audio_Asset carrying the cue
 * name, the category name and the pack identifier.
 *
 * A port because the asset row belongs to the library service (task 5.1) and this task does
 * not own `audio_asset`. What it does own is the *association* — migration
 * `0014_sound_pack.sql`'s `sound_pack_cue` — and the three facts 24.18 names travel here so
 * the association can be written by whoever owns the row.
 *
 * `SfxService` has already created the asset for each cue; this records what it *is*.
 */
export interface CueAssetRecord {
  readonly packId: string;
  readonly cueName: string;
  readonly categoryName: string;
  readonly assetId: string;
}

export interface CueAssetPort {
  /** Requirement 24.18. Idempotent in `(packId, cueName)`, so a 24.17 regeneration replaces. */
  recordCueAsset(record: CueAssetRecord): Promise<void>;
}

/**
 * The samples of a cue this pack already holds.
 *
 * `SfxService` has generated and stored each cue, but the pack-level clauses need the *audio*
 * again: Requirement 24.7's loudness and Requirement 24.9's MFCC are measured over the pack,
 * and Requirement 24.10's export encodes it. A port rather than a field on the SFX result,
 * because in production the audio is in object storage by then and the export reads it from
 * there — threading buffers for 78 cues through the result type would hold a pack's worth of
 * PCM in memory to avoid a read that has to happen anyway.
 *
 * It is *not* a second `SfxCandidatePort`. That port answers "what did the engine just
 * produce, before anything is published"; this one answers "what is stored under this asset".
 *
 * **Integration point (task 5.1).** The production implementation reads the Audio_Asset's
 * object and decodes it; in this task's tests it reads the same deterministic buffer the
 * simulated engine produced.
 */
export interface PackCueAudioQuery {
  readonly assetId: string;
  readonly jobId: string;
  readonly cueName: string;
}

export interface PackCueAudioPort {
  loadCueAudio(query: PackCueAudioQuery): Promise<PcmAudio>;
}

/**
 * Where a finished manifest is kept, for the pack detail view.
 *
 * Optional on the service: a pack that has never been exported has no manifest, and
 * Requirement 24.11 only requires one *when* the pack is exported. Kept as its own port so
 * the export path does not have to know whether anything persists.
 */
export interface PackManifestStore {
  save(packId: string, manifest: CuePackManifest): Promise<void>;
  find(packId: string): Promise<CuePackManifest | undefined>;
}
