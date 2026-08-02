/**
 * Narrow outbound ports of the Transcription_Service.
 *
 * Same discipline as `services/sound/*-ports.ts`. **No speech-recognition model is reachable from
 * this environment**, so the engine is a port with a deterministic in-memory implementation behind
 * it in `test/support/transcription-harness.ts`, and every rule Requirement 27 states about the
 * *result* — the three invariants of 27.6–27.8, the normalisation, the language report of 27.4, the
 * no-speech case of 27.12, the edits of 27.11 and 27.17 — is a pure function in
 * `domain/transcription/`.
 *
 * That division is what makes Requirement 27 testable at all. If the invariants lived inside the
 * engine adapter they could only be asserted about a model nobody here can run.
 *
 * | port | owner | criteria |
 * |---|---|---|
 * | `TranscriptionAudioProbePort` | DSP worker, **task 3.1** | 27.5, 27.12, 27.15 |
 * | `TranscriptionEnginePort` | an ASR model | 27.1, 27.3, 27.4, 27.16 |
 * | `TranscriptionStorePort` | storage, **task 5.1** | 27.11, 27.13, 27.17 |
 */

import type { TranscriptionLine, TranscriptionResult } from '../../domain/transcription/result';

/* ---------------------------------------------------------------------- probe */

/**
 * What a probe reports about the audio to be transcribed.
 *
 * `speechDurationMs` is here rather than on the engine's answer because Requirement 27.12 refuses
 * *before* transcription: "검출된 발화 구간의 총 길이가 200밀리초 미만이면 빈 행 목록과 발화 미검출
 * 사유 코드를 반환하고 대상 오디오 파일을 변경 없이 유지한다". A service that had to run the model
 * to discover there was nothing to transcribe would have spent the model run 27.12 exists to avoid.
 */
export interface ProbedTranscriptionAudio {
  readonly audioId: string;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly fileSizeBytes: number;
  /** Total length of the detected speech regions, by Requirement 30.12's rule. */
  readonly speechDurationMs: number;
}

export type TranscriptionProbeOutcome =
  | { readonly kind: 'probed'; readonly audio: ProbedTranscriptionAudio }
  /** The file could not be read; 27.15's measured values cannot be reported. */
  | { readonly kind: 'unreadable'; readonly detail: string };

export interface TranscriptionAudioProbePort {
  /**
   * Requirements 27.5, 27.12 — measure one Audio_Asset or uploaded file.
   *
   * The speech-presence thresholds are passed in rather than read by the worker, so 27.12's floor
   * and Requirement 30.12's speech rule cannot drift apart — the same discipline
   * `ReferenceSampleProbePort` follows for Requirement 26.5.
   */
  probe(request: {
    readonly audioId: string;
    readonly speechRmsThresholdDb: number;
    readonly speechMinDurationMs: number;
  }): Promise<TranscriptionProbeOutcome>;
}

/* --------------------------------------------------------------------- engine */

export interface TranscriptionEngineRequest {
  readonly audioId: string;
  readonly modelId: string;
  /** Requirement 27.3's hint, when the caller supplied one. */
  readonly languageCode?: string;
  readonly audioDurationMs: number;
}

export interface TranscriptionEngineOutput {
  /** Raw lines. Order, bounds and integrality are all normalised by the service. */
  readonly lines: readonly TranscriptionLine[];
  /**
   * Requirements 27.3, 27.4 — the language the engine reports.
   *
   * `confidence` is `null` when the engine was given a hint and simply echoed it; a number when it
   * detected the language itself. That distinction is 27.3 versus 27.4, and an engine that returned
   * a confidence for a hinted code would be reporting a detection it did not perform.
   */
  readonly languageCode: string;
  readonly confidence: number | null;
}

export type TranscriptionEngineOutcome =
  | { readonly kind: 'transcribed'; readonly output: TranscriptionEngineOutput }
  /** Requirement 27.16 — the engine reported a failure. */
  | { readonly kind: 'failed'; readonly detail: string };

export interface TranscriptionEnginePort {
  transcribe(request: TranscriptionEngineRequest): Promise<TranscriptionEngineOutcome>;
}

/* ---------------------------------------------------------------------- store */

/**
 * Where a transcription result lives between requests.
 *
 * Needed because Requirements 27.11, 27.13 and 27.17 all operate on a *stored* result: an edit
 * amends it, a download serialises it, and 27.16 requires an existing result to survive a later
 * failed attempt ("기존에 저장된 전사 결과를 변경 없이 유지한다"). That last one is the reason this is
 * a port rather than a value passed around — the preservation has to be observable.
 */
export interface TranscriptionStorePort {
  save(audioId: string, result: TranscriptionResult): void;
  find(audioId: string): TranscriptionResult | undefined;
}
