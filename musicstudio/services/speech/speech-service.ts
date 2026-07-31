/**
 * Speech_Service (Requirement 25; Requirements 26.10, 26.11, 26.20, 26.22, 26.29; Requirement
 * 27.14; design §9.2).
 *
 * It owns six things and delegates everything else:
 *
 * 1. **Engine and language selection** (25.2, 25.3, 26.10, 26.11) — the capability catalogue
 *    decides which engine can speak the requested language, and a `preset` profile's binding
 *    overrides any engine the caller named.
 * 2. **Validation** (25.4–25.10, 25.14, 25.22) — through `domain/speech/validation.ts` and
 *    `domain/speech/lines.ts`, which also apply and record the defaults and resolve the tags of
 *    25.8/25.9.
 * 3. **Sequential synthesis and the join** (25.11) — one call per line, in order, joined with the
 *    50 ms cross-fade `domain/audio/crossfade.ts` implements.
 * 4. **The timings** (25.14, 25.17, 27.14) — derived from the layout by
 *    `domain/speech/line-timing.ts`, stored as the asset's only timing source.
 * 5. **Single-line re-synthesis** (25.15, 25.16, 25.20, 25.21) — replace one piece, re-join,
 *    re-derive.
 * 6. **The tail adjustment** (25.19) — measured and applied on the last line's piece, so the
 *    layout the timings come from already reflects it.
 *
 * ### The synthesis unit is a line, not a chunk
 *
 * This is the load-bearing interpretation of the whole task, so it is argued rather than asserted.
 *
 * 25.11 splits the *script* into chunks at 800 characters. 25.14 stores *lines*, split by newline.
 * 25.15 re-synthesises *one line* and requires every other line's samples to survive. Those three
 * cannot all hold if a chunk is the synthesis unit: a chunk generally holds several lines, so
 * re-synthesising one line would mean re-synthesising its whole chunk, and every other line in
 * that chunk would change — which 25.15 forbids in as many words.
 *
 * So the unit is the line, and 25.11's chunking is a **coarser description of the same cut set**.
 * That is sound rather than a dodge: every line boundary is one of the positions 25.11 permits a
 * cut at (it is a 행 경계), so refining a legal chunking at its internal line boundaries produces
 * another legal chunking. 25.12's order and 25.13's count survive the refinement too — the count
 * is bounded by the text-bearing units at the *finest* legal split, which is what
 * `splitScript`'s `sentenceCount` counts. The chunk list is still computed and reported, because
 * 25.11's chunk count is a fact about the request the caller asked about.
 *
 * A consequence worth stating: because seam positions are a function of the line structure rather
 * than of the threshold, two requests differing only in `splitThresholdChars` produce
 * sample-identical audio. That is what makes 25.18's reproducibility key — which omits the
 * threshold — true as written.
 *
 * ### One Generation_Job per asset
 *
 * The opposite of `sfx-service.ts` and for the opposite reason. Requirement 22.19 requires a
 * *partial* refund proportional to failed variants, which is why sound effects are one job per
 * variant. Requirement 25.1 asks for one Generation_Job producing one `dialogue` Audio_Asset, and
 * Requirement 25 grants no per-line refund — a line that cannot be synthesised means the asset
 * cannot be assembled, so the whole job fails and the whole charge is returned. A line has no
 * independent lifecycle, nothing to charge and nothing to refund, exactly as a V2A segment does
 * not.
 *
 * A re-synthesis under 25.15 *is* a new job, because it is new engine work. 25.21's refusal of an
 * invalid index explicitly leaves credits untouched, which only needs saying if a valid one costs
 * something.
 *
 * ### What is not built here
 *
 * No speech synthesis, no decoding and no network. Both live behind `SpeechSynthesisPort` and the
 * two `EngineAdapter` implementations in `adapters/tts/`. Impersonation blocking for a dialogue
 * script is **not** re-implemented: it is Requirement 16.11's, already in
 * `domain/moderation/impersonation.ts`, and it reaches this service through the orchestrator's
 * moderation gate exactly as it reaches every other generation path.
 */

