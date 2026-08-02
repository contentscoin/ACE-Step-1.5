/**
 * ACE_Engine_Adapter (design §3.1, §3.6; Requirements 3, 4).
 *
 * The single coupling point between MusicStudio and ACE-Step. It implements
 * `EngineAdapter` and nothing more: the job lifecycle, the retry schedule, the
 * 300-second budget and the 0/1/2 status translation all belong to the
 * Job_Orchestrator, and re-deriving any of them here would create a second answer
 * to a question that already has one. This class is transport plus translation.
 *
 * Design §3.6 assigns ACE-Step to `song`, `bgm` and `stem`; only `song`
 * (`task_type=text2music`) is submitted by task 2.1. The `taskType` seam is present
 * so the edit tasks can be selected later without reopening the request builder.
 */

import type { EngineAdapter } from '../engine-adapter';
import type {
  EngineJobHandle,
  EngineJobStatus,
  EngineJobState,
  HealthCheckResult,
} from '../engine-job';
import type { NormalizedGenerationRequest } from '../normalized-generation';
import { ACE_ENGINE_SAMPLE_RATE } from '../../domain/song/engine-bounds';
import type { Clock } from '../../services/clock';

import { asRecord, unwrapEnvelope } from './envelope';
import { aceMalformedResponse, aceTaskUnknown } from './errors';
import { editParametersOf, songParametersOf } from './generation-request';
import { decodeTaskResult, type AceTaskResult } from './query-result';
import { buildAceSubmitPayload } from './submit-payload';
import { decodeSubmitAck } from './submit-ack';
import type { AceRawAudioResult } from './raw-result';
import { toRawAudioResults } from './raw-result';
import { type AceTaskType } from './task-type';
import type { AceTransport } from './transport';

export const ACE_PATHS = {
  releaseTask: '/release_task',
  queryResult: '/query_result',
  audio: '/v1/audio',
  health: '/health',
} as const;

export interface AceEngineAdapterOptions {
  readonly engineId: string;
  readonly transport: AceTransport;
  readonly clock: Clock;
  /** Overridden by task 2.2 to select an edit task; defaults to `text2music`. */
  readonly taskTypeFor?: (request: NormalizedGenerationRequest) => AceTaskType;
}

export class AceEngineAdapter implements EngineAdapter {
  readonly engineId: string;

  private readonly transport: AceTransport;
  private readonly clock: Clock;
  private readonly taskTypeFor:
    | ((request: NormalizedGenerationRequest) => AceTaskType)
    | undefined;

  constructor(options: AceEngineAdapterOptions) {
    this.engineId = options.engineId;
    this.transport = options.transport;
    this.clock = options.clock;
    this.taskTypeFor = options.taskTypeFor;
  }

  /**
   * Requirements 3.1–3.3, 3.6, 3.7, 4.1–4.5, 4.7–4.10 and 7.1–7.3, 7.6–7.8 all land
   * on this wire body.
   *
   * The task type comes from the request's Edit_Task when it carries one, so an edit
   * needs no configuration to be submitted as `cover` / `repaint` / `extract` /
   * `lego` / `complete`. The `taskTypeFor` option still wins when supplied, which is
   * what keeps the unnamed `cover-nofsq` variant reachable.
   */
  async submit(request: NormalizedGenerationRequest): Promise<EngineJobHandle> {
    const taskType = this.taskTypeFor?.(request);
    const edit = editParametersOf(request);
    const payload = buildAceSubmitPayload({
      song: songParametersOf(request),
      ...(taskType === undefined ? {} : { taskType }),
      ...(edit === undefined ? {} : { edit }),
    });

    const response = await this.transport.postJson({
      path: ACE_PATHS.releaseTask,
      body: payload,
    });
    const ack = decodeSubmitAck(
      ACE_PATHS.releaseTask,
      unwrapEnvelope(ACE_PATHS.releaseTask, response),
    );

    return {
      engineId: this.engineId,
      engineJobId: ack.taskId,
      submittedAtMs: this.clock.now().getTime(),
    };
  }

