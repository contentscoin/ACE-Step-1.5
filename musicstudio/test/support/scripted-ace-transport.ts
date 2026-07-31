import type {
  AceBinaryRequest,
  AceBinaryResponse,
  AceEnvelope,
  AceJsonRequest,
  AceJsonResponse,
  AceTransport,
} from '../../adapters/ace/transport';
import { ACE_PATHS } from '../../adapters/ace/ace-engine-adapter';
import type { SongTrackMetadata } from '../../domain/song/track-metadata';

/**
 * Scripted stand-in for the ACE-Step HTTP surface.
 *
 * The engine is a separate deployment (design §1.4.1) and is not running in CI, so
 * every adapter test drives it through this. It is scripted rather than
 * approximated: the test states what the engine answers, and the double records
 * every request verbatim so the *exact* wire payload can be asserted — which is
 * what Requirements 3.1–3.3, 3.7 and 4.1–4.10 are statements about.
 *
 * The envelope shape, the JSON-string `result` field and the nested per-audio item
 * shape all reproduce `acestep/api/http/query_result_service.py` faithfully, so a
 * decoding bug in the adapter shows up here rather than in production.
 */
export interface ScriptedAceTransport extends AceTransport {
  /** Reply to the next `/release_task` with this task id. */
  setTaskId(taskId: string, queuePosition?: number): void;
  /** Queue one `/query_result` answer per successive poll or fetch. */
  enqueueResult(...answers: readonly AceScriptedResult[]): void;
  /** Answer used once the queue empties. */
  setDefaultResult(answer: AceScriptedResult): void;
  /** Fail the next call to `path` with this HTTP status and envelope error. */
  failNext(path: string, httpStatus: number, error?: string): void;
  /** Serve this byte content for any `/v1/audio` download of `filePath`. */
  setAudio(filePath: string, content: Buffer): void;
  setHealthy(healthy: boolean): void;
  readonly jsonRequests: readonly AceJsonRequest[];
  readonly binaryRequests: readonly AceBinaryRequest[];
  /** The single request posted to `path`; throws when there is not exactly one. */
  onlyRequestTo(path: string): AceJsonRequest;
  lastRequestTo(path: string): AceJsonRequest | undefined;
}

/** One `/query_result` answer, in the product layer's vocabulary. */
export interface AceScriptedResult {
  /** 0 running, 1 succeeded, 2 failed — the engine's own status integer. */
  readonly statusCode: number;
  readonly progressText?: string;
  /** Engine-side fraction, 0.0–1.0. */
  readonly progress?: number;
  readonly error?: string;
  readonly audios?: readonly AceScriptedAudio[];
  /** Replaces the whole `result` field, for malformed-payload tests. */
  readonly rawResult?: string;
}

export interface AceScriptedAudio {
  readonly file: string;
  readonly metadata?: Partial<SongTrackMetadata>;
}

const RUNNING: AceScriptedResult = { statusCode: 0, progress: 0.25 };

