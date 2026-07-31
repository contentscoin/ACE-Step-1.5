/**
 * Sound_Pack_Service (Requirement 24; design §7.1, §8.3).
 *
 * ### The one decision everything else follows from
 *
 * **A sound pack is 78 sound-effect generations, so this service drives `SfxService` and
 * writes no generator of its own.** Every clause of Requirement 24 that has a counterpart in
 * Requirement 22 is therefore already implemented and already tested:
 *
 * | Requirement 24 | is Requirement 22's | via |
 * |---|---|---|
 * | 24.6 loop seam, 10 ms windows | 22.14, same windows | `evaluateSfxLoopSeam` |
 * | 24.8 one-shot tail, 50 ms window, 5 % | 22.15, same window and ratio | `evaluateTailDecay` |
 * | 24.21 per-cue retry and failure accounting | 22.19's per-variant job | one job per cue |
 * | 24.18 store as an `sfx` Audio_Asset | 22.1's asset | `SfxService`'s candidate |
 *
 * That is not a shortcut, it is the reason the numbers agree: 24.6's seam rule and 22.14's are
 * the *same rule with the same window*, and a second implementation of it would be free to
 * disagree with the first. `domain/sound-pack/bounds.ts` restates the windows under
 * Requirement 24's names so a reader checking a clause finds its numbers, and the judgements
 * are made once, in `domain/sfx/`.
 *
 * What is genuinely new is what is *pack*-level, and it is exactly the four things Requirement
 * 24 adds: the 78-name completeness invariant (24.2), the loudness band (24.7), the pairwise
 * similarity ceiling (24.9) with its reseeded remedy (24.22), and the export (24.10, 24.11).
 *
 * ### Credits: one refund path, and no new arithmetic
 *
 * A pack is a large charge — 78 cue jobs — and Requirement 24 legislates the partial-failure
 * case (24.21) without ever mentioning a refund. That is consistent, not an omission, because
 * driving `SfxService` per cue means the refunds have already happened in the one place the
 * system does refunds:
 *
 * - a cue whose engine produced nothing has already been refunded by Requirements 6.1–6.3;
 * - a cue whose audio missed 24.6 or 24.8 has been failed and refunded by `SfxService` through
 *   `createJobQualityRejection`, the same `CreditRefundPort` Requirements 5.7, 5.8, 6.3, 20.15,
 *   21.18 and 22.19 use.
 *
 * So a partially failed pack has refunded exactly the cues that failed, proportionally, with no
 * second ledger path and no new entry type. This service *sums* what came back and reports it;
 * it never issues a refund itself. That is the whole of its credit involvement, and it is why
 * `sound-pack-ports.ts` has no credit port to be tempted by.
 *
 * ### Interpretation: 24.1 says "a Generation_Job", singular
 *
 * It does, and a pack produces 78. The singular reading cannot be implemented as written
 * alongside 24.21, which requires each cue to be retried up to twice *individually* and the
 * successful cues kept when others fail — a single job has one state and one charge, so it
 * cannot be two-thirds succeeded. Per-cue jobs are the reading that satisfies 24.21 and 24.17
 * (regenerate one cue, leave 77 untouched), and they make 24.21's implicit accounting fall out
 * of the existing path as described above. Recorded as an interpretation in this task's report.
 *
 * ### Concurrency
 *
 * Task 3.4's brief caps generation at 8 concurrent; Requirement 24 states none. 8 is also
 * Requirement 22.16's ceiling on sibling variants, so a pack asks the engine no more at once
 * than a single sound-effect request may. `mapWithConcurrency` provides it — see
 * `services/generation/concurrency.ts` on why not `Promise.all` in slices, and on why results
 * come back in taxonomy order rather than completion order.
 */

import { fixedThresholdSource, type QualityThresholdSource } from '../../domain/quality/threshold-source';
import {
  packExportThresholds,
  packLoudnessThresholds,
  soundPackThresholds,
} from '../../domain/quality/sound-pack-thresholds';
import { variantSeed, type SeedSource } from '../../domain/sfx/seed';
import type { PcmAudio } from '../../domain/audio/pcm';
import {
  CUE_SIMILARITY_REGENERATIONS_MAX,
  ONE_SHOT_LENGTH_SECONDS_MAX,
  PACK_CUE_COUNT,
  PACK_GENERATION_CONCURRENCY,
  PACK_EXPORT_SAMPLE_RATE,
} from '../../domain/sound-pack/bounds';
import { evaluatePackExport, type PackExportReport } from '../../domain/sound-pack/export';
import {
  evaluateCueLoopSeam,
  seamOffenders,
  type CueLoopSeamVerdict,
} from '../../domain/sound-pack/loop-seam';
import { printManifestPretty } from '../../domain/sound-pack/manifest-printer';
import type { CueManifestEntry, CuePackManifest } from '../../domain/sound-pack/manifest';
import { judgeCueLoudness, evaluatePackLoudness } from '../../domain/sound-pack/pack-loudness';
import {
  evaluateCueSimilarity,
  type CueMfccVector,
  type CueSimilarityVerdict,
} from '../../domain/sound-pack/similarity';
import { packStatus } from '../../domain/sound-pack/status';
import {
  SEMANTIC_CUES,
  cueByName,
  isCueName,
  missingCueNames,
  type SemanticCue,
} from '../../domain/sound-pack/taxonomy';
import {
  judgeCueLength,
  lengthOffenders,
  validateSoundPackRequest,
  type CueLengthVerdict,
  type SoundPackParameters,
  type SoundPackRequest,
} from '../../domain/sound-pack/validation';
import { isGenerationError } from '../generation/errors';
import { mapWithConcurrency } from '../generation/concurrency';
import type { ModerationDecision } from '../moderation/decision';