import { crossfadeJoin } from '../../domain/audio/crossfade';
import { durationMs as audioDurationMs, channelCount, type PcmAudio } from '../../domain/audio/pcm';
import { dialogueTailSilenceThresholds } from '../../domain/quality/speech-thresholds';
import {
  fixedThresholdSource,
  type QualityThresholdSource,
} from '../../domain/quality/threshold-source';
import { variantSeed, type SeedSource } from '../../domain/sfx/seed';
import { DIALOGUE_CROSSFADE_MS } from '../../domain/speech/bounds';
import {
  enginesSupportingLanguage,
  languageCatalogue,
  languageSupportOf,
  type EngineLanguageSupport,
} from '../../domain/speech/language';
import {
  dialogueTimingOf,
  retimeAfterResynthesis,
  type DialogueLayout,
  type DialogueTiming,
} from '../../domain/speech/line-timing';
import { validateScriptLines, type ScriptLine } from '../../domain/speech/lines';
import { dialogueMetadata, type DialogueAssetMetadata } from '../../domain/speech/metadata';
import {
  estimatedDialogueDurationMs,
  type DialogueGenerationRequest,
  type SpeechParameters,
} from '../../domain/speech/request';
import {
  adjustTailSilence,
  evaluateTailSilence,
  measureTailSilence,
  type TailSilenceVerdict,
} from '../../domain/speech/tail-silence';
import { splitScript } from '../../domain/speech/script-split';
import { validateDialogueRequest } from '../../domain/speech/validation';
import { checkEngineBinding, submissionEngineIdOf } from '../../domain/voice/profile';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { JobOrchestrator } from '../generation/job-orchestrator';
import type { BlockedModeration, ModerationDecision } from '../moderation/decision';
import type { VoiceProfileRecordStorePort } from '../voice/profile-ports';
import type { ProfileAccessService } from '../voice/profile-access-service';
import { profileNotFound } from '../voice/errors';

import type {
  DialogueRendition,
  DialogueRenditionStorePort,
  SpeechFailureRejectionPort,
  SpeechSynthesisPort,
} from './ports';
import {
  dialogueAssetNotFound,
  dialogueGenerationFailed,
  dialogueLanguageUnsupported,
  dialogueLineIndexInvalid,
  dialogueLinesInvalid,
  dialogueRequestInvalid,
  voiceProfileEngineLocked,
} from './speech-errors';
import {
  speechAppliedDefaults,
  type DialogueOutcome,
  type ResynthesisOutcome,
} from './speech-result';

/** Whether an engine can take 25.7's direction and 25.8's tags. */
export interface SpeechEngineCapability {
  readonly engineId: string;
  readonly supportsActingInstruction: boolean;
  readonly supportsParalinguisticTags: boolean;
}

export interface SpeechServiceOptions {
  readonly orchestrator: JobOrchestrator;
  readonly synthesis: SpeechSynthesisPort;
  readonly renditions: DialogueRenditionStorePort;
  /** Requirements 26.18–26.22, 26.29's gate — task 6.2's, consumed rather than repeated. */
  readonly access: ProfileAccessService;
  readonly profiles: VoiceProfileRecordStorePort;
  /** Requirements 25.2, 25.3 — the engines and their languages. */
  readonly languages: readonly EngineLanguageSupport[];
  /** Requirements 25.7, 25.8, 25.9 — per-engine capabilities. */
  readonly capabilities: readonly SpeechEngineCapability[];
  /** Requirement 25.1's refund path when no line could be synthesised. */
  readonly rejection: SpeechFailureRejectionPort;
  /** Requirement 25.18's draw. */
  readonly seeds: SeedSource;
  /** Requirement 34: the set in force. Defaults to the initial values (34.3). */
  readonly thresholds?: QualityThresholdSource;
  /** Design §3.6's 기본 엔진 for `dialogue`, used when the caller names none. */
  readonly defaultEngineId: string;
}

export interface DialogueSubmissionInput {
  readonly accountId: string;
  readonly request: DialogueGenerationRequest;
  /** Content policy verdict, evaluated lazily by the orchestrator (design §9.1). */
  readonly moderate?: () => ModerationDecision;
}

