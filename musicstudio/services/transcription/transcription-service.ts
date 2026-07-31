/**
 * Transcription_Service (Requirement 27).
 *
 * It owns five things and delegates everything else:
 *
 * 1. **Validation** (27.5, 27.15) — over a probed record, so no model is run for audio that cannot
 *    be transcribed.
 * 2. **The tier and the deadline** (27.1, 27.2, 27.16) — the tier's declared per-second cost *is*
 *    the deadline, computed by `domain/transcription/model-tier.ts` so the budget enforced is the
 *    one advertised.
 * 3. **The no-speech path** (27.12) — decided from the probe, before the engine is called.
 * 4. **Normalisation and the invariants** (27.6–27.8) — through
 *    `domain/transcription/result.ts`.
 * 5. **The two edits** (27.11, 27.17) and **the two downloads** (27.13).
 *
 * ### Requirement 27.9 and 27.10 are honoured by *not* doing anything
 *
 * 27.9 makes this service the single source of line timings and 27.10 makes Requirement 10's
 * `LRC_Printer`/`LRC_Parser` the single serialisation path. Both are satisfied by composition
 * rather than by code: `download` calls `printLrc` from `domain/lyrics/lrc-printer.ts` — task 2.3's
 * printer, with task 2.3's ±10 ms round-trip guarantee — and `timingsFor` exposes this service's
 * line starts through task 2.3's `TimedLyricsSourcePort`. **No second printer and no second timing
 * source is introduced**, which is the only way two "single path" criteria can both be true.
 *
 * 27.9's other half — line *text* comes from the Lyrics_Document when the track has one, otherwise
 * from the transcript — is the caller's choice of text, not this service's, so
 * `timedLyricsFor` takes the lyric lines as an argument. Deciding it here would mean this service
 * reached into Lyrics_Document storage, which is task 2.3's.
 *
 * ### Requirement 27.14 belongs to the Speech_Service, not here
 *
 * A `dialogue` asset's timings are the boundaries the *synthesis* confirmed, not a transcription of
 * its own output. `SpeechService` stores them (`domain/speech/line-timing.ts`) and they are that
 * asset's timing source. Transcribing a dialogue asset to recover timings it already has would be
 * both wasteful and less accurate.
 */

import { printLrc } from '../../domain/lyrics/lrc-printer';
import type { TimedLyricLine, TimedLyrics } from '../../domain/lyrics/timed-lyrics';
import { sortByTime } from '../../domain/lyrics/timed-lyrics';
import { speechPresenceThresholds } from '../../domain/quality/speech-thresholds';
import {
  fixedThresholdSource,
  type QualityThresholdSource,
} from '../../domain/quality/threshold-source';
import { enumViolation, rangeViolation, type SongFieldViolation } from '../../domain/song/violation';
import { isLanguageCode, normaliseLanguageCode } from '../../domain/speech/language';
import {
  TRANSCRIPTION_DURATION_MS_MAX,
  TRANSCRIPTION_DURATION_MS_MIN,
  TRANSCRIPTION_FILE_SIZE_BYTES_MAX,
  TRANSCRIPTION_SAMPLE_RATE_MAX,
  TRANSCRIPTION_SAMPLE_RATE_MIN,
  isTranscriptionDurationMs,
  isTranscriptionSampleRate,
} from '../../domain/transcription/bounds';
import {
  DEFAULT_TRANSCRIPTION_TIERS,
  DEFAULT_TRANSCRIPTION_TIER_ID,
  findTier,
  hasExceededBudget,
  responseBudgetMs,
  type TranscriptionTier,
} from '../../domain/transcription/model-tier';
import {
  detectedLanguage,
  editLineText,
  editLineTiming,
  hintedLanguage,
  normaliseTranscriptionLines,
  type TranscriptionResult,
} from '../../domain/transcription/result';
import type { Clock } from '../clock';
import type {
  ReferenceTranscriptionOutcome,
  ReferenceTranscriptionPort,
  ReferenceTranscriptionRequest,
} from '../speech/ports';

import {
  transcriptionEditRejected,
  transcriptionFailed,
  transcriptionNotFound,
  transcriptionRequestInvalid,
  transcriptionTextRejected,
  type TranscriptionConstraint,
} from './errors';
import type {
  ProbedTranscriptionAudio,
  TranscriptionAudioProbePort,
  TranscriptionEnginePort,
  TranscriptionStorePort,
} from './ports';