import { maxShortTermLoudnessLufs } from '../../domain/audio/loudness';
import { loopSeamThresholds } from '../../domain/quality/loop-seam-thresholds';
import { SFX_NO_TEMPO } from '../../domain/sfx/loop-seam';
import {
  CUE_SEAM_WINDOW_MS,
  PACK_LOUDNESS_HOP_MS,
  PACK_LOUDNESS_WINDOW_MS,
} from '../../domain/sound-pack/bounds';
import { measureLoopSync } from './in-process-measurement';
import { soundPackCueUnknown, soundPackExportFailed, soundPackRequestInvalid } from './sound-pack-errors';
import type {
  CueAssetPort,
  CueMfccPort,
  PackCueAudio,
  PackCueAudioPort,
  PackExportPort,
  PackManifestStore,
} from './sound-pack-ports';
import type {
  CueRegenerationOutcome,
  FailedPackCue,
  PackCueFailureReason,
  PackExportOutcome,
  ProducedPackCue,
  SoundPackOutcome,
  SoundPackReport,
  UnresolvedSimilarPair,
} from './sound-pack-result';
import type { SfxService } from './sfx-service';

/**
 * The target length asked of the engine, by cue kind, in seconds.
 *
 * Requirements 24.4 and 24.5 give *ranges*; the engine needs one number. These sit
 * comfortably inside their ranges rather than at an end, because an engine asked for exactly
 * 1.5 seconds and delivering 1.51 would violate 24.4 for a rounding error. They are in this
 * module rather than in `bounds.ts` because they are a request parameter — what the service
 * asks for — and not a constraint anything is judged against.
 *
 * The one-shot target is also chosen with Requirement 24.8's tail rule in mind: a UI click has
 * to be *quiet* by its last 50 ms, and 50 ms is a third of a 150 ms cue. See the note in
 * `test/support/pcm-synthesis.ts` on the same tension in Requirement 22.15.
 */
export const CUE_ONE_SHOT_TARGET_SECONDS = 0.4;
export const CUE_LOOP_TARGET_SECONDS = 2.0;

export interface SoundPackServiceOptions {
  /** The generator. A pack is 78 of its requests; see the header. */
  readonly sfx: SfxService;
  /** Requirement 24.9's measurement, in the Python DSP layer. */
  readonly mfcc: CueMfccPort;
  /** Requirements 24.10, 24.11. */
  readonly exporter: PackExportPort;
  /** The samples of a stored cue, for the pack-level measurements and the export. */
  readonly cueAudio: PackCueAudioPort;
  /** Requirement 24.18. */
  readonly assets: CueAssetPort;
  /** Requirement 24.11's manifest, kept for the detail view. Optional. */
  readonly manifests?: PackManifestStore;
  /** Requirement 34: the set in force. Defaults to the initial values (34.3). */
  readonly thresholds?: QualityThresholdSource;
  /** The base seed for the pack's cue seeds. Drawn once per pack. */
  readonly seeds: SeedSource;
  /** Task 3.4's 8. Overridable so a test can prove the limit is respected at 1 and at 8. */
  readonly concurrency?: number;
}

export interface SoundPackSubmissionInput {
  readonly accountId: string;
  readonly packId: string;
  readonly request: SoundPackRequest;
  /** Content policy verdict, evaluated lazily by the orchestrator (design §9.1). */
  readonly moderate?: () => ModerationDecision;
}

export interface CueRegenerationInput {
  readonly accountId: string;
  readonly packId: string;
  readonly request: SoundPackRequest;
  readonly cueName: string;
  /**
   * The pack as it stands. Requirement 24.17's "나머지 77개 큐" — supplied rather than loaded,
   * so this service holds no pack state and the caller cannot be surprised by a pack that
   * changed between two calls it thought were about the same thing.
   */
  readonly cues: readonly ProducedPackCue[];
}

export interface PackExportInput {
  readonly packId: string;
  readonly packName: string;
  readonly cues: readonly ProducedPackCue[];
}

export class SoundPackService {
  private readonly sfx: SfxService;
  private readonly mfcc: CueMfccPort;
  private readonly exporter: PackExportPort;
  private readonly cueAudio: PackCueAudioPort;
  private readonly assets: CueAssetPort;
  private readonly manifests: PackManifestStore | undefined;
  private readonly thresholds: QualityThresholdSource;
  private readonly seeds: SeedSource;
  private readonly concurrency: number;

