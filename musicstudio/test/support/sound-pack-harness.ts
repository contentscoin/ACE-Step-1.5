/**
 * Test rig for the Sound_Pack_Service (Requirement 24).
 *
 * Built on `createSfxHarness()`, which is built on the **real** job lifecycle, the real
 * `ProviderRegistry`, the real Woosh adapter over a deterministic transport, and the real
 * `CreditRefundPort`. So a pack generated here exercises 78 genuine Generation_Jobs: the
 * Requirement 5 lifecycle, the Requirement 6.2 backoff, the Requirement 33.2 non-commercial
 * ruling on Woosh's weights, and — the point of driving `SfxService` rather than an engine
 * directly — the Requirement 22.14/22.15 quality gates that Requirements 24.6 and 24.8 are.
 *
 * Nothing here sleeps. The clock moves only when a test moves it.
 *
 * ### How cue audio is chosen: by **seed**, not by call order
 *
 * `SfxCandidatePort`'s FIFO `script(...)` is the wrong shape for a pack, because the pack
 * submits 78 generations with 8 in flight and the order in which `awaitCandidate` is reached is
 * a scheduling detail. Every seed the service can ask for is computable in advance, though —
 * `variantSeed` is a pure function of the base seed and an index — so this harness builds a
 * *seed plan* mapping each of those seeds back to the cue it belongs to, and synthesises that
 * cue's audio on demand. Stable under any interleaving, and it lets a test say "this cue's
 * second attempt succeeds" without knowing when it happens.
 *
 * The plan covers, for each of the 78 cues:
 *
 * - the initial pass (`variantSeed(base, i)`) and its two Requirement 24.21 retries;
 * - Requirement 24.22's three regeneration rounds;
 * - Requirement 24.17's manual regeneration round.
 *
 * ### What is faked, and what is not
 *
 * Faked: the DSP worker, at the two ports design §5.5 puts it behind — the MFCC
 * (`createDescriptorMfccPort`, whose header is emphatic about not being Requirement 24.9's
 * measurement) and the export (`createSimulatedPackExport`, which does no encoding because
 * `libsndfile` lives in the Python process). Everything else is the product code.
 *
 * Not faked: the audio. `cue-synthesis.ts` produces cues that genuinely satisfy Requirement
 * 24.4/24.5's lengths, 24.6's two seam criteria, 24.7's loudness band and 24.8's tail rule, each
 * for a stated reason, and that are genuinely pairwise dissimilar under 24.9.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import { durationMs, frameCount } from '../../domain/audio/pcm';
import type { QualityThresholdSource } from '../../domain/quality/threshold-source';
import { fixedSeedSource, type SeedSource } from '../../domain/sfx/seed';
import {
  CUE_SIMILARITY_REGENERATIONS_MAX,
  PACK_EXPORT_FORMATS,
  PACK_EXPORT_SAMPLE_RATE,
  type PackExportFormat,
} from '../../domain/sound-pack/bounds';
import { SEMANTIC_CUES, isLoopCue } from '../../domain/sound-pack/taxonomy';
import type { ExportedCueFile } from '../../domain/sound-pack/export';
import {
  MANUAL_REGENERATION_SEED_ROUND,
  SoundPackService,
  cueSeed,
} from '../../services/sound/sound-pack-service';
import type {
  CueAssetPort,
  CueAssetRecord,
  PackCueAudio,
  PackCueAudioPort,
  PackExportPort,
  PackExportRequest,
  PackExportResult,
} from '../../services/sound/sound-pack-ports';

import { createDescriptorMfccPort } from './cue-mfcc-descriptor';
import { distinctCueFor } from './cue-synthesis';
import { createSfxHarness, type SfxHarness } from './sfx-harness';

/** The pack's base seed. Fixed so the whole seed plan is known before anything runs. */
export const TEST_PACK_BASE_SEED = 24_000;

/**
 * Distance between the synthesis seeds of two rounds.
 *
 * A prime, and far from the 78 cue indices, so a cue regenerated in round `r` cannot land on the
 * synthesis seed of a *different* cue in round 0.
 *
 * The value was chosen by measurement rather than taste, and what it was measured against is
 * worth recording because it is a fact about Requirement 24 rather than about this fixture. With
 * a stride of 1 000, replacing `loading` with its round-4 audio put two loop pairs above 0.95;
 * with 7 919, replacing any single cue with its round-4 audio leaves all 3003 pairs below the
 * ceiling. **Rounds 1–3 are not collision-free** — one loop pair exceeds for three of the six
 * loops — and that is not papered over: six loop cues have far less spectrum to be distinct in
 * than 72 one-shots do, because Requirement 24.6's sample-step rule forces a loop to be
 * low-frequency dominant. See `cue-synthesis.ts` and this task's report.
 */
