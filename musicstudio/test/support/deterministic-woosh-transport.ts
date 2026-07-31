/**
 * A Woosh deployment simulated in memory (Requirement 22; design §3.1).
 *
 * **No Woosh service is reachable from this environment**, so this is what the Woosh adapter
 * is exercised against. It is deliberately a *deterministic function of the wire payload*
 * rather than a stub returning canned bytes, because that is what makes Requirement 22.8
 * testable at all: "the same prompt, engine, seed, length, variant count, step count and
 * guidance scale produce sample-identical audio" is only checkable against an engine that is
 * itself a function of those fields. A stub returning the same fixed buffer every time would
 * make the property pass without evidence.
 *
 * The determinism is arithmetic, not luck: the payload is hashed with FNV-1a, and the hash
 * seeds an xorshift generator that produces the sample values. Nothing here reads a clock, a
 * random source or a file.
 *
 * What it does *not* simulate is the engine's audio quality. A test that needs audio which
 * fails Requirement 22.14 or 22.15 scripts it through the candidate port
 * (`sfx-harness.ts`); this transport's business is being reproducible.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type {
  WooshBinaryRequest,
  WooshBinaryResponse,
  WooshJsonRequest,
  WooshJsonResponse,
  WooshTransport,
} from '../../adapters/woosh/transport';
import { WOOSH_PATHS } from '../../adapters/woosh/woosh-engine-adapter';

import { decayingOneShot, seamlessSfxLoop } from './pcm-synthesis';

/** The shape of audio the simulated engine returns. */
export type SimulatedAudioShape = 'one_shot' | 'loop';

export interface RecordedWooshSubmission {
  readonly taskId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DeterministicWooshTransport extends WooshTransport {
  /** Every submission, in order, exactly as it went on the wire. */
  readonly submissions: readonly RecordedWooshSubmission[];
  /** The seed field of each submission, in order — Requirement 22.5's distinctness. */
  seeds(): readonly number[];
  /** Deterministic PCM for a task, derived from its payload. */
  pcmFor(taskId: string): PcmAudio;
  /** Deterministic alignment score in `[0, 1]` for a task, derived from its payload. */
  alignmentScoreFor(taskId: string): number;
  /** Which shape subsequent tasks produce. Defaults to `one_shot`. */
  setAudioShape(shape: SimulatedAudioShape): void;
  /** Make the next `n` submissions answer with the given HTTP status. */
  failSubmit(httpStatus: number, times?: number): void;
}

export function createDeterministicWooshTransport(
  engineTag = 'woosh',
): DeterministicWooshTransport {
  const submissions: RecordedWooshSubmission[] = [];
  const byTaskId = new Map<string, Readonly<Record<string, unknown>>>();
  let shape: SimulatedAudioShape = 'one_shot';
  let submitFailure: { httpStatus: number; times: number } | null = null;
  let counter = 0;

  const payloadOf = (taskId: string): Readonly<Record<string, unknown>> => {
    const payload = byTaskId.get(taskId);
    if (payload === undefined) throw new Error(`unknown woosh task ${taskId}`);
    return payload;
  };

  // Memoised, not for speed alone: a caller that asks twice must get the *same* buffer, which is
  // the simulator's whole contract. Synthesis is a pure function of the payload, so caching cannot
  // change an answer — it only stops a 10-second buffer being rebuilt on every read.
  const pcmCache = new Map<string, PcmAudio>();

  const pcmFor = (taskId: string): PcmAudio => {
    const cached = pcmCache.get(taskId);
    if (cached !== undefined) return cached;
    const built = buildPcm(taskId);
    pcmCache.set(taskId, built);
    return built;
  };

  const buildPcm = (taskId: string): PcmAudio => {
    const payload = payloadOf(taskId);
    const durationMs = numberField(payload, 'duration_seconds') * 1000;
    const hash = hashPayload(payload);
    // The tone frequency carries the payload hash, so two payloads differing in any field —
    // one step, 0.1 of guidance, one seed — produce audibly different audio.
    const frequencyHz = 120 + (hash % 1_600);
    return shape === 'loop'
      ? seamlessSfxLoop({ durationMs, frequencyHz })
      : decayingOneShot({ durationMs, frequencyHz });
  };

  return {
    submissions,
    seeds: () => submissions.map((entry) => numberField(entry.payload, 'seed')),
    pcmFor,
    alignmentScoreFor(taskId) {
      // A uniform-ish value in [0, 1), spread finely enough that two variants of one request
      // are almost never inside Requirement 22.6's 0.001 tie window by accident.
      return (hashPayload(payloadOf(taskId)) % 1_000_003) / 1_000_003;
    },
    setAudioShape(next) {
      shape = next;
    },
    failSubmit(httpStatus, times = 1) {
      submitFailure = { httpStatus, times };
    },

    async postJson(request: WooshJsonRequest): Promise<WooshJsonResponse> {
      if (request.path === WOOSH_PATHS.health) {
        return { httpStatus: 200, envelope: { code: 200, data: { status: 'ok' } } };
      }

      if (request.path === WOOSH_PATHS.submit) {
        if (submitFailure !== null && submitFailure.times > 0) {
          submitFailure.times -= 1;
          return { httpStatus: submitFailure.httpStatus, envelope: { code: submitFailure.httpStatus } };
        }
        counter += 1;
        const taskId = `${engineTag}-task-${String(counter)}`;
        byTaskId.set(taskId, request.body);
        submissions.push({ taskId, payload: request.body });
        return { httpStatus: 200, envelope: { code: 200, data: { task_id: taskId } } };
      }

      if (request.path === WOOSH_PATHS.status) {
        const requested = request.body.task_id_list;
        const taskId = Array.isArray(requested) ? String(requested[0]) : '';
        const payload = byTaskId.get(taskId);
        if (payload === undefined) {
          return { httpStatus: 200, envelope: { code: 200, data: { tasks: [] } } };
        }
        return {
          httpStatus: 200,
          envelope: {
            code: 200,
            data: {
              tasks: [
                {
                  task_id: taskId,
                  status: 1,
                  progress: 100,
                  samples: [
                    {
                      path: `/tmp/${taskId}.wav`,
                      seed: numberField(payload, 'seed'),
                      duration_ms: Math.round(numberField(payload, 'duration_seconds') * 1000),
                      alignment_score:
                        (hashPayload(payload) % 1_000_003) / 1_000_003,
                    },
                  ],
                },
              ],
            },
          },
        };
      }

      throw new Error(`unexpected woosh path ${request.path}`);
    },

    async getBinary(request: WooshBinaryRequest): Promise<WooshBinaryResponse> {
      // The bytes are a stand-in: nothing in this repository decodes audio, so the *decoded*
      // form is what the candidate port supplies (see `pcmFor`). What matters here is that the
      // adapter's download path is exercised and the bytes are a function of the task.
      const path = request.query.path ?? '';
      return { httpStatus: 200, body: Buffer.from(`woosh-audio:${path}`) };
    },
  };
}

function numberField(payload: Readonly<Record<string, unknown>>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`woosh payload field ${field} is not a finite number`);
  }
  return value;
}

/** FNV-1a over the payload's canonical JSON. Deterministic across runs and platforms. */
function hashPayload(payload: Readonly<Record<string, unknown>>): number {
  const text = JSON.stringify(
    Object.fromEntries(Object.entries(payload).sort(([first], [second]) => (first < second ? -1 : 1))),
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