  constructor(options: SoundPackServiceOptions) {
    this.sfx = options.sfx;
    this.mfcc = options.mfcc;
    this.exporter = options.exporter;
    this.cueAudio = options.cueAudio;
    this.assets = options.assets;
    this.manifests = options.manifests;
    this.thresholds = options.thresholds ?? fixedThresholdSource();
    this.seeds = options.seeds;
    this.concurrency = options.concurrency ?? PACK_GENERATION_CONCURRENCY;
  }

  /**
   * Requirements 24.1–24.9, 24.18, 24.21, 24.22.
   *
   * Throws `sound_pack_request_invalid` (24.20) before anything is submitted or charged.
   * Everything else — an incomplete pack (24.3, 24.21), a pack needing review (24.22) — comes
   * back as a `SoundPackReport` carrying its status and the cues that did succeed, because all
   * three clauses require those cues be kept.
   */
  async generate(input: SoundPackSubmissionInput): Promise<SoundPackOutcome> {
    const validation = validateSoundPackRequest(input.request);
    if (validation.kind === 'invalid') {
      // Requirement 24.20's second half — "기존 Sound_Pack 자산을 변경 없이 유지" — is kept
      // structurally: nothing has been submitted yet, so there is nothing to leave unchanged.
      throw soundPackRequestInvalid({
        violations: validation.violations,
        lengths: validation.lengths,
      });
    }

    // Read once per pack, not once per cue. An operator change landing mid-pack would
    // otherwise judge cue 40 against a different band from cue 39, and Requirement 34.6
    // records one version per asset.
    const set = this.thresholds.current();
    const baseSeed = this.seeds.draw();

    const attempts = await mapWithConcurrency(
      [...SEMANTIC_CUES],
      this.concurrency,
      async (cue, index) =>
        this.generateCue({
          accountId: input.accountId,
          parameters: validation.parameters,
          cue,
          seedForAttempt: (attempt) => cueSeed(baseSeed, index, 0, attempt),
          ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
        }),
    );

    // A block applies to the pack's shared description, so one verdict settles all 78.
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled' && attempt.value.kind === 'blocked') {
        return { kind: 'blocked', decision: attempt.value.decision };
      }
    }

    const cues: ProducedPackCue[] = [];
    const failures: FailedPackCue[] = [];
    let refundedAmount = 0;

    for (const attempt of attempts) {
      if (attempt.status === 'rejected') throw attempt.reason;
      const outcome = attempt.value;
      if (outcome.kind === 'blocked') continue;
      refundedAmount += outcome.refundedAmount;
      if (outcome.kind === 'produced') cues.push(outcome.cue);
      else failures.push(outcome.failure);
    }

    // Requirement 24.22's remedy runs before the report is assembled, so what is reported is
    // the pack *after* the reseeded regenerations rather than before them.
    const resolved = await this.resolveSimilarity({
      accountId: input.accountId,
      parameters: validation.parameters,
      cues,
      baseSeed,
      ceiling: soundPackThresholds(set).cuePairSimilarityMax,
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    });
    refundedAmount += resolved.refundedAmount;

    // Requirement 24.18, after the audio is settled: recording an asset that is about to be
    // replaced by a 24.22 regeneration would leave the association pointing at discarded audio.
    for (const cue of resolved.cues) {
      await this.assets.recordCueAsset({
        packId: input.packId,
        cueName: cue.cueName,
        categoryName: cue.categoryName,
        assetId: cue.assetId,
      });
    }

    return this.report({
      packId: input.packId,
      packName: validation.parameters.name,
      cues: resolved.cues,
      failures,
      refundedAmount,
      similarity: resolved.similarity,
      unresolvedSimilarPairs: resolved.unresolved,
      loudness: resolved.loudness,
      loopSeams: resolved.loopSeams,
      qualityThresholdSetVersion: set.version,
    });
  }

  /**
   * Requirement 24.17: regenerate one cue and leave the other 77 untouched.
   *
   * "나머지 77개 큐의 오디오를 변경 없이 유지" is kept by construction rather than by care —
   * the other cues' `ProducedPackCue` records are copied through unmodified and their audio is
   * never even loaded except to re-run 24.9's pairwise comparison, which reads and does not
   * write. `unchangedCueCount` reports how many were carried through so a caller can assert it.
   *
   * The four re-validations 24.17 names are all re-run: 24.4/24.5's length, 24.6's seam (as
   * 22.14, inside `SfxService`), 24.7's loudness, and 24.9's similarity against the whole pack.
   */
  async regenerateCue(input: CueRegenerationInput): Promise<CueRegenerationOutcome> {
    if (!isCueName(input.cueName)) throw soundPackCueUnknown(input.cueName);

    const validation = validateSoundPackRequest(input.request);
    if (validation.kind === 'invalid') {
      throw soundPackRequestInvalid({
        violations: validation.violations,
        lengths: validation.lengths,
      });
    }

    const set = this.thresholds.current();
    const cue = cueByName(input.cueName) as SemanticCue;
    const others = input.cues.filter((entry) => entry.cueName !== input.cueName);

    const outcome = await this.generateCue({
      accountId: input.accountId,
      parameters: validation.parameters,
      cue,
      // A different seed from the original, so a regeneration is not the same request again.
      // Requirement 24.17 does not say so; Requirement 22.8 makes it necessary, since an
      // identical request is required to produce identical audio.
      //
      // Drawn from a *reserved round* of the index space rather than raw from the source, so a
      // manual regeneration cannot collide with a seed the initial pass or Requirement 24.22's
      // three rounds already asked the engine for. See `cueSeed`.
      seedForAttempt: (attempt) =>
        cueSeed(
          this.seeds.draw(),
          taxonomyIndex(input.cueName),
          MANUAL_REGENERATION_SEED_ROUND,
          attempt,
        ),
    });

    // The description was refused, so nothing was generated and the pack is exactly as it was.
    if (outcome.kind === 'blocked') return { kind: 'blocked', decision: outcome.decision };

    const kept: readonly ProducedPackCue[] =
      outcome.kind === 'produced' ? [...others, outcome.cue] : input.cues;
    const inTaxonomyOrder = orderByTaxonomy(kept);
    const audio = await this.loadAudio(inTaxonomyOrder);
    const loudnessThresholds = packLoudnessThresholds(set);

    const similarity = await this.measureSimilarity(
      audio,
      soundPackThresholds(set).cuePairSimilarityMax,
    );

    const regenerated = outcome.kind === 'produced' ? outcome.cue : null;
    const length =
      regenerated === null ? null : judgeCueLength(regenerated.cueName, regenerated.durationMs);
    const loudness =
      regenerated === null
        ? null
        : judgeCueLoudness(
            regenerated.cueName,
            packLoudnessOf(audioFor(audio, regenerated.cueName)),
            loudnessThresholds,
          );

    if (regenerated !== null) {
      await this.assets.recordCueAsset({
        packId: input.packId,
        cueName: regenerated.cueName,
        categoryName: regenerated.categoryName,
        assetId: regenerated.assetId,
      });
    }

    const lengths = inTaxonomyOrder.map((entry) => judgeCueLength(entry.cueName, entry.durationMs));
    const loopSeam =
      regenerated === null || !regenerated.loop
        ? null
        : judgeCueSeam(regenerated.cueName, audioFor(audio, regenerated.cueName), set);

    return {
      kind: 'regenerated',
      packId: input.packId,
      cueName: input.cueName,
      cue: regenerated,
      failure: outcome.kind === 'failed' ? outcome.failure : null,
      length,
      loudness,
      loopSeam,
      similarity,
      status: packStatus({
        missingCueNames: [...missingCueNames(inTaxonomyOrder.map((entry) => entry.cueName))],
        unresolvedSimilarPairs: similarity.satisfied ? 0 : similarity.exceeding.length,
        loudnessOffenders: loudness !== null && !loudness.satisfied ? 1 : 0,
        lengthOffenders: lengthOffenders(lengths).length,
        seamOffenders: loopSeam !== null && !loopSeam.verdict.satisfied ? 1 : 0,
      }),
      // Requirement 24.17's invariant, as a number the caller can assert on. The regenerated
      // cue is excluded whether or not it succeeded: on success it was replaced, and on failure
      // it was kept but is not one of the *other* cues.
      unchangedCueCount: others.length,
      qualityThresholdSetVersion: set.version,
    };
  }

  /**
   * Requirements 24.10, 24.11: 156 files and a manifest, in one archive, inside the budget.
   *
   * Throws `sound_pack_export_failed` when the archive is not what 24.10 promised — including
   * when it took too long, which is judged against `sound_pack_export_budget_ms` rather than
   * against a literal 60 000. The archive is not returned on failure: an incomplete archive is
   * worse than none, because a consumer that unzipped it would find 77 sounds and no error.
   */
  async exportPack(input: PackExportInput): Promise<PackExportOutcome> {
    const set = this.thresholds.current();
    const inTaxonomyOrder = orderByTaxonomy(input.cues);
    const audio = await this.loadAudio(inTaxonomyOrder);

    // Requirement 24.11 asks the manifest to carry each cue's **byte size**, and a byte size
    // exists only once the file has been encoded. So the export runs in two passes: the first
    // learns the sizes, the second writes the archive whose manifest states them.
    //
    // The alternative was to let the exporter fill the sizes in, and that is the thing not to
    // do: it would make the worker a second `Manifest_Printer`, and the two would differ in key
    // order the first time either changed — which is exactly what Requirement 24.15's
    // byte-identical reprint forbids. One printer, in the product layer, at the cost of encoding
    // the audio twice.
    //
    // The cost is real and is accounted for rather than hidden: **both** elapsed times are
    // summed and judged against Requirement 24.10's budget, because both are time the user
    // waits. A worker that cached its encodes between the two calls would halve it without
    // changing anything here.
    const sizing = await this.exporter.export({
      cues: audio,
      manifestDocument: printManifestPretty(buildManifest(input.packName, inTaxonomyOrder)),
    });

    const manifest = buildManifest(input.packName, inTaxonomyOrder, manifestFilesOf(sizing.report));
    const manifestDocument = printManifestPretty(manifest);
    const result = await this.exporter.export({ cues: audio, manifestDocument });

    const verdict = evaluatePackExport(
      {
        ...result.report,
        elapsedMs: sizing.report.elapsedMs + result.report.elapsedMs,
      },
      packExportThresholds(set),
    );
    if (!verdict.satisfied) throw soundPackExportFailed(verdict);

    if (this.manifests !== undefined) await this.manifests.save(input.packId, manifest);

    return {
      packId: input.packId,
      manifest,
      manifestDocument,
      verdict,
      archiveByteSize: result.report.archiveByteSize,
    };
  }

  /**
   * One cue, through `SfxService`, with Requirement 24.21's retries.
   *
   * `variantCount: 1`, which is what makes each cue its own Generation_Job and so makes
   * 24.21's per-cue accounting the whole-job refund path described in the header.
   *
   * Requirement 24.21's "최대 2회 재시도" is at most three attempts, each with a different
   * seed. A different seed rather than the same one because Requirement 22.8 makes an identical
   * request produce identical audio: retrying with the same seed would ask the engine the
   * question it has already answered, and a quality miss would recur by construction.
   */
  private async generateCue(input: {
    readonly accountId: string;
    readonly parameters: SoundPackParameters;
    readonly cue: SemanticCue;
    /** Requirement 24.21's seed for attempt `n`. See `cueSeed`. */
    readonly seedForAttempt: (attempt: number) => number;
    readonly moderate?: () => ModerationDecision;
  }): Promise<CueAttemptOutcome> {
    const loop = input.cue.category === 'loops';
    const seeds: number[] = [];
    let lastReason: PackCueFailureReason = 'engine_failure';
    let lastDetail: string | null = null;
    let refundedAmount = 0;

    for (let attempt = 0; attempt < CUE_ATTEMPTS; attempt += 1) {
      const seed = input.seedForAttempt(attempt);
      seeds.push(seed);

      try {
        const outcome = await this.sfx.generate({
          accountId: input.accountId,
          request: {
            prompt: cuePrompt(input.parameters, input.cue),
            targetLengthSeconds: loop ? CUE_LOOP_TARGET_SECONDS : CUE_ONE_SHOT_TARGET_SECONDS,
            variantCount: 1,
            loop,
            seed,
          },
          ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
        });

        if (outcome.kind === 'blocked') {
          return { kind: 'blocked', decision: outcome.decision, refundedAmount };
        }

        refundedAmount += outcome.refundedAmount;
        const variant = outcome.variants[0];
        if (variant === undefined) continue;

        return {
          kind: 'produced',
          refundedAmount,
          cue: {
            cueName: input.cue.name,
            categoryName: input.cue.category,
            assetId: variant.assetId,
            jobId: variant.jobId,
            defaultVolume: input.cue.defaultVolume,
            loop,
            durationMs: variant.metadata.durationMs,
            sampleRate: variant.metadata.sampleRate,
            channels: variant.metadata.channels,
            seed: variant.seed,
            attempts: attempt + 1,
          },
        };
      } catch (error) {
        if (!isGenerationError(error)) throw error;
        // `sfx_all_variants_failed` is the only failure a one-variant request can produce, and
        // its detail carries the reason and the amount already refunded by the one refund path.
        refundedAmount += numberDetail(error.details, 'refundedAmount');
        lastReason = failureReasonOf(error.details);
        lastDetail = error.message;
      }
    }

    return {
      kind: 'failed',
      refundedAmount,
      failure: {
        cueName: input.cue.name,
        categoryName: input.cue.category,
        reason: lastReason,
        attempts: seeds.length,
        seeds,
        detail: lastDetail,
      },
    };
  }

  /**
   * Requirements 24.9 and 24.22: measure every pair, then reseed the offenders.
   *
   * The remedy is stated exactly as 24.22 states it. For each pair above the ceiling, the
   * *later-generated* cue is regenerated with a different seed — later meaning later in
   * taxonomy order, which is the order the pack is generated in (see `SEMANTIC_CUES`) — up to
   * three times. A cue implicated in several pairs is regenerated once per round rather than
   * once per pair: one new audio settles every pair it is in, and regenerating per pair would
   * burn the budget on the same cue.
   *
   * After three rounds the surviving pairs are returned with their measured similarities, which
   * is what 24.22 requires, and the pack's status becomes `review_required`.
   */
  private async resolveSimilarity(input: {
    readonly accountId: string;
    readonly parameters: SoundPackParameters;
    readonly cues: readonly ProducedPackCue[];
    readonly baseSeed: number;
    readonly ceiling: number;
    readonly moderate?: () => ModerationDecision;
  }): Promise<{
    readonly cues: readonly ProducedPackCue[];
    readonly similarity: CueSimilarityVerdict;
    readonly unresolved: readonly UnresolvedSimilarPair[];
    readonly loudness: ReturnType<typeof evaluatePackLoudness>;
    readonly loopSeams: readonly CueLoopSeamVerdict[];
    readonly refundedAmount: number;
  }> {
    const set = this.thresholds.current();
    const loudnessThresholds = packLoudnessThresholds(set);
    let cues = orderByTaxonomy(input.cues);
    let audio = await this.loadAudio(cues);
    let similarity = await this.measureSimilarity(audio, input.ceiling);
    let refundedAmount = 0;
    let round = 0;

    while (!similarity.satisfied && round < CUE_SIMILARITY_REGENERATIONS_MAX) {
      round += 1;
      const targets = laterCuesOf(similarity, cues);
      if (targets.length === 0) break;

      const attempts = await mapWithConcurrency(targets, this.concurrency, async (cueName) => {
        const cue = cueByName(cueName) as SemanticCue;
        return this.generateCue({
          accountId: input.accountId,
          parameters: input.parameters,
          cue,
          // Seeds from this round's own region of the index space; see `cueSeed`.
          seedForAttempt: (attempt) =>
            cueSeed(input.baseSeed, taxonomyIndex(cueName), round, attempt),
          ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
        });
      });

      const replacements = new Map<string, ProducedPackCue>();
      for (const attempt of attempts) {
        if (attempt.status === 'rejected') throw attempt.reason;
        const outcome = attempt.value;
        refundedAmount += outcome.refundedAmount;
        if (outcome.kind === 'produced') replacements.set(outcome.cue.cueName, outcome.cue);
      }

      // A regeneration that failed leaves the previous audio in place: Requirement 24.22 asks
      // for a *different* cue, and no audio at all would turn a review-needed pack into an
      // incomplete one, which is a worse outcome than the similarity it was trying to fix.
      cues = cues.map((entry) => replacements.get(entry.cueName) ?? entry);
      audio = await this.loadAudio(cues);
      similarity = await this.measureSimilarity(audio, input.ceiling);
    }

    const loudness = evaluatePackLoudness(
      cues.map((entry) =>
        judgeCueLoudness(
          entry.cueName,
          packLoudnessOf(audioFor(audio, entry.cueName)),
          loudnessThresholds,
        ),
      ),
    );

    return {
      cues,
      loopSeams: cues
        .filter((entry) => entry.loop)
        .map((entry) => judgeCueSeam(entry.cueName, audioFor(audio, entry.cueName), set)),
      similarity,
      unresolved: similarity.satisfied
        ? []
        : similarity.exceeding.map((pair) => ({
            leftCueName: pair.leftCueName,
            rightCueName: pair.rightCueName,
            similarity: pair.similarity,
            regenerations: round,
          })),
      loudness,
      refundedAmount,
    };
  }

  /** Requirement 24.9, over every pair. The measurement is the DSP layer's. */
  private async measureSimilarity(
    audio: readonly PackCueAudio[],
    ceiling: number,
  ): Promise<CueSimilarityVerdict> {
    const vectors: readonly CueMfccVector[] = await this.mfcc.measureCueMfcc(audio);
    return evaluateCueSimilarity(vectors, ceiling);
  }

  private async loadAudio(cues: readonly ProducedPackCue[]): Promise<readonly PackCueAudio[]> {
    // Sequential rather than concurrent: this is a read of already-stored audio, so there is
    // no engine to keep busy, and 78 concurrent object reads would be a different pressure on
    // storage from the one task 3.4's limit is about.
    const loaded: PackCueAudio[] = [];
    for (const cue of cues) {
      loaded.push({
        cueName: cue.cueName,
        audio: await this.cueAudio.loadCueAudio({
          assetId: cue.assetId,
          jobId: cue.jobId,
          cueName: cue.cueName,
        }),
      });
    }
    return loaded;
  }

  /** Requirements 24.2, 24.3, 24.4, 24.5, 24.7, 24.9 assembled into one answer. */
  private report(input: {
    readonly packId: string;
    readonly packName: string;
    readonly cues: readonly ProducedPackCue[];
    readonly failures: readonly FailedPackCue[];
    readonly refundedAmount: number;
    readonly similarity: CueSimilarityVerdict;
    readonly unresolvedSimilarPairs: readonly UnresolvedSimilarPair[];
    readonly loudness: ReturnType<typeof evaluatePackLoudness>;
    readonly loopSeams: readonly CueLoopSeamVerdict[];
    readonly qualityThresholdSetVersion: number;
  }): SoundPackReport {
    const lengths: readonly CueLengthVerdict[] = input.cues.map((cue) =>
      judgeCueLength(cue.cueName, cue.durationMs),
    );
    const missing = missingCueNames(input.cues.map((cue) => cue.cueName));

    return {
      kind: 'produced',
      packId: input.packId,
      packName: input.packName,
      status: packStatus({
        missingCueNames: [...missing],
        unresolvedSimilarPairs: input.unresolvedSimilarPairs.length,
        loudnessOffenders: input.loudness.outside.length,
        lengthOffenders: lengthOffenders(lengths).length,
        seamOffenders: seamOffenders(input.loopSeams).length,
      }),
      cues: input.cues,
      missingCueNames: missing,
      failures: input.failures,
      loudness: input.loudness,
      lengths,
      loopSeams: input.loopSeams,
      similarity: input.similarity,
      unresolvedSimilarPairs: input.unresolvedSimilarPairs,
      refundedAmount: input.refundedAmount,
      qualityThresholdSetVersion: input.qualityThresholdSetVersion,
    };
  }
}

