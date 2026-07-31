/**
 * TTS_Adapter for design §3.6's 대체 엔진 (`tts-engine-b`).
 *
 * The second of the two engines Requirement 25.2 asks for, and a **genuinely different
 * implementation** rather than the first one parameterised. It implements the same
 * `EngineAdapter` interface and nothing more.
 *
 * ### What differs from engine A, and why the difference is kept
 *
 * | | engine A | engine B |
 * |---|---|---|
 * | envelope | `{ code, data }` wrapper | flat body, no wrapper |
 * | job identifier | `data.task_id` | `id` |
 * | status vocabulary | numeric `state` 0/1/2 | string `status`: `queued`/`running`/`succeeded`/`failed` |
 * | speaking rate | `speed` (multiplier) | `rate_percent` (percentage) |
 * | pitch | `pitch_semitones` | `pitch_cents` (hundredths of a semitone) |
 * | acting direction | `style_prompt` | **unsupported** (25.7's `WHERE` does not apply) |
 * | paralinguistic tags | read inline | **unsupported** (25.9 removes them before submission) |
 * | download | one `audio_url` | `outputs[]`, each with its own `path` |
 * | cancellation | documented route | none; resolves as a no-op |
 *
 * Two of those rows are the substance of Requirement 25's engine-difference criteria: engine B
 * cannot take a 연기 지시 (so 25.7 never forwards one) and cannot read 준언어 태그 (so 25.9 strips
 * them and reports the names). Both decisions were already taken by
 * `validateDialogueRequest` reading `adapters/tts/capabilities.ts`, which is why this adapter has
 * no branch for either: what arrives is already what this engine can be sent.
 *
 * The rate and pitch conversions are the reason `SpeechParameters` is expressed in product units
 * and translated per adapter. A percentage and a multiplier are the same information; a service
 * that had to know which engine wanted which would be a service that had learned an engine's
 * spelling, which design §1.2 exists to prevent.
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

import { TTS_ENGINE_B_CAPABILITIES } from './capabilities';
import { ttsMalformedResponse, ttsTaskUnknown } from './errors';
import type { TtsTransport } from './transport';
import { asRecord, engineStateFromText, numberOrNull, seedOf, speechParametersOf } from './wire';

export const TTS_B_PATHS = {
  synthesise: '/api/synthesize',
  convert: '/api/convert',
  job: '/api/jobs',
  download: '/api/download',
  health: '/api/status',
} as const;

/** Engine B states pitch in cents. One semitone is 100 cents. */
export const CENTS_PER_SEMITONE = 100;

export interface TtsEngineBAdapterOptions {
  readonly transport: TtsTransport;
  readonly clock: Clock;
  readonly sampleRate?: number;
}

export class TtsEngineBAdapter implements EngineAdapter {
  readonly engineId = TTS_ENGINE_B_CAPABILITIES.engineId;

  private readonly transport: TtsTransport;
  private readonly clock: Clock;
  private readonly sampleRate: number;

  constructor(options: TtsEngineBAdapterOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
    this.sampleRate = options.sampleRate ?? TTS_ENGINE_B_CAPABILITIES.sampleRate;
  }

  /**
   * Requirements 25.1, 25.5, 25.6, 25.18 on engine B's wire body.
   *
   * No `style_prompt` equivalent is sent even when `actingInstruction` is somehow non-null,
   * because this engine has no field for it — 25.7 applies only "WHERE 선택된 엔진이 자연어 연기
   * 지시를 지원하는 경우", and forwarding it under another name would be inventing a capability.
   */
  async submit(request: NormalizedGenerationRequest): Promise<EngineJobHandle> {
    // Requirement 26.24, on engine B's own conversion route. See the note in
    // `tts-engine-a-adapter.ts`: a conversion carries an utterance rather than a script.
    if (request.inputModality === 'audio') return this.submitConversion(request);

    const parameters = speechParametersOf(TTS_B_PATHS.synthesise, request);

    const response = await this.transport.requestJson({
      path: TTS_B_PATHS.synthesise,
      method: 'POST',
      body: {
        utterance: request.prompt ?? parameters.script,
        speaker: parameters.voiceProfileId,
        lang: parameters.languageCode,
        // Requirement 25.5 as a percentage: 1.0× is 100.
        rate_percent: Math.round(parameters.speakingRate * 100),
        // Requirement 25.6 in cents.
        pitch_cents: Math.round(parameters.pitchSemitones * CENTS_PER_SEMITONE),
        random_seed: seedOf(TTS_B_PATHS.synthesise, request),
        output: { format: 'wav', sample_rate_hz: this.sampleRate },
      },
    });

    const body = asRecord(response.body);
    const id = body?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw ttsMalformedResponse(TTS_B_PATHS.synthesise, 'no id in the accepted response');
    }