export interface TranscriptionServiceDependencies {
  readonly probe: TranscriptionAudioProbePort;
  readonly engine: TranscriptionEnginePort;
  readonly store: TranscriptionStorePort;
  readonly clock: Clock;
  /** Requirement 27.2's declared tiers. Defaults to the seeded pair. */
  readonly tiers?: readonly TranscriptionTier[];
  /** Requirement 34: the set in force, for 27.12's speech-presence rule. */
  readonly thresholds?: QualityThresholdSource;
}

export interface TranscriptionRequest {
  readonly audioId: string;
  /** Requirement 27.2's selection. Omitted means the first declared tier. */
  readonly tierId?: string;
  /** Requirement 27.3's ISO 639-1 hint. Omitted means 27.4's auto-detection. */
  readonly languageCode?: string;
}

/** Requirement 27.13's two files. */
export interface TranscriptionDownload {
  /** Requirement 27.10, 27.13 — produced by task 2.3's `LRC_Printer`, not a second one. */
  readonly lrc: string;
  /** Requirement 27.13 — plain text, in the same line order as the result. */
  readonly text: string;
  readonly lrcFileName: string;
  readonly textFileName: string;
}

export class TranscriptionService implements ReferenceTranscriptionPort {
  private readonly deps: TranscriptionServiceDependencies;
  private readonly tiers: readonly TranscriptionTier[];
  private readonly thresholds: QualityThresholdSource;

  constructor(deps: TranscriptionServiceDependencies) {
    this.deps = deps;
    this.tiers = deps.tiers ?? DEFAULT_TRANSCRIPTION_TIERS;
    this.thresholds = deps.thresholds ?? fixedThresholdSource();
  }

  /** Requirement 27.2 — the tiers, each with its model identifier and per-second cost. */
  availableTiers(): readonly TranscriptionTier[] {
    return this.tiers;
  }

  /**
   * Requirements 27.1, 27.3–27.8, 27.12, 27.15, 27.16.
   *
   * The order is: validate the *request*, probe, validate the *audio*, check 27.12, run the engine,
   * check the deadline, normalise. The deadline is checked after the engine returns as well as
   * being reported: 27.16 fails the transcription when the budget elapses, and a model that
   * answered late has still answered late.
   */
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const existing = this.deps.store.find(request.audioId);
    const tier = this.resolveTier(request);
    const languageCode = this.resolveLanguageHint(request);

    const presence = speechPresenceThresholds(this.thresholds.current());
    const probed = await this.deps.probe.probe({
      audioId: request.audioId,
      speechRmsThresholdDb: presence.speechRmsThresholdDb,
      speechMinDurationMs: presence.speechMinDurationMs,
    });

    if (probed.kind === 'unreadable') {
      throw transcriptionRequestInvalid({
        audioId: request.audioId,
        violations: [
          rangeViolation(
            'duration',
            probed.detail,
            TRANSCRIPTION_DURATION_MS_MIN,
            TRANSCRIPTION_DURATION_MS_MAX,
            false,
          ),
        ],
        constraints: ['duration'],
      });
    }

    // Requirements 27.5, 27.15 — before the model is run, and with the audio untouched.
    this.assertAudioAcceptable(request.audioId, probed.audio);

    // Requirement 27.12 — decided from the probe, so no model run is spent on silence. The floor is
    // Requirement 30.12's minimum speech run, read from the Quality_Threshold_Set rather than
    // restated: see `domain/transcription/bounds.ts`.
    if (probed.audio.speechDurationMs < presence.speechMinDurationMs) {
      const empty: TranscriptionResult = {
        lines: [],
        language: languageCode === undefined ? detectedLanguage('en', 0) : hintedLanguage(languageCode),
        audioDurationMs: Math.round(probed.audio.durationMs),
        tierId: tier.tierId,
        modelId: tier.modelId,
        reasonCode: 'no_speech_detected',
      };
      // Not stored: 27.12 requires the audio to be unchanged and says nothing about replacing a
      // previously good result with an empty one. Overwriting would lose a transcription the user
      // may have edited under 27.11.
      return empty;
    }

    const acceptedAtMs = this.deps.clock.now().getTime();
    const budgetMs = responseBudgetMs(tier, probed.audio.durationMs);

    const outcome = await this.deps.engine.transcribe({
      audioId: request.audioId,
      modelId: tier.modelId,
      ...(languageCode === undefined ? {} : { languageCode }),
      audioDurationMs: probed.audio.durationMs,
    });