/** Requirement 24.21: three attempts, being one plus two retries. */
const CUE_ATTEMPTS = 3;

/**
 * Seed-space round reserved for Requirement 24.17's manual regeneration.
 *
 * One past Requirement 24.22's rounds, which occupy `1…CUE_SIMILARITY_REGENERATIONS_MAX`.
 */
export const MANUAL_REGENERATION_SEED_ROUND = CUE_SIMILARITY_REGENERATIONS_MAX + 1;

/**
 * The engine seed for one cue's one attempt: `(round, attempt, cueIndex)` → a seed.
 *
 * Every triple gets its **own index** into `variantSeed`'s space, and that flat indexing is the
 * point rather than a stylistic choice. The obvious construction — derive a cue seed from the
 * base and then derive an attempt seed from *that* — is broken, and a test found it: `variantSeed`
 * adds `index · STRIDE`, so nesting it twice gives `base + (i + a)·STRIDE`, which means cue 0's
 * second attempt asks the engine with **exactly** cue 1's first-attempt seed. Two different cues
 * asked with the same seed is a violation of nothing in Requirement 24 and of everything
 * Requirement 22.8 is for: the same seed and the same target length are most of what makes two
 * requests identical, so the retry of one cue could return audio indistinguishable from a
 * sibling's and then be measured against it under 24.9.
 *
 * With a flat index, distinct triples give distinct indices and therefore distinct seeds, because
 * the stride is odd and the modulus is a power of two — the argument `domain/sfx/seed.ts` makes.
 * The index space needed is `(rounds + 2) · attempts · 78 ≈ 1 400`, which is nothing against 2^31.
 */