const ROUND_SEED_STRIDE = 7_919;

/** A minimal valid request (Requirement 24.1). */
export function soundPackRequest(overrides: Partial<SoundPackRequestShape> = {}) {
  return {
    name: 'Soft Product',
    description: 'warm, muted, close-mic plastic and felt; nothing metallic',
    ...overrides,
  };
}

interface SoundPackRequestShape {
  readonly name: string;
  readonly description: string;
}

/** Where one seed came from, so a test can say what a given attempt should produce. */
export interface PlannedSeed {
  readonly cueName: string;
  readonly cueIndex: number;
  /** 0 for the initial pass, `r` for Requirement 24.22's round `r`, 4 for a manual redo. */
  readonly round: number;
  /** 0, 1 or 2 — Requirement 24.21's attempt within a round. */
  readonly attempt: number;
}

/**
 * Every seed the service can ask for, mapped to its origin.
 *
 * Computed from `variantSeed` rather than observed, which is what makes it a *prediction*: if the
 * service ever derived a seed some other way, the plan would miss it and the fallback audio
 * would be the transport's tone rather than a synthesised cue — which the similarity assertions
 * would notice immediately.
 */
export function buildSeedPlan(baseSeed: number = TEST_PACK_BASE_SEED): ReadonlyMap<number, PlannedSeed> {
  const plan = new Map<number, PlannedSeed>();

  for (let round = 0; round <= MANUAL_REGENERATION_SEED_ROUND; round += 1) {
    for (const [cueIndex, cue] of SEMANTIC_CUES.entries()) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const seed = cueSeed(baseSeed, cueIndex, round, attempt);
        // A collision would mean two `(round, attempt, cue)` triples share a seed, which is the
        // defect `cueSeed` exists to prevent — so it is asserted here rather than absorbed.
        if (plan.has(seed)) {
          throw new Error(`seed ${String(seed)} is claimed by two cue attempts`);
        }
        plan.set(seed, { cueName: cue.name, cueIndex, round, attempt });
      }
    }
  }

  return plan;
}

/** What the harness should do for one planned seed. */
export type ScriptedCueAttempt =
  | { readonly kind: 'audio'; readonly audio: PcmAudio }
  /** Fall through to `SfxService`'s own paths — the engine produced nothing. */
  | { readonly kind: 'unproduced' };

export interface SoundPackHarness {
  readonly service: SoundPackService;
  readonly sfx: SfxHarness;
  /** Requirement 24.18's records, in the order they were written. */
  readonly assetRecords: readonly CueAssetRecord[];
  /** Every export the service asked for, in order. */
  readonly exports: readonly PackExportRequest[];
  readonly seedPlan: ReadonlyMap<number, PlannedSeed>;
  /** The audio the pack will produce for a cue's initial attempt. */
  audioFor(cueName: string): PcmAudio;
  /** Replace the audio for every attempt of one cue. */
  setCueAudio(cueName: string, audio: PcmAudio): void;
  /**
   * Replace the audio for one cue in one Requirement 24.22 round.
   *
   * Round 0 is the initial pass. Used to say "the reseeded regeneration fixes it" or "it does
   * not", which is the difference between a `complete` pack and a `review_required` one.
   */
  setRoundAudio(cueName: string, round: number, audio: PcmAudio): void;
  /** Make every attempt of one cue produce nothing (Requirement 24.21). */
  failCue(cueName: string, rounds?: readonly number[]): void;
  /** How long the simulated exporter reports each pass took. */
  setExportElapsedMs(elapsedMs: number): void;
  /** Drop `count` files from the export report, to exercise Requirement 24.10's negative case. */
  dropExportFiles(count: number): void;
  /**
   * Give every cue of a kind the *same* audio, in every round.
   *
   * Requirement 24.22's subject, stated as directly as it can be: identical audio has a cosine
   * similarity of exactly 1, so every same-kind pair exceeds the ceiling, the remedy runs its
   * three rounds, and — because the replacement audio is identical too — the pack ends
   * `review_required` with all 78 cues present. That is the state 24.22 describes, reached
   * deterministically rather than by hoping a fixture is too similar.
   */
  setUniformAudio(oneShot: PcmAudio, loop: PcmAudio): void;
}

