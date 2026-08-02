/**
 * TTS_Adapter for design §3.6's 기본 엔진 (`tts-engine-a`).
 *
 * The first of the two engines Requirement 25.2 asks for. It implements `EngineAdapter` and
 * nothing more: the job lifecycle, the Requirement 6.2 retry schedule, the Requirement 20.14
 * budget and the 0/1/2 status translation all belong to the Job_Orchestrator, exactly as in
 * `AceEngineAdapter` and `WooshEngineAdapter`. This class is transport plus translation.
 *
 * ### Its wire form, and why engine B's is different
 *
 * Engine A speaks a **wrapped envelope with numeric task states**: `{ code, data }` on every
 * route, `data.task_id` on submit, `data.state` as 0/1/2 on status, and a single `data.audio_url`
 * to download. That is a different protocol from engine B's flat REST body with string states
 * (see `tts-engine-b-adapter.ts`), and the difference is preserved rather than smoothed away —
 * two engines that happened to share a wire form would make the abstraction of design §3.1 look
 * like a formality instead of the thing that lets a deployment swap engines.
 *
 * ### The translation this adapter owns
 *
 * | product concept | engine A field |
 * |---|---|
 * | 25.5 발화 속도 | `speed` |
 * | 25.6 음높이 조정 | `pitch_semitones` |
 * | 25.7 연기 지시 | `style_prompt` |
 * | 25.8 준언어 태그 | left inline in `text` |
 * | Voice_Profile | `voice_ref` |
 * | 25.18 시드 | `seed` |
 *
 * The text sent is `request.prompt`, which is the *line* the Speech_Service is synthesising —
 * not the whole script. Requirements 25.14 and 25.15 make the line the synthesis unit, so one
 * submission is one line, and `speech.script` is carried alongside only as provenance for a
 * Requirement 6.4 retry.
 *
 * **No TTS service is reachable from this environment.** Everything below is exercised against a
 * deterministic in-memory transport; see `transport.ts` for what that leaves unverified.
 */

import type { EngineAdapter } from '../engine-adapter';
import {
  ENGINE_JOB_STATE,
  type EngineJobHandle,
  type EngineJobStatus,
  type HealthCheckResult,
  type RawAudioResult,
} from '../engine-job';
import type { NormalizedGenerationRequest } from '../normalized-generation';
import type { Clock } from '../../services/clock';

import { TTS_ENGINE_A_CAPABILITIES } from './capabilities';
import { ttsMalformedResponse, ttsTaskUnknown } from './errors';
import type { TtsTransport } from './transport';
import { asRecord, engineStateFromNumeric, numberOrNull, seedOf, speechParametersOf } from './wire';

export const TTS_A_PATHS = {
  submit: '/v1/tts/submit',
  convert: '/v1/tts/convert',
  status: '/v1/tts/status',
  audio: '/v1/tts/audio',
  health: '/v1/health',
} as const;

export interface TtsEngineAAdapterOptions {
  readonly transport: TtsTransport;
  readonly clock: Clock;
  /** Overridable so a deployment can declare a different native rate. */
  readonly sampleRate?: number;
}

export class TtsEngineAAdapter implements EngineAdapter {
  readonly engineId = TTS_ENGINE_A_CAPABILITIES.engineId;

  private readonly transport: TtsTransport;
  private readonly clock: Clock;
  private readonly sampleRate: number;

  constructor(options: TtsEngineAAdapterOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.sampleRate = options.sampleRate ?? TTS_ENGINE_A_CAPABILITIES.sampleRate;
  }

  /**
   * Requirements 25.1, 25.5, 25.6, 25.7, 25.8, 25.18 all land on this wire body.
   *
   * A request that reaches here with no `speech` block is a programming error rather than a bad
   * user input: routing sent a `dialogue` job to this adapter, so the parameters must be
   * present, and inventing defaults for them would submit a generation nobody validated. The
   * same stance `WooshEngineAdapter` takes for `sfx`.
   */
  async submit(request: NormalizedGenerationRequest): Promise<EngineJobHandle> {
    // Requirement 26.24's conversion is a different kind of work from 25.1's synthesis: the input is
    // an utterance rather than a script, so it has its own route and its own payload. Branching here
    // rather than at a higher layer is what keeps the Job_Orchestrator's submission uniform — it
    // routes by Asset_Kind and modality and knows nothing about either wire form.
    if (request.inputModality === 'audio') return this.submitConversion(request);

    const parameters = speechParametersOf(TTS_A_PATHS.submit, request);

    const response = await this.transport.requestJson({
      path: TTS_A_PATHS.submit,
      method: 'POST',
      body: {
        // The line being synthesised, tags left in place (25.8) because this engine reads them.
        text: request.prompt ?? parameters.script,
        voice_ref: parameters.voiceProfileId,
        language: parameters.languageCode,
        speed: parameters.speakingRate,
        pitch_semitones: parameters.pitchSemitones,
        // Requirement 25.7: only ever non-null when this engine supports it, because
        // `validateDialogueRequest` nulls it otherwise.
        ...(parameters.actingInstruction === null
          ? {}
          : { style_prompt: parameters.actingInstruction }),
        seed: seedOf(TTS_A_PATHS.submit, request),
        sample_rate: this.sampleRate,
      },
    });

    const data = asRecord(this.unwrap(TTS_A_PATHS.submit, response.body));
    const taskId = data?.task_id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw ttsMalformedResponse(TTS_A_PATHS.submit, 'no task_id in the accepted response');
    }