export function cueSeed(
  baseSeed: number,
  cueIndex: number,
  round: number,
  attempt: number,
): number {
  return variantSeed(baseSeed, (round * CUE_ATTEMPTS + attempt) * PACK_CUE_COUNT + cueIndex);
}

/** What one cue's generation resolved to. */
type CueAttemptOutcome =
  | { readonly kind: 'produced'; readonly cue: ProducedPackCue; readonly refundedAmount: number }
  | { readonly kind: 'failed'; readonly failure: FailedPackCue; readonly refundedAmount: number }
  | {
      readonly kind: 'blocked';
      readonly decision: import('../moderation/decision').BlockedModeration;
      readonly refundedAmount: number;
    };

/**
 * The prompt one cue is generated from.
 *
 * The pack's sonic character (Requirement 24.1's 음향 성격 설명) plus the cue's own intent
 * sentence from the taxonomy. Both halves are load-bearing: the description is what makes 78
 * cues sound like one product, and the intent is what makes them sound like *different events*
 * — which is the same distinction Requirement 24.9's ceiling measures. Building the prompt from
 * the taxonomy's own intent rather than from the cue name means the engine is asked for the
 * thing the cue contract (24.19) promises, not for a word.
 */
export function cuePrompt(parameters: SoundPackParameters, cue: SemanticCue): string {
  return `UI sound cue "${cue.name}" (${cue.category}). ${cue.intent} Sonic character: ${parameters.description}`;
}