export interface LineResynthesisInput {
  readonly accountId: string;
  readonly assetId: string;
  /** Requirement 25.21: 0 ≤ index < 행 개수, or the request is refused. */
  readonly lineIndex: number;
  readonly moderate?: () => ModerationDecision;
}

export class SpeechService {
  private readonly options: SpeechServiceOptions;
  private readonly thresholds: QualityThresholdSource;

  constructor(options: SpeechServiceOptions) {
    this.options = options;
    this.thresholds = options.thresholds ?? fixedThresholdSource();
  }

  /** Requirement 25.2: the engines and the languages each supports. */
  engineLanguages(): readonly EngineLanguageSupport[] {
    return languageCatalogue(this.options.languages);
  }

  /**
   * Requirements 25.1, 25.4–25.14, 25.17–25.19, 25.23, 27.14.
   *
   * The order is load-bearing and mirrors `V2aService.generate`'s: profile access, then engine
   * selection, then validation, then submission. Access first because 26.29's withdrawal refusal
   * must not depend on a well-formed request; engine selection before validation because 25.7,
   * 25.8 and 25.9 are decided by the engine's capabilities; validation before any submission
   * because 25.22 must refuse before anything is charged.
   */
  async generate(input: DialogueSubmissionInput): Promise<DialogueOutcome> {
    // Requirements 26.18, 26.20, 26.22, 26.29 — through task 6.2's gate, not a second copy of it.
    this.options.access.assertUsable(input.request.voiceProfileId, input.accountId);

    const profile = this.options.profiles.find(input.request.voiceProfileId);
    // `assertUsable` proved the consent row exists; a missing profile record means the two stores
    // disagree, which is the same answer 26.22 gives for a profile that is not there.
    if (profile === undefined) throw profileNotFound(input.request.voiceProfileId);

    // Requirements 26.10, 26.11 — a preset's binding wins over anything the caller named.
    const binding = checkEngineBinding(profile, input.request.engineId);
    if (binding.outcome === 'refused') {
      throw voiceProfileEngineLocked({
        voiceProfileId: input.request.voiceProfileId,
        boundEngineId: binding.boundEngineId,
        requestedEngineId: binding.requestedEngineId,
      });
    }

    // A caller (or a preset binding) that named an engine gets that engine's verdict; only an
    // unspecified engine may be chosen by language. See `selectEngine`.
    const namedEngineId = submissionEngineIdOf(profile, input.request.engineId);
    const engineId = this.selectEngine(
      namedEngineId,
      input.request.languageCode,
      namedEngineId !== undefined,
    );
    const capability = this.capabilityOf(engineId);

    // Requirements 25.4–25.10, 25.22 — before anything is charged.
    const validation = validateDialogueRequest(input.request, {
      supportsActingInstruction: capability.supportsActingInstruction,
      supportsParalinguisticTags: capability.supportsParalinguisticTags,
    });
    if (validation.kind === 'invalid') {
      throw dialogueRequestInvalid({
        violations: validation.violations,
        constraints: validation.constraints,
      });
    }
    const parameters = validation.parameters;

    // Requirement 25.14 — the stored line list, over the script the engine will actually receive
    // (so a tag stripped by 25.9 cannot make a line's stored length disagree with what was said).
    const lineCheck = validateScriptLines(parameters.script);
    if (lineCheck.kind === 'invalid') {
      throw dialogueLinesInvalid({
        violations: lineCheck.violations,
        constraints: lineCheck.constraints,
        lineCount: lineCheck.lines.length,
      });
    }

    // Requirements 25.10–25.13 — reported, and a coarser view of the same cuts. See the module
    // comment on why the synthesis unit is finer than this.
    const split = splitScript(parameters.script, {
      thresholdChars: parameters.splitThresholdChars,
    });

    return this.runGeneration({
      input,
      parameters,
      lines: lineCheck.lines,
      engineId,
      chunkCount: split.chunks.length,
      sentenceCount: split.sentenceCount,
    });
  }