    return {
      engineId: this.engineId,
      engineJobId: taskId,
      submittedAtMs: this.clock.now().getTime(),
    };
  }

  /**
   * Requirement 26.24 — a voice conversion, on engine A's own conversion route.
   *
   * No `speech` block is required or read: a conversion carries no script, no speaking rate and no
   * pitch adjustment. What it carries is the source utterance and the target voice, which is exactly
   * what `inputAssetIds` and `prompt` hold for this submission.
   */
  private async submitConversion(
    request: NormalizedGenerationRequest,
  ): Promise<EngineJobHandle> {
    const sourceRef = request.inputAssetIds?.[0];
    if (sourceRef === undefined) {
      throw ttsMalformedResponse(
        TTS_A_PATHS.convert,
        'a voice conversion needs a source Audio_Asset identifier',
      );
    }

    const response = await this.transport.requestJson({
      path: TTS_A_PATHS.convert,
      method: 'POST',
      body: {
        source_ref: sourceRef,
        voice_ref: request.prompt ?? '',
        seed: seedOf(TTS_A_PATHS.convert, request),
        sample_rate: this.sampleRate,
      },
    });

    const data = asRecord(this.unwrap(TTS_A_PATHS.convert, response.body));
    const taskId = data?.task_id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw ttsMalformedResponse(TTS_A_PATHS.convert, 'no task_id in the accepted response');
    }

    return {
      engineId: this.engineId,
      engineJobId: taskId,
      submittedAtMs: this.clock.now().getTime(),
    };
  }

  /** Requirement 5.3's status, reported in design §3.1's 0/1/2 vocabulary. */
  async poll(handle: EngineJobHandle): Promise<EngineJobStatus> {
    const data = await this.queryTask(handle);
    const state = engineStateFromNumeric(numberOrNull(data.state));
    const progress = numberOrNull(data.progress);
    const reason = typeof data.error === 'string' ? data.error : null;

    return {
      state,
      ...(progress === null ? {} : { progressPercent: progress }),
      ...(state === ENGINE_JOB_STATE.failed && reason !== null ? { failureReason: reason } : {}),
    };
  }

  /**
   * Downloads the produced utterance.
   *
   * One result per submission, because one submission is one line. Returned as a single-element
   * array so the `EngineAdapter` contract is unchanged; a future batching engine would return
   * more without anything above this layer noticing.
   */
  async fetchResult(handle: EngineJobHandle): Promise<RawAudioResult[]> {
    const data = await this.queryTask(handle);
    const url = data.audio_url;
    if (typeof url !== 'string' || url.length === 0) {
      throw ttsMalformedResponse(TTS_A_PATHS.status, 'a finished task carried no audio_url');
    }

    const response = await this.transport.requestBinary({
      path: TTS_A_PATHS.audio,
      query: { url },
    });
    if (response.httpStatus < 200 || response.httpStatus >= 300) {
      throw ttsMalformedResponse(
        TTS_A_PATHS.audio,
        `engine A answered ${String(response.httpStatus)} for a produced audio file`,
      );
    }

    return [
      {
        audioBuffer: response.body,
        sampleRate: numberOrNull(data.sample_rate) ?? this.sampleRate,
        durationMs: numberOrNull(data.duration_ms) ?? 0,
        seed: numberOrNull(data.seed),
      },
    ];
  }

  /**
   * Requirement 20.7 liveness probe.
   *
   * The 10-second budget is applied by `health-monitor.ts`, so no timeout is set here. An
   * unreachable engine is an *unhealthy* engine rather than a thrown error, because the
   * monitor's job is to record an outcome for every probe.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startedAtMs = this.clock.now().getTime();
    try {
      const response = await this.transport.requestJson({
        path: TTS_A_PATHS.health,
        method: 'GET',
      });
      const data = asRecord(this.unwrap(TTS_A_PATHS.health, response.body));
      const status = data?.status;
      return {
        healthy: status === 'ok',
        latencyMs: this.elapsedSince(startedAtMs),
        ...(status === 'ok' ? {} : { detail: `unexpected status ${String(status)}` }),
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: this.elapsedSince(startedAtMs),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Cancels the engine-side task, best effort.
   *
   * Engine A documents a cancel route, so it is called; a refusal is swallowed for the reason
   * `JobOrchestrator.cancel` documents — the user's job and their credits are already settled
   * locally, and an engine that ignores the cancel wastes GPU time rather than leaving the job
   * uncancelled.
   */
  async cancel(handle: EngineJobHandle): Promise<void> {
    await this.transport.requestJson({
      path: `${TTS_A_PATHS.status}/cancel`,
      method: 'POST',
      body: { task_id: handle.engineJobId },
    });
  }

  private async queryTask(handle: EngineJobHandle): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.transport.requestJson({
      path: TTS_A_PATHS.status,
      method: 'GET',
      query: { task_id: handle.engineJobId },
    });
    const data = asRecord(this.unwrap(TTS_A_PATHS.status, response.body));
    if (data === null) throw ttsTaskUnknown(TTS_A_PATHS.status, handle.engineJobId);
    return data;
  }

  /** Engine A wraps every payload in `{ code, data }`; a non-2xx `code` is a failure. */
  private unwrap(path: string, body: unknown): unknown {
    const envelope = asRecord(body);
    if (envelope === null) throw ttsMalformedResponse(path, 'the body was not a JSON object');

    const code = numberOrNull(envelope.code);
    if (code !== null && (code < 200 || code >= 300)) {
      throw ttsMalformedResponse(path, `engine A reported code ${String(code)}`);
    }
    return envelope.data;
  }

  private elapsedSince(startedAtMs: number): number {
    return Math.max(0, this.clock.now().getTime() - startedAtMs);
  }
}