/** Requirement 24.7's quantity, from `domain/audio/loudness.ts`. */
function packLoudnessOf(audio: PcmAudio | undefined): number {
  if (audio === undefined) return Number.NEGATIVE_INFINITY;
  return maxShortTermLoudnessLufs(audio, PACK_LOUDNESS_WINDOW_MS, PACK_LOUDNESS_HOP_MS);
}

/**
 * Requirement 24.6 for one loop cue.
 *
 * The seam window is `CUE_SEAM_WINDOW_MS`, which is 24.6's own 10 ms, and the tempo is
 * `SFX_NO_TEMPO` because a UI cue has none — `bar_alignment` is not among the applied
 * criteria, so the value is measured and never judged. See `domain/sound-pack/loop-seam.ts`.
 *
 * A cue whose audio could not be loaded is judged over an empty measurement, which
 * `evaluateLoopSeam` reports as unsatisfied on every applied criterion — an absent buffer is
 * not evidence of a continuous seam. Built that way rather than as a hand-assembled verdict so
 * there is one place a verdict is constructed.
 */
function judgeCueSeam(
  cueName: string,
  audio: PcmAudio | undefined,
  set: Parameters<typeof loopSeamThresholds>[0],
): CueLoopSeamVerdict {
  const thresholds = loopSeamThresholds(set);
  const measurement =
    audio === undefined
      ? {
          sampleRate: 0,
          durationMs: 0,
          bpm: SFX_NO_TEMPO,
          timeSignature: SFX_NO_TEMPO,
          integratedLoudnessLufs: Number.NEGATIVE_INFINITY,
          channels: [],
        }
      : measureLoopSync({
          subject: { kind: 'pcm', audio },
          bpm: SFX_NO_TEMPO,
          timeSignature: SFX_NO_TEMPO,
          seamWindowMs: CUE_SEAM_WINDOW_MS,
        });

  return { cueName, verdict: evaluateCueLoopSeam(measurement, thresholds) };
}

