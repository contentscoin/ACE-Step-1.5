/**
 * The two TTS deployments, simulated in memory (Requirement 25; design §3.1).
 *
 * **No TTS service is reachable from this environment**, so this is what the two adapters are
 * exercised against. Each simulator is deliberately a *deterministic function of the wire payload*
 * rather than a stub returning canned bytes, for the reason
 * `deterministic-woosh-transport.ts` states: Requirement 25.18's "the same seed, script, profile,
 * engine, rate and pitch produce sample-identical audio" is only checkable against an engine that
 * is itself a function of those fields. A stub returning the same fixed buffer every time would
 * make the property pass without evidence.
 *
 * The determinism is arithmetic, not luck: the payload is hashed with FNV-1a and the hash seeds the
 * synthesised tone. Nothing here reads a clock, a random source or a file.
 *
 * **Two simulators, not one.** Engine A's envelope is `{ code, data }` with numeric states; engine
 * B's is a flat body with string states and a `outputs[]` list. They are separate functions here
 * because they are separate protocols in `adapters/tts/`, and a shared simulator would let an
 * adapter bug that assumed the other engine's shape go unnoticed.
 *
 * ### The audio the simulators produce
 *
 * A line's duration is proportional to its character count and inversely proportional to the
 * speaking rate — which is what makes Requirement 25.16's re-timing observable: re-synthesising a
 * line with different text genuinely changes its length, so the delta the service adds is a real
 * number rather than zero. The tone frequency carries the payload hash, so two payloads differing
 * in any field — one character, one semitone, one seed — produce audibly different samples.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import { TTS_A_PATHS } from '../../adapters/tts/tts-engine-a-adapter';
import { TTS_B_PATHS } from '../../adapters/tts/tts-engine-b-adapter';
import type {
  TtsBinaryRequest,
  TtsBinaryResponse,
  TtsJsonRequest,
  TtsJsonResponse,
  TtsTransport,
} from '../../adapters/tts/transport';

import { monoAudio, sine, TEST_SAMPLE_RATE } from './pcm-synthesis';

/**
 * Milliseconds of speech per script character at 1.0×.
 *
 * 40 ms is around 25 characters per second — faster than a person, but the point is that the
 * mapping is monotone in the character count, not that it is realistic. Slow enough that a
 * one-character line still yields audio longer than the 50 ms cross-fade, which keeps the seam
 * arithmetic of `crossfadeJoin` out of its clamping branch for ordinary fixtures.
 */
export const SIMULATED_MS_PER_CHARACTER = 40;

/** Trailing silence the simulators append, milliseconds. */
const SIMULATED_TAIL_SILENCE_MS = 10;