    // Requirement 27.16, checked whichever way the engine answered: a late success is still late,
    // and 27.1 states the deadline as a property of the *response*.
    if (
      hasExceededBudget({
        tier,
        audioDurationMs: probed.audio.durationMs,
        acceptedAtMs,
        nowMs: this.deps.clock.now().getTime(),
      })
    ) {
      throw transcriptionFailed({
        audioId: request.audioId,
        reasonCode: 'response_budget_exceeded',
        previousResultPreserved: existing !== undefined,
        budgetMs,
      });
    }

    if (outcome.kind === 'failed') {
      throw transcriptionFailed({
        audioId: request.audioId,
        reasonCode: 'engine_failure',
        detail: outcome.detail,
        previousResultPreserved: existing !== undefined,
        budgetMs,
      });
    }

    const result: TranscriptionResult = {
      // Requirements 27.6, 27.7, 27.8 — established here rather than checked, so the stored result
      // satisfies all three for any engine output.
      lines: normaliseTranscriptionLines(outcome.output.lines, probed.audio.durationMs),
      // Requirements 27.3, 27.4 — a hinted code carries no confidence; a detected one does, and
      // `detectedLanguage` derives 27.4's undetermined flag from the same number.
      language:
        languageCode === undefined
          ? detectedLanguage(
              normaliseLanguageCode(outcome.output.languageCode),
              outcome.output.confidence,
            )
          : hintedLanguage(languageCode),
      audioDurationMs: Math.round(probed.audio.durationMs),
      tierId: tier.tierId,
      modelId: tier.modelId,
      reasonCode: null,
    };