  /**
   * Requirements 25.15, 25.16, 25.20, 25.21 — re-synthesise one line.
   *
   * The parameters are read off the stored rendition rather than accepted from the caller, which
   * is how 25.15's "최초 합성에 사용된 Voice_Profile과 엔진과 발화 속도와 음높이 조정 값" is
   * guaranteed: there is no argument through which a different value could arrive. The line's seed
   * is re-derived from the stored base seed by index, so the same line re-synthesised twice is
   * sample-identical.
   */
  async resynthesiseLine(input: LineResynthesisInput): Promise<ResynthesisOutcome> {
    const rendition = await this.options.renditions.find(input.assetId);
    if (rendition === undefined) throw dialogueAssetNotFound(input.assetId);

    const parameters = this.parametersOf(rendition);
    // Requirement 26.29 again: a profile withdrawn since the asset was made must not be usable for
    // *new* generation, and a re-synthesis is new generation.
    this.options.access.assertUsable(parameters.voiceProfileId, input.accountId);

    // Requirement 25.21 — refused before any submission, so nothing is charged and the stored
    // audio and every line's timing are untouched.
    if (
      !Number.isInteger(input.lineIndex) ||
      input.lineIndex < 0 ||
      input.lineIndex >= rendition.layout.segments.length
    ) {
      throw dialogueLineIndexInvalid({
        assetId: input.assetId,
        requestedIndex: input.lineIndex,
        lineCount: rendition.layout.segments.length,
      });
    }

    const set = this.thresholds.current();
    const tailThresholds = dialogueTailSilenceThresholds(set);
    const segment = rendition.layout.segments[input.lineIndex];
    if (segment === undefined) {
      throw dialogueLineIndexInvalid({
        assetId: input.assetId,
        requestedIndex: input.lineIndex,
        lineCount: rendition.layout.segments.length,
      });
    }

    const submitted = await this.submitJob({
      accountId: input.accountId,
      parameters,
      engineId: rendition.metadata.engineId,
      // The one line, so pricing and routing see the work actually being done.
      script: segment.text,
      seed: variantSeed(rendition.baseSeed, input.lineIndex),
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    });
    if (submitted.kind === 'blocked') return submitted;
    if (submitted.kind === 'unproduced') {
      throw dialogueGenerationFailed({
        jobId: submitted.jobId,
        lineCount: 1,
        completedLineCount: 0,
        failure: submitted.failure,
      });
    }

    const outcome = await this.options.synthesis.synthesiseLine({
      jobId: submitted.jobId,
      accountId: input.accountId,
      lineIndex: input.lineIndex,
      text: segment.text,
      parameters,
      engineId: rendition.metadata.engineId,
      seed: variantSeed(rendition.baseSeed, input.lineIndex),
    });

    if (outcome.kind === 'unproduced') {
      await this.options.rejection.reject({
        jobId: submitted.jobId,
        accountId: input.accountId,
        unmet: ['line_synthesis'],
      });
      throw dialogueGenerationFailed({
        jobId: submitted.jobId,
        lineCount: rendition.layout.segments.length,
        completedLineCount: 0,
        failure: outcome.failure,
      });
    }

    const pieces = [...rendition.linePieces];
    pieces[input.lineIndex] = outcome.line.audio;
    // Requirement 25.19 on the re-joined audio: the tail belongs to the last piece, so adjusting
    // it there — before the join — keeps the layout the timings come from consistent with the
    // audio. When the re-synthesised line *is* the last one, this adjusts the new piece.
    const assembled = this.assemble(pieces, tailThresholds);

    const retiming = retimeAfterResynthesis(
      rendition.layout,
      input.lineIndex,
      audioDurationMs(assembled.pieces[input.lineIndex] ?? outcome.line.audio),
      assembled.overlapsMs,
    );
    const timing = dialogueTimingOf(retiming.layout, assembled.durationMs);

    const metadata: DialogueAssetMetadata = {
      ...rendition.metadata,
      timing,
      seamOverlapsMs: assembled.overlapsMs,
      trailingSilenceMs: Math.round(assembled.trailingSilenceMs),
      durationMs: Math.round(assembled.durationMs),
      qualityThresholdSetVersion: set.version,
    };

    await this.options.renditions.save({
      ...rendition,
      jobId: submitted.jobId,
      linePieces: assembled.pieces,
      layout: retiming.layout,
      timing,
      metadata,
    });

    return {
      kind: 'resynthesised',
      assetId: rendition.assetId,
      jobId: submitted.jobId,
      lineIndex: input.lineIndex,
      retimed: retiming.retimed,
      deltaMs: retiming.deltaMs,
      timing,
      metadata,
      audio: assembled.audio,
      tailSilence: assembled.tailSilence,
    };
  }