  /**
   * Requirement 5.3's status, reported raw.
   *
   * The integer is narrowed to `EngineJobState` here because that type *is* the
   * 0/1/2 vocabulary (`adapters/engine-job.ts`); the translation to a user-visible
   * lifecycle state stays in `services/generation/engine-status.ts`.
   */
  async poll(handle: EngineJobHandle): Promise<EngineJobStatus> {
    const result = await this.queryResult(handle);
    const state = engineStateOf(result.statusCode);
    const failureReason = result.failureReason ?? result.progressText;

    return {
      state,
      ...(result.progressPercent === null ? {} : { progressPercent: result.progressPercent }),
      ...(state === 2 && failureReason !== null ? { failureReason } : {}),
    };
  }

  /**
   * Downloads every produced audio, each carrying the Requirement 3.4 metadata.
   *
   * Returns `AceRawAudioResult[]`, which is a `RawAudioResult[]` with the engine's
   * final caption, lyrics, BPM, key, time signature and length attached. Callers
   * bound by the interface see the plain form; the Library layer can narrow to
   * store what Requirement 3.4 lists.
   */
  async fetchResult(handle: EngineJobHandle): Promise<AceRawAudioResult[]> {
    const result = await this.queryResult(handle);
    const downloads = await Promise.all(
      result.entries.map(async (entry) => {
        if (entry.filePath === null) return null;
        const response = await this.transport.getBinary({
          path: ACE_PATHS.audio,
          query: { path: entry.filePath },
        });
        if (response.httpStatus < 200 || response.httpStatus >= 300) {
          throw aceMalformedResponse(
            ACE_PATHS.audio,
            `ACE-Step answered ${String(response.httpStatus)} for a produced audio file.`,
          );
        }
        return { entry, audioBuffer: response.body };
      }),
    );

    return toRawAudioResults(
      downloads.filter((download): download is NonNullable<typeof download> => download !== null),
      ACE_ENGINE_SAMPLE_RATE,
    );
  }

  /**
   * Requirement 20.7 liveness probe.
   *
   * The 10-second budget is applied by `health-monitor.ts`, so no timeout is set
   * here; a probe either answers or is cut off by the caller. An unreachable engine
   * is an unhealthy engine rather than a thrown error, because the monitor's job is
   * to record an outcome for every probe.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startedAtMs = this.clock.now().getTime();
    try {
      const response = await this.transport.postJson({ path: ACE_PATHS.health, body: {} });
      const data = asRecord(unwrapEnvelope(ACE_PATHS.health, response));
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
   * No-op, because ACE-Step exposes no cancellation route.
   *
   * Its HTTP surface has `/release_task`, `/query_result`, `/v1/audio` and
   * `/health`; there is nothing to call. The Job_Orchestrator already treats the
   * local transition as authoritative and the engine call as best-effort
   * (Requirement 5.7), so resolving is the honest answer: the user's job is
   * cancelled and refunded, and the engine finishes work nobody will collect.
   */
  async cancel(): Promise<void> {
    return Promise.resolve();
  }

  private async queryResult(handle: EngineJobHandle): Promise<AceTaskResult> {
    const response = await this.transport.postJson({
      path: ACE_PATHS.queryResult,
      // The engine accepts `task_id_list` as a list or as JSON text
      // (`parse_task_id_list`); the list form is used, being the typed one.
      body: { task_id_list: [handle.engineJobId] },
    });
    const result = decodeTaskResult(
      ACE_PATHS.queryResult,
      unwrapEnvelope(ACE_PATHS.queryResult, response),
      handle.engineJobId,
    );
    if (result === null) throw aceTaskUnknown(handle.engineJobId);
    return result;
  }

  private elapsedSince(startedAtMs: number): number {
    return Math.max(0, this.clock.now().getTime() - startedAtMs);
  }
}

/** 0, 1 and 2 are the only states `EngineJobStatus` admits; anything else is failure. */
function engineStateOf(statusCode: number): EngineJobState {
  if (statusCode === 0) return 0;
  if (statusCode === 1) return 1;
  return 2;
}