function audioFor(audio: readonly PackCueAudio[], cueName: string): PcmAudio | undefined {
  return audio.find((entry) => entry.cueName === cueName)?.audio;
}

/** Index of a cue in the taxonomy, which is generation order. */
function taxonomyIndex(cueName: string): number {
  return SEMANTIC_CUES.findIndex((cue) => cue.name === cueName);
}

/**
 * Cues in taxonomy order.
 *
 * Called on every path that compares or prints, because Requirement 24.22's "나중에 생성된
 * 큐" and Requirement 24.15's byte-identical reprint both depend on one order, and a caller
 * handing back a reordered list would change both answers without changing any audio.
 */
function orderByTaxonomy(cues: readonly ProducedPackCue[]): readonly ProducedPackCue[] {
  const byName = new Map(cues.map((cue) => [cue.cueName, cue]));
  const ordered: ProducedPackCue[] = [];
  for (const cue of SEMANTIC_CUES) {
    const found = byName.get(cue.name);
    if (found !== undefined) ordered.push(found);
  }
  return ordered;
}

/**
 * Requirement 24.22's regeneration targets: the later cue of each exceeding pair.
 *
 * De-duplicated, and returned in taxonomy order so a round's work is deterministic.
 */
function laterCuesOf(
  similarity: CueSimilarityVerdict,
  cues: readonly ProducedPackCue[],
): readonly string[] {
  if (similarity.satisfied) return [];
  const present = new Set(cues.map((cue) => cue.cueName));
  const targets = new Set(
    similarity.exceeding
      .map((pair) => pair.rightCueName)
      .filter((cueName) => present.has(cueName)),
  );
  return SEMANTIC_CUES.map((cue) => cue.name).filter((name) => targets.has(name));
}