export function createScriptedAceTransport(): ScriptedAceTransport {
  const jsonRequests: AceJsonRequest[] = [];
  const binaryRequests: AceBinaryRequest[] = [];
  const results: AceScriptedResult[] = [];
  const audio = new Map<string, Buffer>();
  const failures = new Map<string, { httpStatus: number; error?: string }>();
  let defaultResult: AceScriptedResult = RUNNING;
  let taskId = 'ace-task-1';
  let queuePosition = 1;
  let healthy = true;

  const envelope = (data: unknown): AceEnvelope => ({
    data,
    code: 200,
    error: null,
    timestamp: 1_700_000_000_000,
    extra: null,
  });

  return {
    jsonRequests,
    binaryRequests,

    setTaskId(next, position = 1) {
      taskId = next;
      queuePosition = position;
    },
    enqueueResult(...answers) {
      results.push(...answers);
    },
    setDefaultResult(answer) {
      defaultResult = answer;
    },
    failNext(path, httpStatus, error) {
      failures.set(path, error === undefined ? { httpStatus } : { httpStatus, error });
    },
    setAudio(filePath, content) {
      audio.set(filePath, content);
    },
    setHealthy(next) {
      healthy = next;
    },

    onlyRequestTo(path) {
      const matches = jsonRequests.filter((request) => request.path === path);
      if (matches.length !== 1) {
        throw new Error(
          `expected exactly one request to ${path}, saw ${String(matches.length)}`,
        );
      }
      return matches[0] as AceJsonRequest;
    },
    lastRequestTo(path) {
      return jsonRequests.filter((request) => request.path === path).at(-1);
    },

    async postJson(request): Promise<AceJsonResponse> {
      jsonRequests.push(request);

      const failure = failures.get(request.path);
      if (failure !== undefined) {
        failures.delete(request.path);
        return {
          httpStatus: failure.httpStatus,
          envelope: {
            data: null,
            code: failure.httpStatus,
            ...(failure.error === undefined ? {} : { error: failure.error }),
          },
        };
      }

      if (request.path === ACE_PATHS.releaseTask) {
        return {
          httpStatus: 200,
          envelope: envelope({ task_id: taskId, status: 'queued', queue_position: queuePosition }),
        };
      }

      if (request.path === ACE_PATHS.queryResult) {
        const ids = (request.body.task_id_list as readonly string[] | undefined) ?? [];
        const answer = results.shift() ?? defaultResult;
        return {
          httpStatus: 200,
          envelope: envelope(ids.map((id) => resultItemFor(id, answer))),
        };
      }

      if (request.path === ACE_PATHS.health) {
        return {
          httpStatus: 200,
          envelope: envelope({ status: healthy ? 'ok' : 'degraded', service: 'ACE-Step API' }),
        };
      }

      return { httpStatus: 404, envelope: { data: null, code: 404, error: 'no such route' } };
    },

    async getBinary(request): Promise<AceBinaryResponse> {
      binaryRequests.push(request);
      const failure = failures.get(request.path);
      if (failure !== undefined) {
        failures.delete(request.path);
        return { httpStatus: failure.httpStatus, body: Buffer.alloc(0) };
      }

      const requested = request.query.path ?? '';
      const content = audio.get(requested);
      if (content === undefined) return { httpStatus: 404, body: Buffer.alloc(0) };
      return { httpStatus: 200, body: content };
    },
  };
}

/** Reproduces one `/query_result` list entry, `result` included as JSON text. */
function resultItemFor(id: string, answer: AceScriptedResult): Record<string, unknown> {
  return {
    task_id: id,
    status: answer.statusCode,
    progress_text: answer.progressText ?? '',
    result: answer.rawResult ?? JSON.stringify(resultPayload(answer)),
  };
}

function resultPayload(answer: AceScriptedResult): readonly Record<string, unknown>[] {
  const audios = answer.audios ?? [];
  if (audios.length === 0) {
    // The engine's placeholder item for a task with no output yet.
    return [
      {
        file: '',
        wave: '',
        status: answer.statusCode,
        create_time: 1_700_000_000,
        env: 'development',
        prompt: '',
        lyrics: '',
        metas: {},
        progress: answer.progress ?? 0,
        stage: answer.statusCode === 0 ? 'running' : 'finished',
        error: answer.error ?? null,
      },
    ];
  }

  return audios.map((entry) => {
    const meta = entry.metadata ?? {};
    return {
      file: entry.file,
      wave: '',
      status: answer.statusCode,
      create_time: 1_700_000_000,
      env: 'development',
      prompt: meta.caption ?? '',
      lyrics: meta.lyrics ?? '',
      metas: {
        bpm: meta.bpm ?? null,
        duration: meta.durationSeconds ?? null,
        genres: meta.genres ?? '',
        keyscale: meta.keyScale ?? '',
        timesignature: meta.timeSignature === undefined ? '' : String(meta.timeSignature),
      },
    };
  });
}