export interface SoundPackHarnessOptions {
  readonly thresholds?: QualityThresholdSource;
  readonly seeds?: SeedSource;
  readonly concurrency?: number;
  /** Use the transport's own tones instead of synthesised cues. Requirement 24.22's subject. */
  readonly useEngineTones?: boolean;
}

export function createSoundPackHarness(
  options: SoundPackHarnessOptions = {},
): SoundPackHarness {
  const seedPlan = buildSeedPlan(TEST_PACK_BASE_SEED);
  const scripted = new Map<string, ScriptedCueAttempt>();
  const cache = new Map<string, PcmAudio>();

  const key = (cueName: string, round: number): string => `${cueName}#${String(round)}`;

  /**
   * The cue a seed belongs to, synthesised deterministically from the cue and the round.
   *
   * The round is part of the synthesis seed, so a Requirement 24.22 regeneration genuinely
   * produces *different* audio — which is the whole content of that clause. Retries within a
   * round produce the same audio, which is also right: Requirement 22.8 makes an identical
   * request produce identical audio, and the retries differ only in the engine seed the service
   * passes, which this harness deliberately does not model as a source of timbre.
   */
  const synthesise = (planned: PlannedSeed): PcmAudio => {
    const cacheKey = key(planned.cueName, planned.round);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const built = distinctCueFor(
      planned.cueName,
      TEST_PACK_BASE_SEED + planned.cueIndex + planned.round * ROUND_SEED_STRIDE,
      isLoopCue(planned.cueName),
    );
    cache.set(cacheKey, built);
    return built;
  };

  const audioBySeed = (seed: number): PcmAudio | undefined => {
    if (options.useEngineTones === true) return undefined;
    const planned = seedPlan.get(seed);
    if (planned === undefined) return undefined;

    const override = scripted.get(key(planned.cueName, planned.round));
    if (override?.kind === 'unproduced') {
      // `undefined` would fall through to the transport's tone, which is a *success*. Returning
      // an empty buffer is what makes `SfxService` reject the cue: an asset with no channels
      // fails Requirement 22.15's tail rule, which is the closest the candidate seam gets to
      // "the engine produced nothing" without a second port.
      return { sampleRate: PACK_EXPORT_SAMPLE_RATE, channels: [] };
    }
    if (override?.kind === 'audio') return override.audio;

    return synthesise(planned);
  };

  const sfx = createSfxHarness({
    audioBySeed,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });

  const audioByAsset = new Map<string, PcmAudio>();
  const assetRecords: CueAssetRecord[] = [];
  const exports: PackExportRequest[] = [];
  let exportElapsedMs = 500;
  let droppedFiles = 0;

  const cueAudio: PackCueAudioPort = {
    loadCueAudio: async (query) => {
      const stored = audioByAsset.get(query.assetId);
      if (stored !== undefined) return stored;
      throw new Error(`no stored audio for asset ${query.assetId} (cue ${query.cueName})`);
    },
  };

  const assets: CueAssetPort = {
    recordCueAsset: async (record) => {
      assetRecords.push(record);
    },
  };

  const exporter: PackExportPort = {
    export: async (request) => {
      exports.push(request);
      return simulateExport(request, exportElapsedMs, droppedFiles);
    },
  };

  const service = new SoundPackService({
    sfx: sfx.service,
    mfcc: createDescriptorMfccPort(),
    exporter,
    cueAudio,
    assets,
    seeds: options.seeds ?? fixedSeedSource(TEST_PACK_BASE_SEED),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });

  // The candidate port mints an asset id per candidate, and `PackCueAudioPort` has to answer for
  // it later. Rather than reach inside `SfxService`, the harness records the pairing as the
  // candidate port hands it out — which is exactly what task 5.1's storage will do.
  wireAssetAudio(sfx, audioByAsset);

  return {
    service,
    sfx,
    assetRecords,
    exports,
    seedPlan,
    audioFor: (cueName) =>
      synthesise({
        cueName,
        cueIndex: SEMANTIC_CUES.findIndex((cue) => cue.name === cueName),
        round: 0,
        attempt: 0,
      }),
    setCueAudio: (cueName, audio) => {
      for (let round = 0; round <= MANUAL_REGENERATION_SEED_ROUND; round += 1) {
        scripted.set(key(cueName, round), { kind: 'audio', audio });
      }
    },
    setRoundAudio: (cueName, round, audio) => {
      scripted.set(key(cueName, round), { kind: 'audio', audio });
    },
    failCue: (cueName, rounds) => {
      const targets =
        rounds ??
        Array.from({ length: MANUAL_REGENERATION_SEED_ROUND + 1 }, (_unused, index) => index);
      for (const round of targets) scripted.set(key(cueName, round), { kind: 'unproduced' });
    },
    setExportElapsedMs: (elapsedMs) => {
      exportElapsedMs = elapsedMs;
    },
    dropExportFiles: (count) => {
      droppedFiles = count;
    },
    setUniformAudio: (oneShot, loop) => {
      for (const cue of SEMANTIC_CUES) {
        const audio = isLoopCue(cue.name) ? loop : oneShot;
        for (let round = 0; round <= MANUAL_REGENERATION_SEED_ROUND; round += 1) {
          scripted.set(key(cue.name, round), { kind: 'audio', audio });
        }
      }
    },
  };
}