/**
 * The manifest's per-cue path and byte size, taken from an export report.
 *
 * The **mp3** entry, because Requirement 24.11 asks for one manifest entry per cue while 24.10
 * writes two files per cue, so one of the two formats has to be the one the entry describes.
 * mp3 is first in `PACK_EXPORT_FORMATS` and is the format a consumer plays by default; the ogg
 * file's path is derivable from it by extension. **Open question for the spec:** 24.11's entry
 * list names one path per cue and 24.10 produces two files per cue, and the clauses do not say
 * which. Recorded in this task's report.
 */
function manifestFilesOf(
  report: PackExportReport,
): ReadonlyMap<string, { readonly path: string; readonly byteSize: number }> {
  const files = new Map<string, { path: string; byteSize: number }>();
  for (const file of report.files) {
    if (file.format !== 'mp3') continue;
    files.set(file.cueName, { path: file.path, byteSize: file.byteSize });
  }
  return files;
}

/** Requirement 24.11's manifest, from the pack's cues. */
export function buildManifest(
  packName: string,
  cues: readonly ProducedPackCue[],
  files: ReadonlyMap<string, { readonly path: string; readonly byteSize: number }> = new Map(),
): CuePackManifest {
  const entries: CueManifestEntry[] = cues.map((cue) => {
    const file = files.get(cue.cueName);
    return {
      // Before an export has run there are no byte sizes; the archive's own paths are
      // predictable (`sounds/<cue>.<ext>`) and the manifest is rewritten with the real sizes
      // when the export reports them. A zero byte size before an export is honest — nothing
      // has been written — and `manifest.ts` permits it for exactly that reason.
      path: file?.path ?? `sounds/${cue.cueName}.mp3`,
      byteSize: file?.byteSize ?? 0,
      durationMs: cue.durationMs,
      channels: cue.channels,
      loop: cue.loop,
      defaultVolume: cue.defaultVolume,
      cueName: cue.cueName,
      categoryName: cue.categoryName,
    };
  });

  return { packName, entries };
}

/** Requirement 24.10's rate, restated where the export request is built. */
export const MANIFEST_EXPORT_SAMPLE_RATE = PACK_EXPORT_SAMPLE_RATE;

/** Requirement 24.4's ceiling, restated for the length note above. */
export const CUE_ONE_SHOT_MAX_SECONDS = ONE_SHOT_LENGTH_SECONDS_MAX;

function numberDetail(details: Readonly<Record<string, unknown>>, key: string): number {
  const value = details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Requirement 24.21's discriminator, read off `sfx_all_variants_failed`'s detail.
 *
 * Defaults to `engine_failure` when the detail is not the expected shape: an unclassifiable
 * failure is more like an engine failure than like a quality miss, and calling it a quality
 * miss would claim audio arrived and was judged when it may never have arrived at all.
 */
function failureReasonOf(details: Readonly<Record<string, unknown>>): PackCueFailureReason {
  const failures = details['failures'];
  if (!Array.isArray(failures)) return 'engine_failure';
  const first = failures[0] as { reason?: unknown } | undefined;
  return first?.reason === 'quality_unmet' ? 'quality_unmet' : 'engine_failure';
}