    this.deps.store.save(request.audioId, result);
    return result;
  }

  /** Requirement 27.11 — edit one line's text, keeping its times. */
  editText(audioId: string, lineIndex: number, text: string): TranscriptionResult {
    const stored = this.requireStored(audioId);
    const edit = editLineText(stored.lines, lineIndex, text);

    if (edit.kind === 'rejected') {
      throw transcriptionTextRejected({ audioId, lineIndex, violation: edit.violation });
    }

    const next: TranscriptionResult = { ...stored, lines: edit.lines };
    this.deps.store.save(audioId, next);
    return next;
  }

  /** Requirement 27.17 — move one line's times, refusing anything that breaks 27.6–27.8. */
  editTiming(
    audioId: string,
    lineIndex: number,
    startMs: number,
    endMs: number,
  ): TranscriptionResult {
    const stored = this.requireStored(audioId);
    const edit = editLineTiming(stored, lineIndex, startMs, endMs);

    if (edit.kind === 'rejected') {
      throw transcriptionEditRejected({
        audioId,
        lineIndex,
        violated: edit.violated,
        permittedFromMs: edit.permittedFromMs,
        permittedToMs: edit.permittedToMs,
      });
    }

    const next: TranscriptionResult = { ...stored, lines: edit.lines };
    this.deps.store.save(audioId, next);
    return next;
  }

  /**
   * Requirements 27.10, 27.13 — the LRC file and the plain-text file.
   *
   * The LRC comes from task 2.3's `printLrc`, which is what makes 27.10's "유일한 LRC 직렬화 경로"
   * true and inherits Requirement 10.4's ±10 ms round-trip guarantee without restating it. The
   * plain text is the same lines in the same order, which is 27.13's other half.
   */
  download(audioId: string): TranscriptionDownload {
    const stored = this.requireStored(audioId);
    const timedLyrics = this.timedLyricsOf(stored);

    return {
      lrc: printLrc(timedLyrics),
      text: stored.lines.map((line) => line.text).join('\n'),
      lrcFileName: `${audioId}.lrc`,
      textFileName: `${audioId}.txt`,
    };
  }

  /**
   * Requirement 27.9 — this service's line starts, as Timed_Lyrics.
   *
   * `lyricLines` is Requirement 27.9's text choice: when the target Track has a Lyrics_Document,
   * its lines are used; otherwise the transcript's. The *timings* are always this service's, which
   * is the part 27.9 makes exclusive. Positional pairing, because 27.9 pairs a lyric line with a
   * transcription line by order and nothing else; a transcript with more lines than the document
   * keeps its own text for the surplus.
   */
  timedLyricsOf(result: TranscriptionResult, lyricLines?: readonly string[]): TimedLyrics {
    const lines: TimedLyricLine[] = result.lines.map((line, index) => ({
      startMs: line.startMs,
      text: lyricLines?.[index] ?? line.text,
    }));
    // Requirement 10.5's ordering, established through task 2.3's own function so there is one
    // definition of "sorted by time".
    return sortByTime({ lines });
  }

  /** Requirement 26.6 — the reference text for one voice sample. */
  async transcribeReference(
    request: ReferenceTranscriptionRequest,
  ): Promise<ReferenceTranscriptionOutcome> {
    try {
      const result = await this.transcribe({
        audioId: request.uploadId,
        ...(request.languageCode === undefined ? {} : { languageCode: request.languageCode }),
      });

      if (result.reasonCode !== null || result.lines.length === 0) {
        return { kind: 'unavailable', reasonCode: result.reasonCode ?? 'no_speech_detected' };
      }

      return {
        kind: 'transcribed',
        // One text for the whole sample: 26.6 asks for "해당 샘플의 참조 텍스트", singular, and a
        // voice prompt wants the words rather than their timing.
        text: result.lines.map((line) => line.text).join(' '),
        languageCode: result.language.languageCode,
      };
    } catch {
      // A reference sample that cannot be transcribed is not a reason to refuse the *profile* — it
      // already passed Requirement 26.5's speech-ratio check. See the note in
      // `services/voice/profile-service.ts` on the gap Requirement 26.6 leaves here.
      return { kind: 'unavailable', reasonCode: 'engine_failure' };
    }
  }

  /* ------------------------------------------------------------------ internals */

  /** Requirements 27.5, 27.15 — every violated bound at once. */
  private assertAudioAcceptable(audioId: string, audio: ProbedTranscriptionAudio): void {
    const violations: SongFieldViolation[] = [];
    const constraints: TranscriptionConstraint[] = [];

    if (!isTranscriptionDurationMs(audio.durationMs)) {
      violations.push(
        rangeViolation(
          'duration',
          audio.durationMs,
          TRANSCRIPTION_DURATION_MS_MIN,
          TRANSCRIPTION_DURATION_MS_MAX,
          false,
        ),
      );
      constraints.push('duration');
    }
    if (audio.fileSizeBytes > TRANSCRIPTION_FILE_SIZE_BYTES_MAX) {
      violations.push(
        rangeViolation('fileSize', audio.fileSizeBytes, 0, TRANSCRIPTION_FILE_SIZE_BYTES_MAX),
      );
      constraints.push('fileSize');
    }
    if (!isTranscriptionSampleRate(audio.sampleRate)) {
      violations.push(
        rangeViolation(
          'sampleRate',
          audio.sampleRate,
          TRANSCRIPTION_SAMPLE_RATE_MIN,
          TRANSCRIPTION_SAMPLE_RATE_MAX,
        ),
      );
      constraints.push('sampleRate');
    }

    if (violations.length > 0) {
      throw transcriptionRequestInvalid({ audioId, violations, constraints });
    }
  }

  /** Requirement 27.2 — an unknown tier is refused with the list that exists. */
  private resolveTier(request: TranscriptionRequest): TranscriptionTier {
    const tierId = request.tierId ?? DEFAULT_TRANSCRIPTION_TIER_ID;
    const tier = findTier(this.tiers, tierId) ?? this.tiers[0];

    if (request.tierId !== undefined && findTier(this.tiers, request.tierId) === undefined) {
      throw transcriptionRequestInvalid({
        audioId: request.audioId,
        violations: [
          enumViolation(
            'tierId',
            request.tierId,
            this.tiers.map((candidate) => candidate.tierId),
          ),
        ],
        constraints: ['tierId'],
      });
    }
    if (tier === undefined) {
      throw transcriptionRequestInvalid({
        audioId: request.audioId,
        violations: [enumViolation('tierId', tierId, [])],
        constraints: ['tierId'],
      });
    }
    return tier;
  }

  /** Requirement 27.3 — a malformed hint is refused rather than silently ignored. */
  private resolveLanguageHint(request: TranscriptionRequest): string | undefined {
    if (request.languageCode === undefined) return undefined;
    const code = normaliseLanguageCode(request.languageCode);
    if (!isLanguageCode(code)) {
      throw transcriptionRequestInvalid({
        audioId: request.audioId,
        violations: [rangeViolation('languageCode', request.languageCode, 2, 2)],
        constraints: ['languageCode'],
      });
    }
    return code;
  }

  private requireStored(audioId: string): TranscriptionResult {
    const stored = this.deps.store.find(audioId);
    if (stored === undefined) throw transcriptionNotFound(audioId);
    return stored;
  }
}