  /* ------------------------------------------------------------------ internals */

  /** Requirements 25.11, 25.14, 25.17–25.19, 25.23 — the sequential walk and the assembly. */
  private async runGeneration(input: {
    readonly input: DialogueSubmissionInput;
    readonly parameters: SpeechParameters;
    readonly lines: readonly ScriptLine[];
    readonly engineId: string;
    readonly chunkCount: number;
    readonly sentenceCount: number;
  }): Promise<DialogueOutcome> {
    // Read once per request, not once per line: an operator change landing mid-generation would
    // otherwise judge one line's tail against version 3 and the asset against version 4, and
    // Requirement 34.6 records one version per asset.
    const set = this.thresholds.current();
    const tailThresholds = dialogueTailSilenceThresholds(set);

    // Requirement 25.18: the caller's seed, or one drawn now and recorded on the asset.
    const baseSeed = input.parameters.seed ?? this.options.seeds.draw();

    const submitted = await this.submitJob({
      accountId: input.input.accountId,
      parameters: input.parameters,
      engineId: input.engineId,
      script: input.parameters.script,
      seed: baseSeed,
      ...(input.input.moderate === undefined ? {} : { moderate: input.input.moderate }),
    });
    if (submitted.kind === 'blocked') return submitted;
    if (submitted.kind === 'unproduced') {
      // Requirements 6.1–6.3 already refunded this job; nothing to settle here.
      throw dialogueGenerationFailed({
        jobId: submitted.jobId,
        lineCount: input.lines.length,
        completedLineCount: 0,
        failure: submitted.failure,
      });
    }

    const pieces: PcmAudio[] = [];
    for (const line of input.lines) {
      const outcome = await this.options.synthesis.synthesiseLine({
        jobId: submitted.jobId,
        accountId: input.input.accountId,
        lineIndex: line.lineIndex,
        text: line.text,
        parameters: input.parameters,
        engineId: submitted.engineId,
        // Requirement 25.18: derived from the base by index, so the same request asks the engine
        // the same questions in the same order. `domain/sfx/seed.ts`, shared with tasks 2.5/2.6.
        seed: variantSeed(baseSeed, line.lineIndex),
      });

      if (outcome.kind === 'unproduced') {
        // Requirement 25.1: the asset cannot be assembled, so the job fails as a unit and the
        // whole charge is returned through the one refund path.
        await this.options.rejection.reject({
          jobId: submitted.jobId,
          accountId: input.input.accountId,
          unmet: ['line_synthesis'],
        });
        throw dialogueGenerationFailed({
          jobId: submitted.jobId,
          lineCount: input.lines.length,
          completedLineCount: pieces.length,
          failure: outcome.failure,
        });
      }

      pieces.push(outcome.line.audio);
    }

    const assembled = this.assemble(pieces, tailThresholds);
    const layout: DialogueLayout = {
      segments: input.lines.map((line, position) => ({
        lineIndex: line.lineIndex,
        text: line.text,
        durationMs: audioDurationMs(assembled.pieces[position] ?? assembled.pieces[0] ?? assembled.audio),
      })),
      overlapsMs: assembled.overlapsMs,
    };
    const timing: DialogueTiming = dialogueTimingOf(layout, assembled.durationMs);

    const metadata = dialogueMetadata({
      parameters: input.parameters,
      voiceProfileId: input.parameters.voiceProfileId,
      engineId: submitted.engineId,
      seed: baseSeed,
      chunkCount: input.chunkCount,
      timing,
      seamOverlapsMs: assembled.overlapsMs,
      trailingSilenceMs: assembled.trailingSilenceMs,
      durationMs: assembled.durationMs,
      sampleRate: assembled.audio.sampleRate,
      channels: channelCount(assembled.audio),
      qualityThresholdSetVersion: set.version,
    });

    const rendition: DialogueRendition = {
      assetId: submitted.assetId,
      jobId: submitted.jobId,
      accountId: input.input.accountId,
      linePieces: assembled.pieces,
      layout,
      timing,
      metadata,
      baseSeed,
    };
    await this.options.renditions.save(rendition);

    return {
      kind: 'produced',
      jobId: submitted.jobId,
      assetId: submitted.assetId,
      timing,
      metadata,
      audio: assembled.audio,
      chunkCount: input.chunkCount,
      sentenceCount: input.sentenceCount,
      removedTags: input.parameters.removedTags,
      tailSilence: assembled.tailSilence,
      applied: speechAppliedDefaults(input.parameters),
      baseSeed,
      engineId: submitted.engineId,
    };
  }