export interface RecordedTtsSubmission {
  readonly taskId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DeterministicTtsTransport extends TtsTransport {
  /** Every submission, in order, exactly as it went on the wire. */
  readonly submissions: readonly RecordedTtsSubmission[];
  /** Deterministic PCM for a task, derived from its payload. */
  pcmFor(taskId: string): PcmAudio;
  /** Trailing silence the simulated engine appends, so a test can vary 25.19's input. */
  setTailSilenceMs(ms: number): void;
  /** Make the next `n` submissions answer with the given HTTP status. */
  failSubmit(httpStatus: number, times?: number): void;
  /** Make status routes answer that the task failed. */
  failTask(times?: number): void;
}

interface SimulatorOptions {
  readonly sampleRate?: number;
}

/* ----------------------------------------------------------------- engine A */

/** Engine A: `{ code, data }` envelope, numeric states, one `audio_url`. */
export function createDeterministicTtsATransport(
  options: SimulatorOptions = {},
): DeterministicTtsTransport {
  const state = createSimulatorState('tts-a', options);

  return {
    submissions: state.submissions,
    pcmFor: state.pcmFor,
    setTailSilenceMs: state.setTailSilenceMs,
    failSubmit: state.failSubmit,
    failTask: state.failTask,

    async requestJson(request: TtsJsonRequest): Promise<TtsJsonResponse> {
      if (request.path === TTS_A_PATHS.health) {
        return { httpStatus: 200, body: { code: 200, data: { status: 'ok' } } };
      }

      if (request.path === TTS_A_PATHS.submit || request.path === TTS_A_PATHS.convert) {
        const failure = state.consumeSubmitFailure();
        if (failure !== null) return { httpStatus: failure, body: { code: failure } };
        const taskId = state.accept(request.body ?? {});
        return { httpStatus: 200, body: { code: 200, data: { task_id: taskId } } };
      }

      if (request.path === TTS_A_PATHS.status) {
        const taskId = request.query?.task_id ?? '';
        const payload = state.payloadOf(taskId);
        if (payload === undefined) return { httpStatus: 200, body: { code: 200, data: null } };
        if (state.consumeTaskFailure()) {
          return {
            httpStatus: 200,
            body: { code: 200, data: { state: 2, progress: 0, error: 'simulated failure' } },
          };
        }
        return {
          httpStatus: 200,
          body: {
            code: 200,
            data: {
              state: 1,
              progress: 100,
              audio_url: `mem://${taskId}.wav`,
              sample_rate: state.sampleRate,
              duration_ms: state.durationMsFor(taskId),
              seed: numberField(payload, 'seed'),
            },
          },
        };
      }

      if (request.path === `${TTS_A_PATHS.status}/cancel`) {
        return { httpStatus: 200, body: { code: 200, data: { cancelled: true } } };
      }

      throw new Error(`unexpected engine A path ${request.path}`);
    },

    async requestBinary(request: TtsBinaryRequest): Promise<TtsBinaryResponse> {
      // The bytes are a stand-in: nothing in this repository decodes audio, so the *decoded* form
      // is what `SpeechSynthesisPort` supplies (see `pcmFor`). What matters here is that the
      // adapter's download path is exercised and the bytes are a function of the task.
      return {
        httpStatus: 200,
        body: Buffer.from(`tts-a-audio:${request.query?.url ?? ''}`),
      };
    },
  };
}

/* ----------------------------------------------------------------- engine B */

/** Engine B: flat body, string states, `outputs[]`, 404 for an unknown job. */
export function createDeterministicTtsBTransport(
  options: SimulatorOptions = {},
): DeterministicTtsTransport {
  const state = createSimulatorState('tts-b', options);

  return {
    submissions: state.submissions,
    pcmFor: state.pcmFor,
    setTailSilenceMs: state.setTailSilenceMs,
    failSubmit: state.failSubmit,
    failTask: state.failTask,

    async requestJson(request: TtsJsonRequest): Promise<TtsJsonResponse> {
      if (request.path === TTS_B_PATHS.health) {
        return { httpStatus: 200, body: { ready: true } };
      }

      if (request.path === TTS_B_PATHS.synthesise || request.path === TTS_B_PATHS.convert) {
        const failure = state.consumeSubmitFailure();
        if (failure !== null) return { httpStatus: failure, body: { error: 'rejected' } };
        const id = state.accept(request.body ?? {});
        return { httpStatus: 202, body: { id, status: 'queued' } };
      }

      if (request.path.startsWith(`${TTS_B_PATHS.job}/`)) {
        const id = request.path.slice(TTS_B_PATHS.job.length + 1);
        const payload = state.payloadOf(id);
        if (payload === undefined) return { httpStatus: 404, body: { error: 'not found' } };
        if (state.consumeTaskFailure()) {
          return {
            httpStatus: 200,
            body: { id, status: 'failed', percent_complete: 0, failure: 'simulated failure' },
          };
        }
        return {
          httpStatus: 200,
          body: {
            id,
            status: 'succeeded',
            percent_complete: 100,
            outputs: [
              {
                path: `/mem/${id}.wav`,
                sample_rate_hz: state.sampleRate,
                duration_seconds: state.durationMsFor(id) / 1000,
                random_seed: numberField(payload, 'random_seed'),
              },
            ],
          },
        };
      }

      throw new Error(`unexpected engine B path ${request.path}`);
    },

    async requestBinary(request: TtsBinaryRequest): Promise<TtsBinaryResponse> {
      return {
        httpStatus: 200,
        body: Buffer.from(`tts-b-audio:${request.query?.file ?? ''}`),
      };
    },
  };
}

/* -------------------------------------------------------------------- shared */

interface SimulatorState {
  readonly submissions: RecordedTtsSubmission[];
  readonly sampleRate: number;
  accept(payload: Readonly<Record<string, unknown>>): string;
  payloadOf(taskId: string): Readonly<Record<string, unknown>> | undefined;
  pcmFor(taskId: string): PcmAudio;
  durationMsFor(taskId: string): number;
  setTailSilenceMs(ms: number): void;
  failSubmit(httpStatus: number, times?: number): void;
  failTask(times?: number): void;
  consumeSubmitFailure(): number | null;
  consumeTaskFailure(): boolean;
}

function createSimulatorState(tag: string, options: SimulatorOptions): SimulatorState {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const submissions: RecordedTtsSubmission[] = [];
  const byTaskId = new Map<string, Readonly<Record<string, unknown>>>();
  const pcmCache = new Map<string, PcmAudio>();
  let tailSilenceMs = SIMULATED_TAIL_SILENCE_MS;
  let submitFailure: { httpStatus: number; times: number } | null = null;
  let taskFailure = 0;
  let counter = 0;

  const utteranceOf = (payload: Readonly<Record<string, unknown>>): string => {
    // A conversion payload carries no text; its length is the source's, which the
    // `VoiceConversionPort` fake derives, so any non-empty stand-in does here.
    const text = payload.text ?? payload.utterance ?? payload.source_ref ?? payload.source;
    return typeof text === 'string' ? text : '';
  };

  const rateOf = (payload: Readonly<Record<string, unknown>>): number => {
    // Engine A sends a multiplier, engine B a percentage. Both are read, because the simulator has
    // to make the *same* line at the *same* rate come out the same length whichever engine it went
    // to — otherwise a test comparing the two would be comparing the simulators.
    const speed = payload.speed;
    if (typeof speed === 'number' && speed > 0) return speed;
    const percent = payload.rate_percent;
    if (typeof percent === 'number' && percent > 0) return percent / 100;
    return 1;
  };

  const durationMsFor = (taskId: string): number => {
    const payload = byTaskId.get(taskId);
    if (payload === undefined) return 0;
    const characters = Math.max(1, utteranceOf(payload).length);
    const spoken = (characters * SIMULATED_MS_PER_CHARACTER) / rateOf(payload);
    return Math.max(1, Math.round(spoken + tailSilenceMs));
  };

  const buildPcm = (taskId: string): PcmAudio => {
    const payload = byTaskId.get(taskId);
    if (payload === undefined) throw new Error(`unknown ${tag} task ${taskId}`);
    const durationMs = durationMsFor(taskId);
    const spokenMs = Math.max(1, durationMs - tailSilenceMs);
    const totalFrames = Math.max(1, Math.round((durationMs * sampleRate) / 1000));
    const spokenFrames = Math.min(
      totalFrames,
      Math.max(1, Math.round((spokenMs * sampleRate) / 1000)),
    );

    const hash = hashPayload(payload);
    const frequencyHz = 90 + (hash % 400);
    const tone = sine(frequencyHz, spokenFrames, 0.6, sampleRate);
    const samples = new Float32Array(totalFrames);
    samples.set(tone, 0);
    // The remainder is exact zero, which is Requirement 25.19's silence at any floor.
    return monoAudio(samples, sampleRate);
  };

  return {
    submissions,
    sampleRate,
    accept(payload) {
      counter += 1;
      const taskId = `${tag}-task-${String(counter)}`;
      byTaskId.set(taskId, payload);
      submissions.push({ taskId, payload });
      return taskId;
    },
    payloadOf: (taskId) => byTaskId.get(taskId),
    pcmFor(taskId) {
      // Memoised: a caller that asks twice must get the *same* buffer, which is the simulator's
      // whole contract. Synthesis is a pure function of the payload, so caching cannot change an
      // answer.
      const cached = pcmCache.get(taskId);
      if (cached !== undefined) return cached;
      const built = buildPcm(taskId);
      pcmCache.set(taskId, built);
      return built;
    },
    durationMsFor,
    setTailSilenceMs(ms) {
      tailSilenceMs = ms;
      pcmCache.clear();
    },
    failSubmit(httpStatus, times = 1) {
      submitFailure = { httpStatus, times };
    },
    failTask(times = 1) {
      taskFailure = times;
    },
    consumeSubmitFailure() {
      if (submitFailure === null || submitFailure.times <= 0) return null;
      submitFailure.times -= 1;
      return submitFailure.httpStatus;
    },
    consumeTaskFailure() {
      if (taskFailure <= 0) return false;
      taskFailure -= 1;
      return true;
    },
  };
}

function numberField(payload: Readonly<Record<string, unknown>>, field: string): number {
  const value = payload[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** FNV-1a over the payload's canonical JSON. Deterministic across runs and platforms. */
function hashPayload(payload: Readonly<Record<string, unknown>>): number {
  const text = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([first], [second]) => (first < second ? -1 : 1)),
    ),
  );
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