/**
 * Records every candidate's `(assetId, audio)` pairing, by wrapping the harness's port.
 *
 * A wrapper rather than a change to `sfx-harness.ts`: the pairing is a *pack* concern — the
 * pack has to reload a cue's samples after the SFX request that produced them has returned —
 * and nothing in Requirement 22 needs it.
 */
function wireAssetAudio(sfx: SfxHarness, audioByAsset: Map<string, PcmAudio>): void {
  const port = sfx.candidates;
  const original = port.awaitCandidate.bind(port);
  (port as { awaitCandidate: typeof port.awaitCandidate }).awaitCandidate = async (query) => {
    const outcome = await original(query);
    if (outcome.kind === 'produced') {
      audioByAsset.set(outcome.candidate.assetId, outcome.candidate.audio);
    }
    return outcome;
  };
}

/**
 * The DSP worker's export, simulated (Requirements 24.10, 24.11).
 *
 * No encoding happens: `libsndfile` is in the Python process, and `dsp/test/test_sound_pack.py`
 * is where a real 78-cue archive is built and its 156 entries and elapsed time are asserted.
 * What this has to be faithful about is the *report*, because that is what
 * `evaluatePackExport` judges — so it produces one entry per cue per format, at the rate
 * Requirement 24.10 fixes, with a byte size that is a function of the audio.
 */
function simulateExport(
  request: PackExportRequest,
  elapsedMs: number,
  droppedFiles: number,
): PackExportResult {
  const files: ExportedCueFile[] = [];

  for (const cue of request.cues) {
    for (const format of PACK_EXPORT_FORMATS) {
      files.push(simulatedFile(cue, format));
    }
  }

  const kept = droppedFiles > 0 ? files.slice(0, Math.max(0, files.length - droppedFiles)) : files;
  const archiveByteSize =
    kept.reduce((total, file) => total + file.byteSize, 0) + request.manifestDocument.length;

  return {
    report: {
      files: kept,
      elapsedMs,
      manifestEntry: 'manifest.json',
      archiveByteSize,
    },
    // The archive's bytes are never inspected by the product layer — it hands them to storage —
    // so a marker is honest here where fabricated zip bytes would only look convincing.
    archive: new TextEncoder().encode(`simulated-archive:${String(kept.length)}`),
  };
}

/** A plausible compressed size: bytes per frame per format, at the export rate. */
const BYTES_PER_FRAME: Readonly<Record<PackExportFormat, number>> = { mp3: 0.5, ogg: 0.4 };

function simulatedFile(cue: PackCueAudio, format: PackExportFormat): ExportedCueFile {
  const frames = frameCount(cue.audio);
  return {
    cueName: cue.cueName,
    format,
    path: `sounds/${cue.cueName}.${format}`,
    // At least one byte: a zero-byte entry would be indistinguishable from a missing file, and
    // `evaluatePackExport` has a separate fault for an empty archive.
    byteSize: Math.max(1, Math.round(frames * BYTES_PER_FRAME[format])),
    durationMs: durationMs(cue.audio),
    channels: cue.audio.channels.length,
    sampleRate: PACK_EXPORT_SAMPLE_RATE,
  };
}

/** Requirement 24.22's round count, re-exported so a test need not import two modules. */
export const PACK_REGENERATION_ROUNDS = CUE_SIMILARITY_REGENERATIONS_MAX;