  /**
   * Requirements 25.11, 25.19 — the tail adjustment and the join, in that order.
   *
   * The order matters and is the reason this is one function. 25.19 measures "합성된 오디오의 마지막
   * 표본부터", and the joined audio's last sample *is* the last piece's last sample — the join never
   * touches the final segment's tail. So adjusting the last piece before joining gives exactly the
   * same audio as adjusting the joined file, while leaving the per-line layout consistent with
   * what was stored. Adjusting afterwards would make the last line's recorded duration disagree
   * with its audio.
   */
  private assemble(
    pieces: readonly PcmAudio[],
    thresholds: ReturnType<typeof dialogueTailSilenceThresholds>,
  ): AssembledDialogue {
    const lastIndex = pieces.length - 1;
    const last = pieces[lastIndex];
    const verdict =
      last === undefined
        ? evaluateTailSilence(
            { trailingSilenceMs: 0, trailingPeakDbfs: -Infinity, durationMs: 0, sampleRate: 0 },
            thresholds,
          )
        : evaluateTailSilence(measureTailSilence(last, thresholds.silenceFloorDbfs), thresholds);

    const adjusted =
      last === undefined
        ? pieces
        : pieces.map((piece, index) =>
            index === lastIndex ? adjustTailSilence(piece, verdict) : piece,
          );

    const joined = crossfadeJoin(adjusted, DIALOGUE_CROSSFADE_MS);
    const overlapsMs = joined.overlapFrames.map((frames) =>
      joined.audio.sampleRate > 0 ? (frames * 1000) / joined.audio.sampleRate : 0,
    );
    // Re-measured on the joined audio, so what the asset records is what the file has rather than
    // what the adjustment aimed for.
    const measured = measureTailSilence(joined.audio, thresholds.silenceFloorDbfs);

    return {
      pieces: adjusted,
      audio: joined.audio,
      overlapsMs,
      durationMs: joined.durationMs,
      trailingSilenceMs: measured.trailingSilenceMs,
      tailSilence: verdict,
    };
  }

  /** One Generation_Job for the whole asset. `resultCount: 1`, per Requirement 25.1. */
  private async submitJob(input: {
    readonly accountId: string;
    readonly parameters: SpeechParameters;
    readonly engineId: string;
    readonly script: string;
    readonly seed: number;
    readonly moderate?: () => ModerationDecision;
  }): Promise<SubmittedDialogueJob> {
    const outcome = await this.options.orchestrator.submit({
      accountId: input.accountId,
      // Requirement 25.1.
      assetKind: 'dialogue',
      inputModality: 'text',
      durationMs: estimatedDialogueDurationMs(input.script, input.parameters.speakingRate),
      // The text the Moderation_Service inspects as 16.10's `dialogue_script` — which is where
      // Requirement 16.11's impersonation block and Requirement 26.17's prohibited-use block both
      // happen, through task 6.1's classifier rather than anything restated here.
      prompt: input.script,
      seed: input.seed,
      engineId: input.engineId,
      resultCount: 1,
      speech: input.parameters,
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    });

    if (outcome.kind === 'blocked') return { kind: 'blocked', decision: outcome.decision };
    if (outcome.kind === 'failed') {
      return { kind: 'unproduced', jobId: outcome.jobId, failure: outcome.failure };
    }

    return {
      kind: 'accepted',
      jobId: outcome.acceptance.jobId,
      engineId: outcome.acceptance.engineId,
      assetId: `${outcome.acceptance.jobId}-asset-0`,
    };
  }