    return {
      engineId: this.engineId,
      engineJobId: id,
      submittedAtMs: this.clock.now().getTime(),
    };
  }

  /** Requirement 26.24 — a voice conversion, in engine B's own flat body. */
  private async submitConversion(
    request: NormalizedGenerationRequest,
  ): Promise<EngineJobHandle> {
    const source = request.inputAssetIds?.[0];
    if (source === undefined) {
      throw ttsMalformedResponse(
        TTS_B_PATHS.convert,
        'a voice conversion needs a source Audio_Asset identifier',
      );
    }

    const response = await this.transport.requestJson({
      path: TTS_B_PATHS.convert,
      method: 'POST',
      body: {
        source,
        speaker: request.prompt ?? '',
        random_seed: seedOf(TTS_B_PATHS.convert, request),
        output: { format: 'wav', sample_rate_hz: this.sampleRate },
      },
    });

    const body = asRecord(response.body);
    const id = body?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw ttsMalformedResponse(TTS_B_PATHS.convert, 'no id in the accepted response');
    }

    return {
      engineId: this.engineId,
      engineJobId: id,
      submittedAtMs: this.clock.now().getTime(),
    };
  }

  /** Requirement 5.3's status, translated from engine B's string vocabulary. */
  async poll(handle: EngineJobHandle): Promise<EngineJobStatus> {
    const job = await this.queryJob(handle);
    const state = engineStateFromText(job.status);
    const progress = numberOrNull(job.percent_complete);
    const reason = typeof job.failure === 'string' ? job.failure : null;

    return {
      state,
      ...(progress === null ? {} : { progressPercent: progress }),
      ...(state === ENGINE_JOB_STATE.failed && reason !== null ? { failureReason: reason } : {}),
    };
  }

  /**
   * Downloads every produced utterance.
   *
   * An entry with no path is skipped rather than failing the whole fetch — the same choice
   * `WooshEngineAdapter.fetchResult` makes, for the same reason: dropping an incomplete entry
   * keeps a partially-written batch usable, and with one utterance per submission the case does
   * not arise today.
   */
  async fetchResult(handle: EngineJobHandle): Promise<RawAudioResult[]> {
    const job = await this.queryJob(handle);
    const outputs = Array.isArray(job.outputs) ? job.outputs : [];

    const downloads = await Promise.all(
      outputs.map(async (entry): Promise<RawAudioResult | null> => {
        const record = asRecord(entry);
        const path = record?.path;
        if (typeof path !== 'string' || path.length === 0) return null;

        const response = await this.transport.requestBinary({
          path: TTS_B_PATHS.download,
          query: { file: path },
        });
        if (response.httpStatus < 200 || response.httpStatus >= 300) {
          throw ttsMalformedResponse(
            TTS_B_PATHS.download,
            `engine B answered ${String(response.httpStatus)} for a produced audio file`,
          );
        }

        return {
          audioBuffer: response.body,
          sampleRate: numberOrNull(record?.sample_rate_hz) ?? this.sampleRate,
          // Engine B reports seconds; the product layer works in milliseconds throughout.
          durationMs: Math.round((numberOrNull(record?.duration_seconds) ?? 0) * 1000),
          seed: numberOrNull(record?.random_seed),
        };
      }),
    );

    return downloads.filter((download): download is RawAudioResult => download !== null);
  }

  /** Requirement 20.7 liveness probe. The 10-second budget is `health-monitor.ts`'s. */
  async healthCheck(): Promise<HealthCheckResult> {
    const startedAtMs = this.clock.now().getTime();
    try {
      const response = await this.transport.requestJson({
        path: TTS_B_PATHS.health,
        method: 'GET',
      });
      const body = asRecord(response.body);
      const healthy = response.httpStatus === 200 && body?.ready === true;
      return {
        healthy,
        latencyMs: this.elapsedSince(startedAtMs),
        ...(healthy ? {} : { detail: `engine B reported ready=${String(body?.ready)}` }),
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
   * No-op, for the reason `AceEngineAdapter.cancel` and `WooshEngineAdapter.cancel` are: engine B
   * documents no cancellation route, and the Job_Orchestrator already treats the local transition
   * as authoritative and the engine call as best-effort (Requirement 5.7). Resolving is the honest
   * answer — the user's job is cancelled and refunded, and the engine finishes work nobody will
   * collect.
   */
  async cancel(): Promise<void> {
    return Promise.resolve();
  }

  private async queryJob(handle: EngineJobHandle): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.transport.requestJson({
      path: `${TTS_B_PATHS.job}/${handle.engineJobId}`,
      method: 'GET',
    });
    if (response.httpStatus === 404) {
      throw ttsTaskUnknown(TTS_B_PATHS.job, handle.engineJobId);
    }
    const body = asRecord(response.body);
    if (body === null) {
      throw ttsMalformedResponse(TTS_B_PATHS.job, 'the job body was not a JSON object');
    }
    return body;
  }

  private elapsedSince(startedAtMs: number): number {
    return Math.max(0, this.clock.now().getTime() - startedAtMs);
  }
}