  /**
   * Requirements 25.2, 25.3, 26.10 — which engine speaks this language.
   *
   * `pinned` distinguishes the two cases the criterion treats differently. A caller who named an
   * engine (or a `preset` profile that binds one) gets that engine judged: unsupported means
   * refused, with the list of engines that would have worked. A caller who named none is *routed*
   * by language — the default engine when it speaks the language, otherwise the first engine that
   * does — because refusing a request the platform can satisfy would make 25.2's multi-engine
   * promise depend on the caller knowing which engine to ask for.
   */
  private selectEngine(engineId: string | undefined, languageCode: string, pinned: boolean): string {
    const supporting = enginesSupportingLanguage(this.options.languages, languageCode);

    if (pinned && engineId !== undefined) {
      const entry = languageSupportOf(this.options.languages, engineId);
      if (entry === undefined || !entry.languageCodes.includes(languageCode.toLowerCase())) {
        throw dialogueLanguageUnsupported({
          languageCode,
          engineId,
          supportingEngineIds: supporting,
          languageCatalogue: this.engineLanguages(),
        });
      }
      return engineId;
    }

    if (supporting.includes(this.options.defaultEngineId)) return this.options.defaultEngineId;

    const chosen = supporting[0];
    if (chosen === undefined) {
      throw dialogueLanguageUnsupported({
        languageCode,
        engineId: this.options.defaultEngineId,
        supportingEngineIds: supporting,
        languageCatalogue: this.engineLanguages(),
      });
    }
    return chosen;
  }

  /**
   * Requirements 25.7, 25.8 — the named engine's capabilities.
   *
   * An engine with no declared record is treated as supporting neither. Failing closed is the only
   * safe default: forwarding a 연기 지시 to an engine that cannot read it would put the direction
   * into the synthesised speech as spoken words, and keeping a `[laugh]` marker in would have the
   * engine say "bracket laugh".
   */
  private capabilityOf(engineId: string): SpeechEngineCapability {
    return (
      this.options.capabilities.find((entry) => entry.engineId === engineId) ?? {
        engineId,
        supportsActingInstruction: false,
        supportsParalinguisticTags: false,
      }
    );
  }

  /**
   * The parameters a stored rendition was produced with (Requirement 25.15).
   *
   * Reconstructed from the metadata rather than stored twice, so there is one copy of the truth
   * and a re-synthesis cannot use a stale duplicate.
   */
  private parametersOf(rendition: DialogueRendition): SpeechParameters {
    const metadata = rendition.metadata;
    return {
      script: metadata.script,
      originalScript: metadata.script,
      voiceProfileId: metadata.voiceProfileId,
      languageCode: metadata.languageCode,
      speakingRate: metadata.speakingRate,
      pitchSemitones: metadata.pitchSemitones,
      actingInstruction: metadata.actingInstruction,
      splitThresholdChars: metadata.splitThresholdChars,
      removedTags: metadata.removedTags,
      seed: metadata.seed,
      appliedDefaults: [],
    };
  }
}

interface AssembledDialogue {
  readonly pieces: readonly PcmAudio[];
  readonly audio: PcmAudio;
  readonly overlapsMs: readonly number[];
  readonly durationMs: number;
  readonly trailingSilenceMs: number;
  readonly tailSilence: TailSilenceVerdict;
}

type SubmittedDialogueJob =
  | {
      readonly kind: 'accepted';
      readonly jobId: string;
      readonly engineId: string;
      readonly assetId: string;
    }
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration }
  | { readonly kind: 'unproduced'; readonly jobId: string; readonly failure: JobFailure };
